import crypto from 'node:crypto';
import { JsonStore, HttpError } from './store.js';

const COOKIE = 'micol_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** 送信元 IP（Cloudflare Tunnel 経由なら元のクライアント） */
export function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
}

/** プロキシを通らず LAN 内（または同じ PC）から直接アクセスしているか */
export function isDirectLan(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray']) return false;
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return (
    a === '::1' ||
    /^127\./.test(a) ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^f[cd][0-9a-f]{2}:/i.test(a) ||
    /^fe80:/i.test(a)
  );
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
}

export class Auth {
  constructor() {
    // { users: [{ id, name, admin, salt, hash, created }] }
    this.store = new JsonStore('users.json', { users: [] }, { pretty: true });
    // { [sha256(token)]: { userId, expires } }  （トークンそのものは保存しない）
    this.sessionStore = new JsonStore('sessions.json', {});
    this.failures = new Map();
    const now = Date.now();
    for (const [k, s] of Object.entries(this.sessionStore.data)) if (s.expires < now) delete this.sessionStore.data[k];
  }

  get users() {
    return this.store.data.users;
  }

  get needsSetup() {
    return this.users.length === 0;
  }

  publicUser(u) {
    return { id: u.id, name: u.name, admin: !!u.admin, created: u.created };
  }

  // ---------- ユーザー ----------

  createUser({ name, password, admin }) {
    name = String(name || '').trim();
    if (!name || name.length > 32) throw new HttpError(400, 'ユーザー名は 1〜32 文字で入力してください');
    if (this.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'そのユーザー名はすでに使われています');
    checkPassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: crypto.randomUUID().slice(0, 8), name, admin: !!admin, salt, hash: hashPassword(password, salt), created: Date.now() };
    this.users.push(user);
    this.store.save(true);
    return user;
  }

  updateUser(id, { password, admin }, actor) {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new HttpError(404, 'ユーザーが見つかりません');
    if (admin !== undefined && !!admin !== u.admin) {
      if (!admin && this.users.filter((x) => x.admin).length === 1) throw new HttpError(400, '管理者が 1 人もいなくなるため変更できません');
      u.admin = !!admin;
    }
    if (password !== undefined) {
      checkPassword(password);
      u.salt = crypto.randomBytes(16).toString('hex');
      u.hash = hashPassword(password, u.salt);
      // パスワードを変えたら、操作した本人以外のセッションはすべてログアウトさせる
      this.dropSessions(u.id, actor?.sessionKey);
    }
    this.store.save(true);
    return u;
  }

  deleteUser(id) {
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new HttpError(404, 'ユーザーが見つかりません');
    if (u.admin && this.users.filter((x) => x.admin).length === 1) throw new HttpError(400, '最後の管理者は削除できません');
    this.store.data.users = this.users.filter((x) => x !== u);
    this.dropSessions(u.id);
    this.store.save(true);
  }

  // ---------- ログイン ----------

  login(req, res, name, password) {
    const u = this.verify(req, name, password);
    this.startSession(req, res, u);
    return u;
  }

  /** ユーザー名とパスワードを確かめる（失敗が続く IP は一定時間ロック）。セッションは作らない */
  verify(req, name, password) {
    const ip = clientIp(req);
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) {
      throw new HttpError(429, `ログインに続けて失敗したため、${Math.ceil((f.until - Date.now()) / 60000)} 分後に再度お試しください`);
    }
    const u = this.users.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
    // ユーザーが存在しない場合も同じだけ時間をかけて、存在の有無を推測されにくくする
    const hash = hashPassword(String(password || ''), u?.salt || 'dummy-salt');
    const ok = u && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) {
      const count = (f?.count || 0) + 1;
      this.failures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      console.warn(`ログイン失敗: ${String(name).slice(0, 32)} (${ip})`);
      throw new HttpError(401, 'ユーザー名またはパスワードが違います');
    }
    this.failures.delete(ip);
    return u;
  }

  startSession(req, res, u) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessionStore.data[sha256(token)] = { userId: u.id, expires: Date.now() + SESSION_MS };
    this.sessionStore.save();
    res.setHeader('Set-Cookie', cookie(req, token, SESSION_MS / 1000));
  }

  logout(req, res) {
    const key = this.sessionKey(req);
    if (key) {
      delete this.sessionStore.data[key];
      this.sessionStore.save();
    }
    res.setHeader('Set-Cookie', cookie(req, '', 0));
  }

  sessionKey(req) {
    const m = /(?:^|;\s*)micol_session=([^;]+)/.exec(req.headers.cookie || '');
    return m ? sha256(m[1]) : null;
  }

  /** リクエストのログインユーザー（未ログインなら null） */
  userFromRequest(req) {
    const key = this.sessionKey(req);
    const s = key && this.sessionStore.data[key];
    if (!s) return null;
    if (s.expires < Date.now()) {
      delete this.sessionStore.data[key];
      this.sessionStore.save();
      return null;
    }
    const u = this.users.find((x) => x.id === s.userId);
    if (!u) return null;
    // 使っている間は期限を延ばす（1 日に 1 回だけ保存）
    if (s.expires - Date.now() < SESSION_MS - 24 * 3600 * 1000) {
      s.expires = Date.now() + SESSION_MS;
      this.sessionStore.save();
    }
    return { ...u, sessionKey: key };
  }

  dropSessions(userId, exceptKey) {
    for (const [k, s] of Object.entries(this.sessionStore.data)) {
      if (s.userId === userId && k !== exceptKey) delete this.sessionStore.data[k];
    }
    this.sessionStore.save();
  }

  flush() {
    this.store.save(true);
    this.sessionStore.save(true);
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'パスワードは 8 文字以上にしてください');
  if (password.length > 200) throw new HttpError(400, 'パスワードが長すぎます');
}

function cookie(req, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge)}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}
