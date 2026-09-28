import { execFile } from 'node:child_process';

/** ffprobe でメディア情報を取得し、再生判定に必要な情報だけに要約する */
export function probeFile(ffprobe, file) {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 20 * 1024 * 1024, windowsHide: true, timeout: 60000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(summarize(JSON.parse(stdout)));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

function summarize(j) {
  const streams = j.streams || [];
  const tags = (s) => s.tags || {};
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  return {
    duration: parseFloat(j.format?.duration) || parseFloat(v?.duration) || 0,
    start: parseFloat(j.format?.start_time) || 0,
    format: j.format?.format_name || '',
    bitrate: Number(j.format?.bit_rate) || 0,
    video: v
      ? {
          index: v.index,
          codec: v.codec_name,
          profile: v.profile || '',
          pixFmt: v.pix_fmt || '',
          width: v.width,
          height: v.height,
        }
      : null,
    audio: streams
      .filter((s) => s.codec_type === 'audio')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        channels: s.channels || 0,
        lang: tags(s).language || '',
        title: tags(s).title || '',
        default: !!s.disposition?.default,
      })),
    subs: streams
      .filter((s) => s.codec_type === 'subtitle')
      .map((s) => ({
        index: s.index,
        codec: s.codec_name,
        lang: tags(s).language || '',
        title: tags(s).title || '',
        default: !!s.disposition?.default,
        forced: !!s.disposition?.forced,
      })),
  };
}
