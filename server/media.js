import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { CACHE_DIR, DATA_DIR, HttpError } from './store.js';

const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const SUB_DIR = path.join(CACHE_DIR, 'subs');
// ユーザーが設定したサムネイル（キャッシュではないので cache/ の外に置く）
const CUSTOM_DIR = path.join(DATA_DIR, 'thumbs-custom');
fs.mkdirSync(CUSTOM_DIR, { recursive: true });

export const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
// ブラウザがそのまま再生できる音声（MP4 へのコピーも可能なもの）
const COPY_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac']);
const DIRECT_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const VIDEO_MIME = { '.webm': 'video/webm' };
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const HW_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

export class Media {
  constructor(config, library) {
    this.config = config;
    this.library = library;
    this.thumbJobs = new Map();
    this.thumbFailed = new Set();
    this.thumbRunning = 0;
    this.thumbWaiters = [];
    this.subJobs = new Map();
    this.encoders = ['libx264'];
    // id -> 更新時刻（画像 URL のキャッシュ回避用）
    this.custom = new Map();
    for (const f of fs.readdirSync(CUSTOM_DIR)) {
      const m = /^([0-9a-f]{16})\.jpg$/.exec(f);
      if (m) this.custom.set(m[1], Math.round(fs.statSync(path.join(CUSTOM_DIR, f)).mtimeMs));
    }
  }

  get ffmpeg() {
    return this.config.data.ffmpegPath;
  }

  run(cmd, args, timeout = 120000) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || '').trim().split('\n').pop() || err.message));
        else resolve(String(stdout));
      });
    });
  }

  /** 実際にエンコードを試して、使えるハードウェアエンコーダーを調べる */
  async detectEncoders() {
    const results = await Promise.all(
      HW_ENCODERS.map((enc) =>
        this.run(this.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2',
          '-pix_fmt', enc === 'h264_qsv' ? 'nv12' : 'yuv420p', '-c:v', enc, '-f', 'null', '-',
        ], 20000).then(() => enc, () => null),
      ),
    );
    this.encoders = ['libx264', ...results.filter(Boolean)];
    return this.encoders;
  }

  // ---------- 再生方式の判定 ----------

  /**
   * direct    : ファイルをそのまま配信（シーク可能）
   * remux     : 映像・音声をコピーして MP4 に詰め替え
   * audio     : 映像はコピー、音声のみ AAC に変換
   * transcode : 映像も H.264 に変換
   */
  decide(item, probe, caps, audioIndex, force) {
    const v = probe.video;
    const tracks = probe.audio;
    const sel = tracks.find((a) => a.index === audioIndex) || tracks.find((a) => a.default) || tracks[0] || null;
    const videoOk = !!v && videoCompatible(v, caps);
    const audioOk = !sel || COPY_AUDIO.has(sel.codec);
    const directAudioOk = !sel || audioOk || (item.ext === '.webm' && sel.codec === 'vorbis');
    // ダイレクト再生ではブラウザが最初の音声トラックを使う
    const firstTrack = sel === null || sel === tracks[0];

    let mode;
    if (force) mode = 'transcode';
    else if (videoOk && directAudioOk && firstTrack && DIRECT_EXT.has(item.ext)) mode = 'direct';
    else if (videoOk && audioOk) mode = 'remux';
    else if (videoOk) mode = 'audio';
    else mode = 'transcode';
    return { mode, audioIndex: sel ? sel.index : null };
  }

  /** 映像コピー時のシーク位置を、その直前（または直後）のキーフレームに合わせる */
  keyframe(item, probe, t) {
    if (!probe.video || t <= 0) return Promise.resolve(Math.max(0, t));
    const start = probe.start || 0;
    return this.run(this.config.data.ffprobePath, [
      '-v', 'error', '-select_streams', String(probe.video.index),
      '-read_intervals', `${(t + start).toFixed(3)}%+#1`,
      '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', item.path,
    ], 15000).then(
      (out) => {
        const k = parseFloat(out.trim().split(/\s+/)[0]);
        return Number.isFinite(k) ? Math.max(0, k - start) : t;
      },
      () => t,
    );
  }

  // ---------- 配信 ----------

  sendFile(req, res, file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'ファイルが見つかりません');
    }
    const size = st.size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      status = 206;
    }
    const headers = {
      'Content-Type': VIDEO_MIME[path.extname(file).toLowerCase()] || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** ffmpeg で fragmented MP4 に変換しながら配信（t 秒の位置から） */
  stream(req, res, item, probe, { mode, t, audio }) {
    const tc = this.config.data.transcode;
    const v = probe.video;
    const a = probe.audio.find((x) => x.index === audio) || probe.audio.find((x) => x.default) || probe.audio[0];

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (item.ext === '.avi') args.push('-fflags', '+genpts');
    // 映像コピー時はキーフレーム時刻ちょうどを指定される。ffmpeg は B フレームのある動画で
    // シーク位置を約 0.13 秒手前にずらすため、一つ前のキーフレームに戻らないよう余裕を足す
    if (t > 0) args.push('-ss', (mode === 'transcode' ? t : t + 0.2).toFixed(3));
    args.push('-i', item.path);
    if (v) args.push('-map', `0:${v.index}`);
    if (a) args.push('-map', `0:${a.index}`);

    if (v && mode === 'transcode') {
      const pix = tc.videoEncoder.includes('qsv') ? 'nv12' : 'yuv420p';
      const h = Number(tc.maxHeight) || 1080;
      args.push(
        '-vf', `scale=-2:'trunc(min(${h},ih)/2)*2',format=${pix}`,
        ...encoderArgs(tc),
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
      );
    } else if (v) {
      args.push('-c:v', 'copy');
      if (v.codec === 'hevc') args.push('-tag:v', 'hvc1');
    }
    if (a) {
      if (mode !== 'transcode' && mode !== 'audio' && COPY_AUDIO.has(a.codec)) args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', tc.audioBitrate || '192k', '-ac', '2');
    }
    args.push(
      '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '2000000',
      '-f', 'mp4', 'pipe:1',
    );

    const proc = spawn(this.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    proc.on('error', (e) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`ffmpeg を起動できません: ${e.message}`);
    });
    proc.on('close', (code) => {
      if (code && !res.destroyed) console.warn(`ffmpeg 終了 (${code}) ${item.name}\n${stderr.trim()}`);
    });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    proc.stdout.pipe(res);
    // シークや画面移動でリクエストが切れたら ffmpeg を止める
    res.on('close', () => proc.kill());
  }

  // ---------- サムネイル ----------

  async withThumbSlot(fn) {
    while (this.thumbRunning >= 2) await new Promise((r) => this.thumbWaiters.push(r));
    this.thumbRunning++;
    try {
      return await fn();
    } finally {
      this.thumbRunning--;
      this.thumbWaiters.shift()?.();
    }
  }

  /** 画像 URL に付けるバージョン（サムネイルが変わると値が変わる） */
  thumbVersion(item) {
    return this.custom.get(item.id) ?? Math.round(item.mtime);
  }

  itemThumb(item) {
    if (this.custom.has(item.id)) return Promise.resolve(path.join(CUSTOM_DIR, `${item.id}.jpg`));
    if (item.image) return Promise.resolve(item.image);
    const out = path.join(THUMB_DIR, `${item.id}_${Math.round(item.mtime)}.jpg`);
    if (fs.existsSync(out)) return Promise.resolve(out);
    if (this.thumbFailed.has(out)) return Promise.reject(new HttpError(404, 'サムネイルなし'));
    if (this.thumbJobs.has(out)) return this.thumbJobs.get(out);

    const job = this.withThumbSlot(async () => {
      const probe = await this.library.ensureProbe(item).catch(() => null);
      const d = probe?.duration || 0;
      const grab = (t) =>
        this.run(this.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', item.path,
          '-an', '-sn', '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', out,
        ], 60000).catch(() => {});
      await grab(d ? Math.min(d * 0.15, 300).toFixed(2) : 5);
      if (!fs.existsSync(out)) await grab(0);
      if (!fs.existsSync(out)) {
        this.thumbFailed.add(out);
        throw new HttpError(404, 'サムネイルを生成できません');
      }
      return out;
    }).finally(() => this.thumbJobs.delete(out));
    this.thumbJobs.set(out, job);
    return job;
  }

  // ---------- サムネイルの手動設定 ----------

  /** 指定時刻のフレームを JPEG で返す（サムネイル選択のプレビュー用、保存しない） */
  frame(res, item, t, width = 640) {
    const proc = spawn(this.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', item.path,
      '-an', '-sn', '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    proc.on('error', () => res.destroy());
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    proc.stdout.pipe(res);
    res.on('close', () => proc.kill());
  }

  async setCustomThumb(item, { t, image }) {
    const out = path.join(CUSTOM_DIR, `${item.id}.jpg`);
    const tmp = path.join(CUSTOM_DIR, `${item.id}.tmp.jpg`);
    const scale = ['-vf', "scale='min(1280,iw)':-2", '-q:v', '3', '-frames:v', '1', '-update', '1'];
    if (image) {
      const src = path.join(CUSTOM_DIR, `${item.id}.upload`);
      fs.writeFileSync(src, image);
      try {
        await this.run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...scale, tmp], 30000);
      } catch {
        throw new HttpError(400, '画像を読み込めません（JPEG / PNG / WebP に対応）');
      } finally {
        fs.rmSync(src, { force: true });
      }
    } else {
      await this.run(this.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', item.path, '-an', '-sn', ...scale, tmp,
      ], 60000);
    }
    if (!fs.existsSync(tmp)) throw new HttpError(500, 'サムネイルを作成できませんでした');
    fs.renameSync(tmp, out);
    this.custom.set(item.id, Date.now());
  }

  clearCustomThumb(item) {
    fs.rmSync(path.join(CUSTOM_DIR, `${item.id}.jpg`), { force: true });
    this.custom.delete(item.id);
  }

  sendImage(res, file, maxAge = 3600) {
    const type = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': `max-age=${maxAge}` });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }

  // ---------- 字幕 ----------

  subtitleList(item) {
    const out = item.subs.map((s, i) => ({
      key: 'x' + i,
      label: [s.lang || '外部', s.ext.toUpperCase()].join(' / '),
      supported: true,
      default: false,
    }));
    for (const s of item.probe?.subs || []) {
      out.push({
        key: 'e' + s.index,
        label: [s.lang, s.title, s.codec].filter(Boolean).join(' / ') || `字幕 ${s.index}`,
        supported: TEXT_SUBS.has(s.codec),
        default: s.default || s.forced,
      });
    }
    return out;
  }

  /** 字幕を WebVTT に変換してキャッシュ */
  subtitleVtt(item, key) {
    const out = path.join(SUB_DIR, `${item.id}_${key}_${Math.round(item.mtime)}.vtt`);
    if (fs.existsSync(out)) return Promise.resolve(out);
    if (this.subJobs.has(out)) return this.subJobs.get(out);

    let input;
    if (/^x\d+$/.test(key)) {
      const s = item.subs[Number(key.slice(1))];
      if (!s) throw new HttpError(404, '字幕が見つかりません');
      input = [...charsetArgs(s.path), '-i', s.path, '-map', '0:s:0'];
    } else if (/^e\d+$/.test(key)) {
      const idx = Number(key.slice(1));
      const s = item.probe?.subs.find((x) => x.index === idx);
      if (!s || !TEXT_SUBS.has(s.codec)) throw new HttpError(400, 'この字幕形式には対応していません');
      input = ['-i', item.path, '-map', `0:${idx}`];
    } else {
      throw new HttpError(400, '不正な字幕指定です');
    }
    const tmp = out + '.tmp';
    const job = this.run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-c:s', 'webvtt', '-f', 'webvtt', tmp], 600000)
      .then(() => {
        fs.renameSync(tmp, out);
        return out;
      })
      .finally(() => this.subJobs.delete(out));
    this.subJobs.set(out, job);
    return job;
  }
}

function videoCompatible(v, caps) {
  switch (v.codec) {
    case 'h264':
      // 10bit / 4:2:2 / 4:4:4 の H.264 はブラウザで再生できない
      return caps.includes('h264') && !/10|4:2:2|4:4:4/.test(v.profile) && !/10|12|422|444/.test(v.pixFmt);
    case 'hevc':
    case 'av1':
    case 'vp9':
    case 'vp8':
      return caps.includes(v.codec);
    default:
      return false;
  }
}

function encoderArgs(tc) {
  const enc = tc.videoEncoder || 'libx264';
  const q = String(Number(tc.quality) || 23);
  if (enc.includes('nvenc')) return ['-c:v', enc, '-preset', 'p4', '-rc', 'vbr', '-cq', q, '-b:v', '0'];
  if (enc.includes('qsv')) return ['-c:v', enc, '-preset', 'veryfast', '-global_quality', q];
  if (enc.includes('amf')) return ['-c:v', enc, '-quality', 'speed', '-rc', 'cqp', '-qp_i', q, '-qp_p', q];
  return ['-c:v', 'libx264', '-preset', tc.preset || 'veryfast', '-crf', q];
}

/** UTF-8 でない字幕ファイル（日本語の Shift-JIS など）は文字コードを指定する */
function charsetArgs(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xff || buf[0] === 0xfe) return []; // UTF-16 BOM
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return [];
  } catch {
    return ['-sub_charenc', 'CP932'];
  }
}
