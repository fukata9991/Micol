// Micol の常駐用ランチャー
// - サーバー (server/index.js) を子プロセスとして起動し、落ちたら再起動する
// - 設定画面の「今すぐ更新」（サーバーからの要求）で git pull し、サーバーを再起動する
// - このファイル自体が更新されたときは終了し、run.cmd のループで起動し直してもらう

import { fork, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'micol.log');
const MAX_LOG = 5 * 1024 * 1024;
const EXIT_SELF_UPDATE = 3;

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(...args) {
  const line = `[${new Date().toLocaleString('ja-JP')}] ${args.join(' ')}`.trimEnd() + '\n';
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, windowsHide: true, timeout: 5 * 60000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout).trim());
    });
  });
}
const git = (...args) => run('git', args);

// ---------- サーバーの起動・停止 ----------

let child = null;
let stopping = false;
let crashCount = 0;

function startServer() {
  stopping = false;
  const startedAt = Date.now();
  child = fork(path.join(ROOT, 'server', 'index.js'), [], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pipe = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) log(l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('message', (m) => m?.type === 'update' && applyUpdate());
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    // すぐ落ち続ける場合は待ち時間を延ばす（最大 1 分）
    crashCount = Date.now() - startedAt < 30000 ? crashCount + 1 : 0;
    const wait = Math.min(60, 2 ** crashCount) * 1000;
    log(`サーバーが終了しました (code ${code})。${wait / 1000} 秒後に再起動します`);
    setTimeout(() => !child && startServer(), wait);
  });
}

function stopServer() {
  if (!child) return Promise.resolve();
  stopping = true;
  const c = child;
  return new Promise((resolve) => {
    const timer = setTimeout(() => c.kill(), 10000);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      c.send({ type: 'shutdown' });
    } catch {
      c.kill();
    }
  });
}

// ---------- 手動更新 ----------

let updating = false;

async function applyUpdate() {
  if (updating) return;
  updating = true;
  try {
    await git('fetch', '--quiet', 'origin');
    const local = await git('rev-parse', 'HEAD');
    const remote = await git('rev-parse', '@{u}');
    if (local === remote) {
      log('すでに最新です');
      return;
    }

    // 早送りできる（この PC 側でコミットしていない）場合だけ更新する
    const base = await git('merge-base', 'HEAD', '@{u}');
    if (base !== local) {
      log('この PC のリポジトリに独自のコミットがあるため、更新できません');
      return;
    }
    const changed = (await git('diff', '--name-only', local, remote)).split('\n').filter(Boolean);
    const summary = await git('log', '--format=%h %s', `${local}..${remote}`);
    log(`更新を検出しました:\n${summary}`);

    await git('merge', '--ff-only', '--quiet', '@{u}');

    if (changed.some((f) => f === 'package.json' || f === 'package-lock.json')) {
      log('依存パッケージを更新しています…');
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { shell: true });
    }

    await stopServer();
    if (changed.some((f) => f.startsWith('service/'))) {
      log('ランチャー自体が更新されたため、ランチャーごと再起動します');
      process.exit(EXIT_SELF_UPDATE);
    }
    log('更新を適用しました。サーバーを再起動します');
    startServer();
  } catch (e) {
    log(`更新に失敗しました: ${e.message}`);
  } finally {
    updating = false;
  }
}

// ---------- 起動 ----------

async function shutdownAll() {
  log('停止します');
  await stopServer();
  process.exit(0);
}
process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);

log(`ランチャーを起動しました (${ROOT})`);
startServer();
