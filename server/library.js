import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JsonStore, naturalCompare } from './store.js';
import { probeFile } from './probe.js';
import { readNfo, writeNfo } from './nfo.js';

export const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.flv',
  '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.3gp', '.ogv',
]);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const FOLDER_IMAGES = ['poster', 'folder', 'cover', 'thumb'];
// 動画の隣に置かれた画像（旧形式）: "動画名-landscape.jpg" など
const ITEM_IMAGE_SUFFIXES = ['-landscape', '', '-thumb', '-poster', '-fanart'];
// 動画フォルダ内の付属ファイル用フォルダ: .thumbs/動画名.jpg, .nfo/動画名.nfo, .trickplay/動画名.trickplay/
export const SIDE_DIRS = { thumbs: '.thumbs', nfo: '.nfo', trickplay: '.trickplay' };
// フォルダの画像を配下の作品から選んだときの保存先: .thumbs/.folder.jpg（poster.jpg などより優先）
export const FOLDER_THUMB = '.folder.jpg';
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
    // 同じ女優の名義のグループ（[['御前珠里', '三崎あかり'], ...]）。index.js が aliases.json から設定する
    this.aliasGroups = [];
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
    const dirs = new Map(entries.filter((e) => e.isDirectory()).map((e) => [e.name.toLowerCase(), e.name]));
    const side = await readSideDirs(dir, dirs);
    const custom = side.thumbs.files.get(FOLDER_THUMB);
    folder.customPoster = !!custom;
    folder.poster = custom ? path.join(side.thumbs.dir, custom) : findImage(dir, files, FOLDER_IMAGES);
    for (const n of ['tvshow.nfo', 'season.nfo']) {
      const f = sideOrLocal(dir, n, side.nfo, files);
      if (f && (folder.nfo = await readNfo(f, dir))) break;
    }
    if (!folder.poster && folder.nfo?.thumb) folder.poster = folder.nfo.thumb;
    // 画像の版（変えたら URL が変わり、ブラウザのキャッシュを使わない）
    folder.posterV = folder.poster ? Math.round((await fs.stat(folder.poster).catch(() => null))?.mtimeMs || 0) : 0;
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
    const movieNfo = videos.length === 1 ? sideOrLocal(dir, 'movie.nfo', side.nfo, files) : null;
    const items = [];
    for (const name of videos) {
      const item = await this.buildItem(dir, name, { files, dirs, side }, lib, folder.id, movieNfo);
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

  async buildItem(dir, name, { files, dirs, side }, lib, folderId, movieNfo) {
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

    const nfoFile = sideOrLocal(dir, base + '.nfo', side.nfo, files) || movieNfo;
    const nfo = nfoFile ? await readNfo(nfoFile, dir) : null;

    // サムネイル: .thumbs/動画名.jpg → 隣の画像（旧形式） → NFO の画像
    const sideImage = findImage(side.thumbs.dir, side.thumbs.files, [base]);
    const image = sideImage || findImage(dir, files, ITEM_IMAGE_SUFFIXES.map((s) => base + s)) || nfo?.thumb || null;
    let imageMtime = 0;
    if (image) {
      try {
        imageMtime = (await fs.stat(image)).mtimeMs;
      } catch {}
    }

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
      image,
      imageMtime,
      nfoPath: nfoFile,
      // .thumbs に置かれた画像か（画面から設定・削除できるのはこちらだけ）
      sideImage: !!sideImage,
      thumbsDir: path.join(dir, SIDE_DIRS.thumbs),
      base,
      trickplay: sideOrLocal(dir, base + '.trickplay', side.trickplay, dirs),
      subs,
      nfo,
      probe: same && prev.probe && !prev.probe.failed ? prev.probe : null,
    };
  }

  /**
   * 画面で編集したメタデータを .nfo/動画名.nfo に保存する。
   * 別の場所の NFO（動画の隣の 動画名.nfo や movie.nfo）を使っていた場合は、その内容をもとに作る。
   * 動画の隣の 動画名.nfo は .nfo に移したことになるので削除する（movie.nfo は他の用途もあるので残す）。
   */
  async saveNfo(it, fields) {
    const dir = path.dirname(it.path);
    const file = path.join(dir, SIDE_DIRS.nfo, `${it.base}.nfo`);
    const old = it.nfoPath && path.resolve(it.nfoPath).toLowerCase() !== path.resolve(file).toLowerCase() ? it.nfoPath : null;
    await writeNfo(file, fields, { seed: old });
    if (old && path.basename(old).toLowerCase() === `${it.base}.nfo`.toLowerCase()) await fs.rm(old, { force: true });
    it.nfoPath = file;
    it.nfo = await readNfo(file, dir);
    it.name = it.nfo?.title || it.base;
    if (!it.sideImage && it.nfo?.thumb && !it.image) it.image = it.nfo.thumb;
    return file;
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
    const people = [...this.people().values()].filter((p) => match(...p.names)).slice(0, limit);
    people.sort((a, b) => b.items.length - a.items.length || naturalCompare(a.name, b.name));
    return { folders, items, people };
  }

  /**
   * 出演者（NFO の <actor>）の一覧: 代表名 -> { name, names: [代表名, 別名...], items: [動画 id], credits: { 動画 id: その作品の名義 }, thumb, birthdate }。
   * 別名のグループ（aliasGroups）にある名義は 1 人にまとめ、作品数がいちばん多い名義を代表名にする。
   * メタデータの編集でも変わるので、キャッシュせず毎回動画から集める。
   * 戻り値の aliasIndex（名義 -> 代表名）で、別名からも引ける
   */
  people() {
    const byName = new Map();
    for (const it of this.items.values()) {
      for (const name of it.nfo?.actors || []) {
        let p = byName.get(name);
        if (!p) byName.set(name, (p = { name, items: [], thumb: null, birthdate: null }));
        p.items.push(it.id);
        p.thumb ||= it.nfo.actorThumbs?.[name] || null;
        p.birthdate ||= it.nfo.actorBirthdates?.[name] || null;
      }
    }
    const map = new Map();
    const aliasIndex = new Map();
    const grouped = new Set();
    for (const group of this.aliasGroups) {
      const present = group.filter((n) => byName.has(n));
      if (!present.length) continue;
      present.sort((a, b) => byName.get(b).items.length - byName.get(a).items.length || naturalCompare(a, b));
      const name = present[0];
      const p = { name, names: [name, ...group.filter((n) => n !== name)], items: [], credits: {}, thumb: null, birthdate: null };
      for (const n of present) {
        const q = byName.get(n);
        for (const id of q.items) {
          if (p.credits[id]) continue;
          p.items.push(id);
          p.credits[id] = n;
        }
        p.thumb ||= q.thumb;
        p.birthdate ||= q.birthdate;
        grouped.add(n);
      }
      map.set(name, p);
      for (const n of group) aliasIndex.set(n, name);
    }
    for (const [n, q] of byName) {
      if (grouped.has(n)) continue;
      map.set(n, { ...q, names: [n], credits: Object.fromEntries(q.items.map((id) => [id, n])) });
      aliasIndex.set(n, n);
    }
    map.aliasIndex = aliasIndex;
    return map;
  }

  /** 名義（別名も可）からその女優を返す（出演作が無ければ undefined） */
  personOf(name) {
    const map = this.people();
    return map.get(map.aliasIndex.get(name) ?? name);
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

/** .thumbs / .nfo / .trickplay の中身を読む（無ければ空） */
async function readSideDirs(dir, dirs) {
  const out = {};
  for (const [key, name] of Object.entries(SIDE_DIRS)) {
    const real = dirs.get(name);
    const sdir = path.join(dir, real || name);
    let entries = [];
    if (real) {
      try {
        entries = await fs.readdir(sdir, { withFileTypes: true });
      } catch {}
    }
    const want = key === 'trickplay' ? (e) => e.isDirectory() : (e) => e.isFile();
    out[key] = { dir: sdir, files: new Map(entries.filter(want).map((e) => [e.name.toLowerCase(), e.name])) };
  }
  return out;
}

/** 付属フォルダ内 → 動画と同じフォルダ（旧形式）の順で探してフルパスを返す */
function sideOrLocal(dir, name, side, local) {
  const lower = name.toLowerCase();
  if (side.files.has(lower)) return path.join(side.dir, side.files.get(lower));
  if (local.has(lower)) return path.join(dir, local.get(lower));
  return null;
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
