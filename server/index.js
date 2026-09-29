import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { JsonStore, HttpError, ROOT, naturalCompare } from './store.js';
import { Library } from './library.js';
import { nfoFields, normalizeDate } from './nfo.js';
import { Media } from './media.js';
import { Auth, isDirectLan } from './auth.js';

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
const config = new JsonStore('config.json', {
  port: 8420,
  host: '0.0.0.0',
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  libraries: [],
  transcode: DEFAULT_TRANSCODE,
}, { pretty: true });
config.data.transcode = { ...DEFAULT_TRANSCODE, ...config.data.transcode };
delete config.data.autoUpdate; // 旧バージョンの自動更新設定（現在は手動更新のみ）
delete config.data.allowRemoteAdmin; // 旧バージョンの設定（現在は管理者ユーザーでログインすれば変更できる）
config.save(true);

// 視聴位置（ユーザー別）: { users: { [userId]: { [itemId]: { position, duration, watched, updated } } } }
const progress = new JsonStore('progress.json', { users: {} });
// ユーザー機能ができる前の視聴位置は legacy に退避し、最初に作る管理者に引き継ぐ
for (const k of Object.keys(progress.data)) {
  if (k === 'users' || k === 'legacy') continue;
  (progress.data.legacy ??= {})[k] = progress.data[k];
  delete progress.data[k];
}
progress.save(true);
const userProgress = (user) => (progress.data.users[user.id] ??= {});

const auth = new Auth();
// 女優の情報（生年月日）: { [名前]: { birthdate: 'YYYY-MM-DD' } }
const people = new JsonStore('people.json', {}, { pretty: true });
// 画面で設定した値（people.json）を優先し、なければ NFO の <actor><birthdate> を使う
const birthdateOf = (name, person) => people.data[name]?.birthdate || (person ?? library.people().get(name))?.birthdate || null;
const library = new Library(config);
const media = new Media(config, library);

// ---------- DTO ----------

function itemDto(it, prog) {
  const p = prog[it.id];
  return {
    id: it.id,
    name: it.name,
    file: it.file,
    thumb: media.thumbVersion(it),
    season: it.nfo?.season ?? null,
    episode: it.nfo?.episode ?? null,
    year: it.nfo?.year ?? null,
    released: it.nfo?.premiered || null,
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
/** access: 'user'（ログイン必須・既定） / 'admin'（管理者のみ） / 'public'（ログイン不要） */
function route(method, pattern, handler, access = 'user') {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler, access });
}

// ---------- 認証 ----------

route('GET', '/api/auth/status', ({ req, user }) => ({
  setup: auth.needsSetup,
  // 最初の管理者は、インターネット経由ではなく LAN 内から直接アクセスしたときだけ作成できる
  canSetup: auth.needsSetup && isDirectLan(req),
  user: user ? auth.publicUser(user) : null,
}), 'public');

route('POST', '/api/auth/setup', ({ req, res, body }) => {
  if (!auth.needsSetup) throw new HttpError(400, 'すでにセットアップ済みです');
  if (!isDirectLan(req)) throw new HttpError(403, '最初の管理者は、サーバーと同じ LAN 内から直接アクセスして作成してください');
  const u = auth.createUser({ name: body.name, password: body.password, admin: true });
  if (progress.data.legacy) {
    progress.data.users[u.id] = progress.data.legacy;
    delete progress.data.legacy;
    progress.save(true);
  }
  auth.startSession(req, res, u);
  return { user: auth.publicUser(u) };
}, 'public');

route('POST', '/api/auth/login', ({ req, res, body }) => {
  const u = auth.login(req, res, body.name, body.password);
  return { user: auth.publicUser(u) };
}, 'public');

route('POST', '/api/auth/logout', ({ req, res }) => {
  auth.logout(req, res);
  return { ok: true };
}, 'public');

// 自分のパスワード変更（今のパスワードの確認が必要）
route('POST', '/api/auth/password', ({ req, user, body }) => {
  auth.verify(req, user.name, body.current);
  auth.updateUser(user.id, { password: body.password }, user);
  return { ok: true };
});

// ---------- ユーザー管理（管理者） ----------

route('GET', '/api/users', () => auth.users.map((u) => auth.publicUser(u)), 'admin');

route('POST', '/api/users', ({ body }) => auth.publicUser(auth.createUser(body)), 'admin');

route('PUT', '/api/users/:id', ({ params, body, user }) => {
  const patch = {};
  if (body.password) patch.password = body.password;
  if (body.admin !== undefined) patch.admin = body.admin;
  return auth.publicUser(auth.updateUser(params.id, patch, user));
}, 'admin');

route('DELETE', '/api/users/:id', ({ params }) => {
  auth.deleteUser(params.id);
  delete progress.data.users[params.id];
  progress.save();
  return { ok: true };
}, 'admin');

route('GET', '/api/home', ({ prog }) => {
  const all = [...library.items.values()];
  const resume = all
    .filter((it) => (prog[it.id]?.position || 0) >= 10)
    .sort((a, b) => prog[b.id].updated - prog[a.id].updated)
    .slice(0, 20)
    .map((it) => itemDto(it, prog));
  const recent = all.sort((a, b) => b.added - a.added).slice(0, 30).map((it) => itemDto(it, prog));
  return {
    libraries: library.roots.map((id) => folderDto(library.folders.get(id))),
    resume,
    recent,
    thumbRatio: thumbRatio(),
    scanning: library.scanning,
  };
});

/** サムネイル枠の縦横比: ライブラリでいちばん多い動画の比率（近い比率はまとめ、3:4〜2.4:1 に収める） */
function thumbRatio() {
  const groups = new Map();
  for (const it of library.items.values()) {
    const v = it.probe?.video;
    if (!(v?.width > 0 && v?.height > 0)) continue;
    const r = v.width / v.height;
    const key = Math.round(r * 10); // 2.35:1 と 2.39:1 のような近い比率はまとめる
    const g = groups.get(key) || { n: 0, sum: 0 };
    g.n++;
    g.sum += r;
    groups.set(key, g);
  }
  let best = null;
  for (const g of groups.values()) if (!best || g.n > best.n) best = g;
  return Math.min(2.4, Math.max(0.75, best ? best.sum / best.n : 16 / 9));
}

route('GET', '/api/libraries', () => ({
  libraries: library.roots.map((id) => folderDto(library.folders.get(id))),
  thumbRatio: thumbRatio(),
}));

// 視聴履歴（新しい順）。未視聴に戻したものなど、位置も視聴済みも無いものは含めない
route('GET', '/api/history', ({ prog }) => {
  const items = Object.entries(prog)
    .filter(([id, p]) => library.items.has(id) && (p.position > 0 || p.watched))
    .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0))
    .slice(0, 300)
    .map(([id, p]) => {
      const it = library.items.get(id);
      return { ...itemDto(it, prog), updated: p.updated || 0, folder: library.folders.get(it.folderId)?.name || '' };
    });
  return { items };
});

// 履歴から削除（視聴位置・視聴済みの記録も消える）
route('DELETE', '/api/history/:id', ({ params, prog }) => {
  delete prog[params.id];
  progress.save();
  return { ok: true };
});

route('DELETE', '/api/history', ({ prog }) => {
  for (const id of Object.keys(prog)) delete prog[id];
  progress.save();
  return { ok: true };
});

route('GET', '/api/folders/:id', ({ params, prog }) => {
  const f = getFolder(params.id);
  return {
    folder: { id: f.id, name: f.name, parentId: f.parentId, nfo: f.nfo || null },
    breadcrumbs: library.breadcrumbs(f),
    folders: f.folders.map((id) => folderDto(library.folders.get(id))),
    items: f.items.map((id) => itemDto(library.items.get(id), prog)),
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

route('GET', '/api/items/:id', async ({ params, prog }) => {
  const it = getItem(params.id);
  const probe = await library.ensureProbe(it).catch(() => it.probe);
  const folder = library.folders.get(it.folderId);
  const siblings = folder?.items || [];
  const i = siblings.indexOf(it.id);
  const sibling = (j) => (siblings[j] ? itemDto(library.items.get(siblings[j]), prog) : null);
  return {
    ...itemDto(it, prog),
    path: it.path,
    container: it.ext.slice(1),
    nfo: it.nfo || null,
    nfoPath: it.nfoPath || null,
    // 出演者と生年月日（当時の年齢の表示用）
    cast: (it.nfo?.actors || []).map((name) => ({ name, birthdate: people.data[name]?.birthdate || it.nfo.actorBirthdates?.[name] || birthdateOf(name) })),
    customThumb: !!it.sideImage,
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
}, 'admin');

route('DELETE', '/api/items/:id/thumb', ({ params }) => {
  const it = getItem(params.id);
  media.clearCustomThumb(it);
  return { ok: true, thumb: media.thumbVersion(it) };
}, 'admin');

// メタデータを NFO に保存する（送られた項目だけを書き換える）
route('PUT', '/api/items/:id/nfo', async ({ params, body }) => {
  const it = getItem(params.id);
  let fields;
  try {
    fields = nfoFields(body || {});
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  try {
    const file = await library.saveNfo(it, fields);
    return { ok: true, file };
  } catch (e) {
    throw new HttpError(500, `NFO を保存できません: ${e.message}`);
  }
}, 'admin');

// シークバーのプレビュー。無ければバックグラウンドで生成を始め、{ pending: true } を返す
route('GET', '/api/items/:id/trickplay', async ({ params }) => {
  const it = getItem(params.id);
  const info = await media.trickplay(it, true);
  return info ? { ...info, v: Math.round(it.mtime) } : { pending: media.trickplayPending.has(it.id) };
});

route('GET', '/api/items/:id/trickplay/:n', async ({ res, params }) => {
  const it = getItem(params.id);
  const info = await media.trickplay(it);
  if (!info) throw new HttpError(404, 'トリックプレイがありません');
  media.sendImage(res, media.trickplaySheet(it, info, Number(params.n)), 86400);
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

route('POST', '/api/items/:id/progress', ({ params, body, prog }) => {
  const it = getItem(params.id);
  const duration = Number(body.duration) || it.probe?.duration || 0;
  const position = Math.max(0, Number(body.position) || 0);
  const prev = prog[it.id];
  const finished = duration > 0 && position / duration > 0.9;
  prog[it.id] = {
    position: finished ? 0 : position,
    duration,
    watched: finished || !!prev?.watched,
    updated: Date.now(),
  };
  progress.save();
  return { ok: true };
});

route('POST', '/api/items/:id/watched', ({ params, body, prog }) => {
  const it = getItem(params.id);
  prog[it.id] = { position: 0, duration: it.probe?.duration || 0, watched: !!body.watched, updated: Date.now() };
  progress.save();
  return { ok: true };
});

route('GET', '/api/search', ({ query, prog }) => {
  const q = (query.get('q') || '').trim();
  if (!q) return { folders: [], items: [], people: [] };
  const r = library.search(q);
  return { folders: r.folders.map(folderDto), items: r.items.map((it) => itemDto(it, prog)), people: r.people.map(personDto) };
});

// ---------- 女優（NFO の出演者） ----------

const personDto = (p) => ({ name: p.name, count: p.items.length, thumb: !!p.thumb, birthdate: birthdateOf(p.name, p) });

function getPerson(name) {
  const p = library.people().get(name || '');
  if (!p) throw new HttpError(404, '見つかりません');
  return p;
}

route('GET', '/api/people', () => ({
  people: [...library.people().values()].map(personDto),
}));

// 出演作品（発売日の新しい順、なければ名前順）。名前に / などを含められるよう ?name= で渡す
route('GET', '/api/person', ({ query, prog }) => {
  const p = getPerson(query.get('name'));
  const items = p.items
    .map((id) => library.items.get(id))
    .sort((a, b) => (b.nfo?.premiered || '').localeCompare(a.nfo?.premiered || '') || naturalCompare(a.name, b.name));
  return { ...personDto(p), items: items.map((it) => itemDto(it, prog)) };
});

// 生年月日の設定（空なら削除）。2024 / 2024-01 / 2024-01-31 の形式
route('PUT', '/api/person', ({ query, body }) => {
  const p = getPerson(query.get('name'));
  const v = normalizeDate(body.birthdate);
  if (v === null) throw new HttpError(400, `生年月日を日付として読み取れません（1995-04-12 や 1995/04/12 の形式で入力してください）: ${body.birthdate}`);
  if (v) {
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
    const [y, mo = 1, d = 1] = m ? m.slice(1).filter(Boolean).map(Number) : [];
    const date = new Date(y, mo - 1, d);
    if (!m || date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date > new Date() || y < 1900) {
      throw new HttpError(400, `生年月日は 1995-04-12 の形式で、正しい日付を入力してください: ${v}`);
    }
    people.data[p.name] = { ...people.data[p.name], birthdate: v };
  } else if (people.data[p.name]) {
    delete people.data[p.name].birthdate;
    if (!Object.keys(people.data[p.name]).length) delete people.data[p.name];
  }
  people.save();
  return personDto(p);
}, 'admin');

route('GET', '/api/person/thumb', ({ res, query }) => {
  const p = getPerson(query.get('name'));
  if (!p.thumb) throw new HttpError(404, '写真なし');
  // NFO に URL が書かれている場合はその画像へ転送する
  if (/^https?:\/\//i.test(p.thumb)) {
    res.writeHead(302, { Location: p.thumb, 'Cache-Control': 'max-age=3600' });
    return res.end();
  }
  media.sendImage(res, p.thumb, 3600);
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
}, 'admin');

// ---------- 手動更新（git） ----------

function git(...args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new HttpError(500, `git ${args[0]} に失敗しました: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout).trim());
    });
  });
}

// GitHub に新しいコミットがあるか確認する（取り込みはしない）
route('POST', '/api/update/check', async () => {
  await git('fetch', '--quiet', 'origin');
  const out = await git('log', '--format=%h%x09%cd%x09%s', '--date=format:%Y-%m-%d %H:%M', 'HEAD..@{u}');
  const commits = out
    ? out.split('\n').map((l) => {
        const [hash, date, ...subject] = l.split('\t');
        return { hash, date, subject: subject.join('\t') };
      })
    : [];
  const local = Number(await git('rev-list', '--count', '@{u}..HEAD'));
  return { version: VERSION, commits, local, supervised: !!process.send };
}, 'admin');

// ランチャーに更新を依頼する（git pull → サーバー再起動）
route('POST', '/api/update/apply', () => {
  if (!process.send) {
    throw new HttpError(400, 'start.bat で起動しているため、ここからは更新できません。git pull してから起動し直してください');
  }
  process.send({ type: 'update' });
  return { ok: true };
}, 'admin');

route('GET', '/api/settings', () => ({
  libraries: config.data.libraries,
  transcode: config.data.transcode,
  encoders: media.encoders,
}), 'admin');

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
}, 'admin');

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
}, 'admin');

// ---------- サーバー ----------

const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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

// index.html 内の app.js / app.css に内容のハッシュを付けて配る。
// 更新で中身が変わると URL も変わるので、ブラウザに古いファイルが残っていても使われない
const ASSET_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['app.js', 'app.css']) {
    try {
      h.update(fs.readFileSync(path.join(PUBLIC, f)));
    } catch {}
  }
  return h.digest('hex').slice(0, 10);
})();

function serveStatic(req, res, pathname) {
  const file = path.join(PUBLIC, path.normalize(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  if (file === path.join(PUBLIC, 'index.html')) {
    return fs.readFile(file, 'utf8', (err, html) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(html.replace(/(src|href)="\/(app\.(?:js|css))"/g, `$1="/$2?v=${ASSET_VERSION}"`));
    });
  }
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
      const user = auth.userFromRequest(req);
      if (r.access !== 'public' && !user) throw new HttpError(401, 'ログインしてください');
      if (r.access === 'admin' && !user.admin) throw new HttpError(403, 'この操作は管理者のみ可能です');
      const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};
      const prog = user ? userProgress(user) : null;
      const out = await r.handler({ req, res, params: m.groups || {}, query: url.searchParams, body, user, prog });
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
    people.save(true);
    library.index.save(true);
    auth.flush();
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
