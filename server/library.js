import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore, naturalCompare } from './store.js';
import { probeFile } from './probe.js';
import { readNfo } from './nfo.js';

export const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv',
  '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.3gp', '.ogv',
]);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const FOLDER_IMAGES = ['poster', 'folder', 'cover', 'thumb'];
const ITEM_IMAGE_SUFFIXES = ['', '-poster', '-thumb', '-fanart'];
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.trash']);

export const hashId = (s) => crypto.createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 16);

export class Library {
  constructor(config) {
    this.config = config;
    // 追加日時・ffprobe 結果を永続化（再スキャン時に再利用）
    this.index = new JsonStore('index.json', { items: {} }, { delay: 5000 });
    this.folders = new Map();
    this.items = new Map();
    this.roots = [];
    this.scanning = false;
    this.pendingScan = false;
    this.probeQueue = new Set();
    this.probing = 0;
    this.probeJobs = new Map();
    this.watchers = [];
    this.watchKey = '';
    this.rescanTimer = null;
  }

  async scanAll() {
    if (this.scanning) {
      this.pendingScan = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.pendingScan = false;
        const started = Date.now();
        const out = { folders: new Map(), items: new Map() };
        const roots = [];
        for (const lib of this.config.data.libraries) {
          const root = await this.scanDir(lib.path, lib, null, out);
          roots.push(root.id);
        }
        this.folders = out.folders;
        this.items = out.items;
        this.roots = roots;
        this.persistAll();
        console.log(`スキャン完了: ${this.items.size} 本 / ${this.folders.size} フォルダ (${Date.now() - started}ms)`);
        this.queueProbes();
      } while (this.pendingScan);
    } catch (e) {
      console.error('スキャンエラー:', e);
    } finally {
      this.scanning = false;
    }
    this.setupWatchers();
  }

  async scanDir(dir, lib, parentId, out) {
    const folder = {
      id: hashId(lib.id + '|' + dir),
      libId: lib.id,
      path: dir,
      name: parentId ? path.basename(dir) : lib.name,
      dirName: path.basename(dir),
      parentId,
      folders: [],
      items: [],
      poster: null,
      nfo: null,
      count: 0,
    };
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {}

    const files = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
    folder.poster = findImage(dir, files, FOLDER_IMAGES);
    for (const n of ['tvshow.nfo', 'season.nfo']) {
      if (files.has(n) && (folder.nfo = await readNfo(path.join(dir, files.get(n))))) break;
    }
    if (!folder.poster && folder.nfo?.thumb) folder.poster = folder.nfo.thumb;
    if (parentId && folder.nfo?.title) folder.name = folder.nfo.title;

    const subdirs = [];
    const videos = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) subdirs.push(e.name);
      } else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
        videos.push(e.name);
      }
    }
    subdirs.sort(naturalCompare);
    videos.sort(naturalCompare);

    const subs = [];
    for (const name of subdirs) {
      const sub = await this.scanDir(path.join(dir, name), lib, folder.id, out);
      if (sub.count > 0) subs.push(sub);
    }
    // NFO の sorttitle があればそれで並べる
    subs.sort((a, b) => naturalCompare(a.nfo?.sortTitle || a.dirName, b.nfo?.sortTitle || b.dirName));
    for (const sub of subs) {
      folder.folders.push(sub.id);
      folder.count += sub.count;
    }
    // movie.nfo はフォルダに動画が 1 本だけのときその動画の NFO とみなす
    const movieNfo = videos.length === 1 && files.has('movie.nfo') ? path.join(dir, files.get('movie.nfo')) : null;
    const items = [];
    for (const name of videos) {
      const item = await this.buildItem(dir, name, files, lib, folder.id, movieNfo);
      if (item) items.push(item);
    }
    items.sort(compareItems);
    for (const item of items) {
      out.items.set(item.id, item);
      folder.items.push(item.id);
      folder.count++;
    }
    out.folders.set(folder.id, folder);
    return folder;
  }

  async buildItem(dir, name, files, lib, folderId, movieNfo) {
    const file = path.join(dir, name);
    let st;
    try {
      st = await fs.stat(file);
    } catch {
      return null;
    }
    const id = hashId(file);
    const ext = path.extname(name).toLowerCase();
    const base = name.slice(0, -ext.length);
    const prev = this.index.data.items[id];
    const same = prev && prev.size === st.size && prev.mtime === st.mtimeMs;

    // 同名の字幕ファイル: "動画名.srt" / "動画名.ja.srt" など
    const lowerBase = base.toLowerCase();
    const subs = [];
    for (const [lower, real] of files) {
      const sext = path.extname(lower);
      if (!SUB_EXT.has(sext) || !lower.startsWith(lowerBase + '.')) continue;
      const lang = lower.slice(lowerBase.length + 1, -sext.length);
      subs.push({ path: path.join(dir, real), lang, ext: sext.slice(1) });
    }
    subs.sort((a, b) => naturalCompare(a.lang, b.lang));

    const nfoFile = files.get(lowerBase + '.nfo');
    const nfo = nfoFile ? await readNfo(path.join(dir, nfoFile)) : movieNfo ? await readNfo(movieNfo) : null;

    return {
      id,
      libId: lib.id,
      folderId,
      path: file,
      name: nfo?.title || base,
      file: name,
      ext,
      size: st.size,
      mtime: st.mtimeMs,
      added: prev?.added ?? (st.birthtimeMs || st.mtimeMs),
      image: findImage(dir, files, ITEM_IMAGE_SUFFIXES.map((s) => base + s)) || nfo?.thumb || null,
      subs,
      nfo,
      probe: same && prev.probe && !prev.probe.failed ? prev.probe : null,
    };
  }

  persistItem(it) {
    this.index.data.items[it.id] = { added: it.added, size: it.size, mtime: it.mtime, probe: it.probe };
    this.index.save();
  }

  persistAll() {
    const items = {};
    for (const it of this.items.values()) {
      items[it.id] = { added: it.added, size: it.size, mtime: it.mtime, probe: it.probe };
    }
    this.index.data.items = items;
    this.index.save();
  }

  /** 未解析のアイテムをバックグラウンドで ffprobe する */
  queueProbes() {
    for (const it of this.items.values()) if (!it.probe) this.probeQueue.add(it.id);
    this.pumpProbes();
  }

  pumpProbes() {
    while (this.probing < 2 && this.probeQueue.size) {
      const id = this.probeQueue.values().next().value;
      this.probeQueue.delete(id);
      const it = this.items.get(id);
      if (!it || it.probe) continue;
      this.probing++;
      this.ensureProbe(it)
        .catch(() => {})
        .finally(() => {
          this.probing--;
          this.pumpProbes();
        });
    }
  }

  /** 解析済みならその結果、未解析（または前回失敗）なら ffprobe を実行 */
  ensureProbe(it) {
    if (it.probe && !it.probe.failed) return Promise.resolve(it.probe);
    if (this.probeJobs.has(it.id)) return this.probeJobs.get(it.id);
    const job = probeFile(this.config.data.ffprobePath, it.path)
      .then(
        (probe) => {
          it.probe = probe;
          this.persistItem(it);
          return probe;
        },
        (err) => {
          it.probe = { failed: true, duration: 0, start: 0, video: null, audio: [], subs: [] };
          this.persistItem(it);
          throw new Error(`メディア情報を取得できません: ${err.message}`);
        },
      )
      .finally(() => this.probeJobs.delete(it.id));
    this.probeJobs.set(it.id, job);
    return job;
  }

  /** ライブラリフォルダの変更を監視して自動で再スキャン */
  setupWatchers() {
    const libs = this.config.data.libraries;
    const key = libs.map((l) => l.path).join('|');
    if (key === this.watchKey) return;
    this.watchKey = key;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const lib of libs) {
      try {
        const w = fss.watch(lib.path, { recursive: true }, () => {
          clearTimeout(this.rescanTimer);
          this.rescanTimer = setTimeout(() => this.scanAll(), 5000);
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch (e) {
        console.warn(`フォルダを監視できません: ${lib.path} (${e.message})`);
      }
    }
  }

  firstItem(folder) {
    if (folder.items.length) return this.items.get(folder.items[0]);
    for (const fid of folder.folders) {
      const it = this.firstItem(this.folders.get(fid));
      if (it) return it;
    }
    return null;
  }

  breadcrumbs(folder) {
    const out = [];
    for (let f = folder; f; f = this.folders.get(f.parentId)) out.unshift({ id: f.id, name: f.name });
    return out;
  }

  search(q, limit = 100) {
    const needle = q.normalize('NFKC').toLowerCase();
    const match = (...names) => names.some((n) => n && n.normalize('NFKC').toLowerCase().includes(needle));
    const folders = [];
    const items = [];
    for (const f of this.folders.values()) if (f.parentId && match(f.name, f.nfo?.title, f.nfo?.originalTitle) && folders.length < limit) folders.push(f);
    for (const it of this.items.values()) if (match(it.name, it.file, it.nfo?.originalTitle) && items.length < limit) items.push(it);
    folders.sort((a, b) => naturalCompare(a.name, b.name));
    items.sort((a, b) => naturalCompare(a.name, b.name));
    return { folders, items };
  }
}

// NFO に話数があれば シーズン → 話数 の順、なければファイル名順
function compareItems(a, b) {
  const ea = a.nfo?.episode ?? Infinity;
  const eb = b.nfo?.episode ?? Infinity;
  if (ea !== Infinity || eb !== Infinity) {
    const sa = a.nfo?.season ?? 0;
    const sb = b.nfo?.season ?? 0;
    if (sa !== sb) return sa - sb;
    if (ea !== eb) return ea - eb;
  }
  return naturalCompare(a.file, b.file);
}

function findImage(dir, files, bases) {
  for (const b of bases) {
    for (const ext of IMAGE_EXT) {
      const real = files.get((b + ext).toLowerCase());
      if (real) return path.join(dir, real);
    }
  }
  return null;
}
