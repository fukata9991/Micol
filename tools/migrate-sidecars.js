// 動画の隣にある付属ファイル（Jellyfin 形式）を、動画フォルダ内の .thumbs / .nfo / .trickplay に移す
//
//   node tools/migrate-sidecars.js [--apply] [--ffmpeg <path>] [フォルダ ...]
//
// - フォルダを省略すると data/config.json のライブラリすべてが対象
// - --apply を付けないと、何をするかの確認だけ（ファイルは変更しない）
// - 何度実行してもよい（移動先に同名のファイルがあるものはそのまま残して報告する）
//
// 移動のルール（動画 "X.mp4" の場合）
//   画像      X-landscape / X / X-thumb / X-poster / X-fanart (.jpg .jpeg .png .webp)
//             → 最初に見つかったものを .thumbs/X.jpg に（PNG・WebP は JPEG に変換し、元の画像も .thumbs に移す）
//             → 残りの画像は .thumbs に同じ名前で移す（Micol は使わないが、消さずに残す）
//   NFO       X.nfo → .nfo/X.nfo（中の画像パスは移動後のパスに書き換える）
//   トリックプレイ X.trickplay/ → .trickplay/X.trickplay/
// 画像がどの動画のものかは、ファイル名が「動画名 + 接尾辞 + 拡張子」と完全に一致するかで判断する。
// 複数の動画に当てはまる場合（"A.mp4" と "A-thumb.mp4" があるときの "A-thumb.jpg" など）は、名前の長い動画のものとする。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VIDEO_EXT, SIDE_DIRS } from '../server/library.js';
import { ROOT, DATA_DIR } from '../server/store.js';

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const IMAGE_SUFFIXES = ['-landscape', '', '-thumb', '-poster', '-fanart'];
const FOLDER_NFO = new Set(['tvshow.nfo', 'season.nfo', 'movie.nfo']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.trash']);
const ART_TAGS = ['landscape', 'poster', 'thumb', 'fanart', 'banner', 'clearlogo', 'clearart', 'discart'];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
let ffmpeg = 'ffmpeg';
const roots = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') continue;
  if (args[i] === '--ffmpeg') ffmpeg = args[++i];
  else roots.push(path.resolve(args[i]));
}
const configFile = path.join(DATA_DIR, 'config.json');
if (fs.existsSync(configFile)) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  if (!roots.length) roots.push(...(config.libraries || []).map((l) => l.path));
  if (!args.includes('--ffmpeg') && config.ffmpegPath) ffmpeg = config.ffmpegPath;
}
if (!roots.length) {
  console.error('対象のフォルダを指定してください（例: node tools/migrate-sidecars.js D:\\Video）');
  process.exit(1);
}

const stat = { videos: 0, thumb: 0, converted: 0, extraImages: 0, nfo: 0, nfoRewritten: 0, trickplay: 0 };
const moves = []; // { op, from, to }
const problems = []; // 移動しなかったもの
const orphans = []; // 動画が見つからない付属ファイル
const samples = [];

for (const root of roots) walk(root);

console.log(`モード: ${apply ? '実行' : '確認のみ（--apply で実行）'}`);
console.log(`対象: ${roots.join(', ')}`);
console.log(JSON.stringify(stat));
if (samples.length) console.log('\n--- 例 ---\n' + samples.join('\n'));
if (problems.length) console.log(`\n--- 移動しなかったもの (${problems.length}) ---\n` + problems.join('\n'));
if (orphans.length) console.log(`\n--- 対応する動画が無いため残したもの (${orphans.length}) ---\n` + orphans.join('\n'));
if (apply && moves.length) {
  const log = path.join(DATA_DIR, 'logs', `migrate-sidecars-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, JSON.stringify(moves, null, 1));
  console.log(`\n移動の記録: ${path.relative(ROOT, log)}`);
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    problems.push(`読めないフォルダ: ${dir} (${e.message})`);
    return;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const videos = files.filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase())).map((f) => f.slice(0, -path.extname(f).length));
  const videoSet = new Map(videos.map((b) => [b.toLowerCase(), b]));
  stat.videos += videos.length;

  // 画像 → 持ち主の動画（名前が完全一致するもののうち、動画名が最も長いもの）
  const images = new Map(); // 動画名(小文字) -> [{ name, suffix }]
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXT.includes(ext)) continue;
    const stem = f.slice(0, -ext.length).toLowerCase();
    let best = null;
    for (const suffix of IMAGE_SUFFIXES) {
      if (!stem.endsWith(suffix)) continue;
      const base = suffix ? stem.slice(0, -suffix.length) : stem;
      if (videoSet.has(base) && (!best || base.length > best.base.length)) best = { base, suffix };
    }
    if (best) {
      if (!images.has(best.base)) images.set(best.base, []);
      images.get(best.base).push({ name: f, suffix: best.suffix });
    } else if (/-(landscape|poster|thumb|fanart)$/i.test(stem)) {
      orphans.push(path.join(dir, f));
    }
  }

  for (const f of files) {
    if (path.extname(f).toLowerCase() !== '.nfo' || FOLDER_NFO.has(f.toLowerCase())) continue;
    if (!videoSet.has(f.slice(0, -4).toLowerCase())) orphans.push(path.join(dir, f));
  }
  for (const d of dirs) {
    if (d.startsWith('.') || !/\.trickplay$/i.test(d)) continue;
    if (!videoSet.has(d.slice(0, -10).toLowerCase())) orphans.push(path.join(dir, d) + '\\');
  }

  for (const base of videos) migrateVideo(dir, base, files, dirs, images.get(base.toLowerCase()) || []);

  for (const d of dirs) {
    if (d.startsWith('.') || SKIP_DIRS.has(d.toLowerCase()) || /\.trickplay$/i.test(d)) continue;
    walk(path.join(dir, d));
  }
}

function migrateVideo(dir, base, files, dirs, imgs) {
  const lower = base.toLowerCase();
  const thumbsDir = path.join(dir, SIDE_DIRS.thumbs);
  const renamed = new Map(); // 画像の元のファイル名(小文字) -> 新しいフルパス（NFO の書き換え用）
  const note = [];

  // --- 画像 ---
  imgs.sort((a, b) => IMAGE_SUFFIXES.indexOf(a.suffix) - IMAGE_SUFFIXES.indexOf(b.suffix));
  const main = imgs[0];
  let extras = imgs.slice(1);
  if (main) {
    const target = path.join(thumbsDir, `${base}.jpg`);
    const src = path.join(dir, main.name);
    const ext = path.extname(main.name).toLowerCase();
    if (exists(target)) {
      // 既に .thumbs/X.jpg がある（前回の実行や画面から設定済み）: 画像には手を付けない
      problems.push(`サムネイルが既にある: ${target}（${imgs.map((i) => i.name).join(', ')} は移動せず）`);
      extras = [];
    } else if (ext === '.jpg' || ext === '.jpeg') {
      move(src, target, 'thumb');
      renamed.set(main.name.toLowerCase(), target);
      stat.thumb++;
      note.push(`${main.name} → ${SIDE_DIRS.thumbs}\\${base}.jpg`);
    } else if (convert(src, target)) {
      // PNG / WebP は JPEG に変換し、変換元も .thumbs に残す
      renamed.set(main.name.toLowerCase(), target);
      stat.thumb++;
      stat.converted++;
      note.push(`${main.name} → ${SIDE_DIRS.thumbs}\\${base}.jpg（JPEG に変換）`);
      extras = imgs;
    } else {
      extras = [];
    }
  }
  // 残りの画像は同じ名前で .thumbs へ（Micol は使わないが、消さずに残す）
  for (const img of extras) {
    const src = path.join(dir, img.name);
    const target = path.join(thumbsDir, img.name);
    if (exists(target)) {
      problems.push(`同じ名前の画像が既にある: ${target}`);
      continue;
    }
    move(src, target, 'image');
    if (!renamed.has(img.name.toLowerCase())) renamed.set(img.name.toLowerCase(), target);
    stat.extraImages++;
  }

  // --- NFO ---
  const nfoName = files.find((f) => f.toLowerCase() === lower + '.nfo');
  const sideNfo = path.join(dir, SIDE_DIRS.nfo, `${base}.nfo`);
  let nfoPath = exists(sideNfo) ? sideNfo : null;
  if (nfoName) {
    const src = path.join(dir, nfoName);
    if (nfoPath) {
      problems.push(`NFO が既にある: ${sideNfo}（${nfoName} は移動せず）`);
    } else {
      rewriteNfo(src, renamed);
      move(src, sideNfo, 'nfo');
      nfoPath = sideNfo;
      stat.nfo++;
      note.push(`${nfoName} → ${SIDE_DIRS.nfo}\\${base}.nfo`);
    }
  } else if (nfoPath && renamed.size) {
    rewriteNfo(nfoPath, renamed);
  }

  // --- トリックプレイ ---
  const tpName = dirs.find((d) => d.toLowerCase() === lower + '.trickplay');
  if (tpName) {
    const target = path.join(dir, SIDE_DIRS.trickplay, `${base}.trickplay`);
    if (exists(target)) {
      problems.push(`トリックプレイが既にある: ${target}（${tpName} は移動せず）`);
    } else {
      move(path.join(dir, tpName), target, 'trickplay');
      stat.trickplay++;
      note.push(`${tpName}\\ → ${SIDE_DIRS.trickplay}\\${base}.trickplay\\`);
    }
  }

  if (note.length && samples.length < 12) samples.push(`[${dir}]\n  ` + note.join('\n  '));
}

function convert(src, target) {
  moves.push({ op: 'convert', from: src, to: target });
  if (!apply) return true;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.migrate-${process.pid}.jpg`);
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-frames:v', '1', '-q:v', '2', '-update', '1', tmp], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    moves.pop();
    problems.push(`変換できない: ${src} (${String(e.stderr || e.message).trim()})`);
    return false;
  }
}

function exists(p) {
  return fs.existsSync(p);
}

function move(from, to, op) {
  moves.push({ op, from, to });
  if (!apply) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/** NFO 内の画像パスのうち、移動した画像を指しているものを新しいパスに書き換える */
function rewriteNfo(file, renamed) {
  if (!renamed.size) return;
  const buf = fs.readFileSync(file);
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bom ? buf.subarray(3) : buf);
  } catch {
    problems.push(`UTF-8 ではないため画像パスを書き換えていない NFO: ${file}`);
    return;
  }
  // 出演者の <thumb> は対象外にするため、<actor> の外だけを書き換える
  const parts = xml.split(/(<actor[\s>][\s\S]*?<\/actor>)/i);
  const tag = new RegExp(`(<(${ART_TAGS.join('|')})(?:\\s[^>]*)?>)([^<]*)(</\\2>)`, 'gi');
  let changed = 0;
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(tag, (m, open, _name, value, close) => {
      const decoded = value.trim().replace(/&amp;/g, '&');
      if (/^https?:/i.test(decoded)) return m;
      const to = renamed.get(path.basename(decoded.replace(/\//g, '\\')).toLowerCase());
      if (!to) return m;
      changed++;
      return open + to.replace(/&/g, '&amp;') + close;
    });
  }
  if (!changed) return;
  stat.nfoRewritten++;
  if (!apply) return;
  const out = Buffer.from(parts.join(''), 'utf8');
  fs.writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), out]) : out);
}
