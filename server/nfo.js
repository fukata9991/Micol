import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';

/**
 * Kodi / Jellyfin 形式の NFO を読み込む（必要な項目だけを正規表現で取り出す簡易パーサ）。
 * URL だけが書かれた NFO や壊れた XML の場合は null を返す。
 */
export async function readNfo(file) {
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch {
    return null;
  }
  const xml = decode(buf);
  const root = /<(movie|episodedetails|tvshow|season|musicvideo)[\s>]/i.exec(xml);
  if (!root) return null;

  // 出演者やファンアートの中の <name> / <thumb> を拾わないよう除いておく
  const body = xml
    .replace(/<actor[\s>][\s\S]*?<\/actor>/gi, '')
    .replace(/<fanart[\s>][\s\S]*?<\/fanart>/gi, '')
    .replace(/<ratings[\s>][\s\S]*?<\/ratings>/gi, '');
  const one = (name) => all(body, name)[0] || '';
  const num = (name) => {
    const n = parseFloat(one(name));
    return Number.isFinite(n) ? n : null;
  };

  const premiered = one('premiered') || one('aired') || one('releasedate');
  let rating = num('rating');
  if (rating == null) {
    const ratings = /<ratings[\s>][\s\S]*?<\/ratings>/i.exec(xml)?.[0] || '';
    const v = parseFloat(all(ratings, 'value')[0]);
    if (Number.isFinite(v)) rating = v;
  }
  const actors = [...xml.matchAll(/<actor[\s>]([\s\S]*?)<\/actor>/gi)]
    .map((m) => all(m[1], 'name')[0])
    .filter(Boolean)
    .slice(0, 20);
  const thumb = all(body, 'thumb').find((t) => !/^https?:/i.test(t)) || '';

  return clean({
    kind: root[1].toLowerCase(),
    title: one('title'),
    originalTitle: one('originaltitle'),
    sortTitle: one('sorttitle'),
    showTitle: one('showtitle'),
    plot: one('plot') || one('outline'),
    tagline: one('tagline'),
    year: num('year') || (premiered ? parseInt(premiered, 10) || null : null),
    premiered,
    season: num('season'),
    episode: num('episode'),
    rating: rating != null ? Math.round(rating * 10) / 10 : null,
    mpaa: one('mpaa'),
    genres: unique(all(body, 'genre').flatMap((g) => g.split(/\s*[/|]\s*/))),
    studios: unique(all(body, 'studio')),
    directors: unique(all(body, 'director')),
    actors,
    // NFO 内のローカル画像（相対パスは NFO の場所基準）
    thumb: thumb ? resolveLocal(path.dirname(file), thumb) : null,
  });
}

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

function all(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => text(m[1])).filter(Boolean);
}

function text(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

function resolveLocal(dir, p) {
  const abs = path.isAbsolute(p) ? p : path.join(dir, p);
  return fss.existsSync(abs) ? abs : null;
}

const unique = (arr) => [...new Set(arr.filter(Boolean))];

function clean(o) {
  for (const k of Object.keys(o)) {
    if (o[k] == null || o[k] === '' || (Array.isArray(o[k]) && !o[k].length)) delete o[k];
  }
  return o;
}
