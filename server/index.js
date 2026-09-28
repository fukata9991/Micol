import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { JsonStore, HttpError, ROOT } from './store.js';
import { Library } from './library.js';
import { Media } from './media.js';

function gitVersion() {
  try {
    return execFileSync('git', ['log', '-1', '--format=%h (%cd)', '--date=format:%Y-%m-%d %H:%M'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'unknown';
  }
}
const VERSION = gitVersion();

const DEFAULT_TRANSCODE = { videoEncoder: 'libx264', preset: 'veryfast', quality: 23, maxHeight: 1080, audioBitrate: '192k' };
const DEFAULT_UPDATE = { enabled: true, intervalMinutes: 5 };
const config = new JsonStore('config.json', {
  port: 8420,
  host: '0.0.0.0',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  // false の場合、設定の変更はサーバー PC 自身（localhost）からのみ許可
  allowRemoteAdmin: false,
  // git リポジトリの自動更新（service/supervisor.js 経由で起動したときに有効）
  autoUpdate: DEFAULT_UPDATE,
  libraries: [],
  transcode: DEFAULT_TRANSCODE,
}, { pretty: true });
config.data.transcode = { ...DEFAULT_TRANSCODE, ...config.data.transcode };
config.data.autoUpdate = { ...DEFAULT_UPDATE, ...config.data.autoUpdate };
config.save(true);

// 視聴位置: { [itemId]: { position, duration, watched, updated } }
const progress = new JsonStore('progress.json', {});
const library = new Library(config);
const media = new Media(config, library);

// ---------- DTO ----------

function itemDto(it) {
  const p = progress.data[it.id];
  return {
    id: it.id,
    name: it.name,
    file: it.file,
    thumb: media.thumbVersion(it),
    season: it.nfo?.season ?? null,
    episode: it.nfo?.episode ?? null,
    year: it.nfo?.year ?? null,
    folderId: it.folderId,
    size: it.size,
    added: it.added,
    duration: it.probe?.duration || 0,
    width: it.probe?.video?.width || 0,
    height: it.probe?.video?.height || 0,
    position: p?.position || 0,
    watched: !!p?.watched,
  };
}

const folderDto = (f) => ({ id: f.id, name: f.name, count: f.count, year: f.nfo?.year ?? null });

function getItem(id) {
  const it = library.items.get(id);
  if (!it) throw new HttpError(404, 'アイテムが見つかりません');
  return it;
}

function getFolder(id) {
  const f = library.folders.get(id);
  if (!f) throw new HttpError(404, 'フォルダが見つかりません');
  return f;
}

// ---------- ルーティング ----------

const routes = [];
function route(method, pattern, handler, admin = false) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler, admin });
}

route('GET', '/api/home', () => {
  const all = [...library.items.values()];
  const resume = all
    .filter((it) => (progress.data[it.id]?.position || 0) >= 10)
    .sort((a, b) => progress.data[b.id].updated - progress.data[a.id].updated)
    .slice(0, 20)
    .map(itemDto);
  const recent = all.sort((a, b) => b.added - a.added).slice(0, 30).map(itemDto);
  return {
    libraries: library.roots.map((id) => folderDto(library.folders.get(id))),
    resume,
    recent,
    scanning: library.scanning,
  };
});

route('GET', '/api/folders/:id', ({ params }) => {
  const f = getFolder(params.id);
  return {
    folder: { id: f.id, name: f.name, parentId: f.parentId, nfo: f.nfo || null },
    breadcrumbs: library.breadcrumbs(f),
    folders: f.folders.map((id) => folderDto(library.folders.get(id))),
    items: f.items.map((id) => itemDto(library.items.get(id))),
    scanning: library.scanning,
  };
});

route('GET', '/api/folders/:id/thumb', async ({ res, params }) => {
  const f = getFolder(params.id);
  if (f.poster) return media.sendImage(res, f.poster, 300);
  const it = library.firstItem(f);
  if (!it) throw new HttpError(404, 'サムネイルなし');
  media.sendImage(res, await media.itemThumb(it), 300);
});

route('GET', '/api/items/:id', async ({ params }) => {
  const it = getItem(params.id);
  const probe = await library.ensureProbe(it).catch(() => it.probe);
  const folder = library.folders.get(it.folderId);
  const siblings = folder?.items || [];
  const i = siblings.indexOf(it.id);
  const sibling = (j) => (siblings[j] ? itemDto(library.items.get(siblings[j])) : null);
  return {
    ...itemDto(it),
    path: it.path,
    container: it.ext.slice(1),
    nfo: it.nfo || null,
    customThumb: media.custom.has(it.id),
    video: probe?.video || null,
    audio: probe?.audio || [],
    subtitles: media.subtitleList(it),
    breadcrumbs: folder ? library.breadcrumbs(folder) : [],
    prev: i > 0 ? sibling(i - 1) : null,
    next: i >= 0 ? sibling(i + 1) : null,
  };
});

route('GET', '/api/items/:id/thumb', async ({ res, params, query }) => {
  // ?v= 付きの URL はサムネイルが変わると URL も変わるので長くキャッシュしてよい
  media.sendImage(res, await media.itemThumb(getItem(params.id)), query.has('v') ? 86400 * 30 : 60);
});

route('GET', '/api/items/:id/frame', ({ res, params, query }) => {
  media.frame(res, getItem(params.id), Number(query.get('t')) || 0);
});

// サムネイルの設定: JSON {t: 秒} なら動画のその場面、画像ファイルを送るとその画像を使う
route('PUT', '/api/items/:id/thumb', async ({ params, body }) => {
  const it = getItem(params.id);
  if (Buffer.isBuffer(body)) await media.setCustomThumb(it, { image: body });
  else if (Number.isFinite(Number(body.t))) await media.setCustomThumb(it, { t: Number(body.t) });
  else throw new HttpError(400, '場面 (t) か画像を指定してください');
  return { ok: true, thumb: media.thumbVersion(it) };
});

route('DELETE', '/api/items/:id/thumb', ({ params }) => {
  const it = getItem(params.id);
  media.clearCustomThumb(it);
  return { ok: true, thumb: media.thumbVersion(it) };
});

route('GET', '/api/items/:id/playback', async ({ params, query }) => {
  const it = getItem(params.id);
  const probe = await library.ensureProbe(it);
  const caps = (query.get('caps') || 'h264').split(',');
  const audio = query.get('audio') ? Number(query.get('audio')) : null;
  return { ...media.decide(it, probe, caps, audio, query.get('force') === '1'), duration: probe.duration };
});

route('GET', '/api/items/:id/keyframe', async ({ params, query }) => {
  const it = getItem(params.id);
  const probe = await library.ensureProbe(it);
  return { t: await media.keyframe(it, probe, Number(query.get('t')) || 0) };
});

route('GET', '/api/items/:id/stream', async ({ req, res, params, query }) => {
  const it = getItem(params.id);
  const mode = query.get('mode') || 'direct';
  if (mode === 'direct') return media.sendFile(req, res, it.path);
  const probe = await library.ensureProbe(it);
  media.stream(req, res, it, probe, {
    mode,
    t: Math.max(0, Number(query.get('t')) || 0),
    audio: query.get('audio') ? Number(query.get('audio')) : null,
  });
});

route('GET', '/api/items/:id/subs/:key', async ({ res, params }) => {
  const file = await media.subtitleVtt(getItem(params.id), params.key);
  res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'max-age=3600' });
  fs.createReadStream(file).pipe(res);
});

route('POST', '/api/items/:id/progress', ({ params, body }) => {
  const it = getItem(params.id);
  const duration = Number(body.duration) || it.probe?.duration || 0;
  const position = Math.max(0, Number(body.position) || 0);
  const prev = progress.data[it.id];
  const finished = duration > 0 && position / duration > 0.9;
  progress.data[it.id] = {
    position: finished ? 0 : position,
    duration,
    watched: finished || !!prev?.watched,
    updated: Date.now(),
  };
  progress.save();
  return { ok: true };
});

route('POST', '/api/items/:id/watched', ({ params, body }) => {
  const it = getItem(params.id);
  progress.data[it.id] = { position: 0, duration: it.probe?.duration || 0, watched: !!body.watched, updated: Date.now() };
  progress.save();
  return { ok: true };
});

route('GET', '/api/search', ({ query }) => {
  const q = (query.get('q') || '').trim();
  if (!q) return { folders: [], items: [] };
  const r = library.search(q);
  return { folders: r.folders.map(folderDto), items: r.items.map(itemDto) };
});

route('GET', '/api/status', () => ({
  version: VERSION,
  supervised: !!process.send,
  scanning: library.scanning,
  items: library.items.size,
  folders: library.folders.size,
  probePending: library.probeQueue.size + library.probing,
}));

route('POST', '/api/scan', () => {
  library.scanAll();
  return { ok: true };
}, true);

route('GET', '/api/settings', () => ({
  libraries: config.data.libraries,
  transcode: config.data.transcode,
  encoders: media.encoders,
}), true);

route('PUT', '/api/settings', ({ body }) => {
  if (Array.isArray(body.libraries)) {
    const libs = [];
    for (const l of body.libraries) {
      const raw = String(l.path || '').trim();
      const p = raw && path.resolve(raw);
      let st = null;
      try {
        st = p && fs.statSync(p);
      } catch {}
      if (!st?.isDirectory()) throw new HttpError(400, `フォルダが存在しません: ${raw}`);
      libs.push({
        id: l.id || crypto.randomUUID().slice(0, 8),
        name: String(l.name || '').trim() || path.basename(p) || p,
        path: p,
      });
    }
    config.data.libraries = libs;
  }
  if (body.transcode) {
    const t = body.transcode;
    const cur = config.data.transcode;
    config.data.transcode = {
      ...cur,
      videoEncoder: media.encoders.includes(t.videoEncoder) ? t.videoEncoder : cur.videoEncoder,
      quality: Math.min(40, Math.max(15, Number(t.quality) || cur.quality)),
      maxHeight: [480, 720, 1080, 1440, 2160].includes(Number(t.maxHeight)) ? Number(t.maxHeight) : cur.maxHeight,
    };
  }
  config.save(true);
  library.scanAll();
  return { ok: true, libraries: config.data.libraries, transcode: config.data.transcode };
}, true);

// フォルダ選択ダイアログ用（path 未指定ならドライブ一覧）
route('GET', '/api/fs', ({ query }) => {
  const p = query.get('path');
  if (!p) {
    const dirs = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      if (fs.existsSync(d)) dirs.push({ name: d, path: d });
    }
    return { path: '', parent: null, dirs };
  }
  const abs = path.resolve(p);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    throw new HttpError(400, `フォルダを開けません: ${e.message}`);
  }
  const dirs = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('$') && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, dirs };
}, true);

// ---------- サーバー ----------

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  // 画像のアップロードはバイナリのまま受け取る
  if (/^image\//.test(req.headers['content-type'] || '')) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 20 * 1024 * 1024) {
          reject(new HttpError(413, '画像が大きすぎます（20MB まで）'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new HttpError(413, 'リクエストが大きすぎます'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'JSON が不正です'));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const a = req.socket.remoteAddress;
  return config.data.allowRemoteAdmin || a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function serveStatic(req, res, pathname) {
  const file = path.join(PUBLIC, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let url, pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  }
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (!m) continue;
    try {
      if (r.admin && !isAdmin(req)) throw new HttpError(403, '設定はサーバー PC のブラウザ (localhost) からのみ変更できます');
      const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};
      const out = await r.handler({ req, res, params: m.groups || {}, query: url.searchParams, body });
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

const { port, host } = config.data;
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `ポート ${port} は使用中です。data/config.json の port を変更してください。` : e);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`\nMicol が起動しました  バージョン: ${VERSION}`);
  console.log(`  このPC : http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  LAN    : http://${a.address}:${port}`);
  }
  console.log('');
});

// 監視プロセス (service/supervisor.js) からの停止要求や Ctrl+C では、保存してから終了する
function shutdown() {
  try {
    progress.save(true);
    library.index.save(true);
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
process.on('message', (m) => m?.type === 'shutdown' && shutdown());
// ランチャーが強制終了された場合も取り残されないように終了する
process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

media.detectEncoders().then((encs) => console.log(`利用可能なエンコーダー: ${encs.join(', ')}`));
library.scanAll();
