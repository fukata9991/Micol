import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';

/**
 * Kodi / Jellyfin 形式の NFO を読み込む（必要な項目だけを正規表現で取り出す簡易パーサ）。
 * URL だけが書かれた NFO や壊れた XML の場合は null を返す。
 * 相対パスの画像は baseDir（動画のフォルダ）基準で探す。
 */
export async function readNfo(file, baseDir = path.dirname(file)) {
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

  // 2019/05/25 などの表記も 2019-05-25 にそろえて扱う（ファイルは書き換えない）
  const premieredRaw = one('premiered') || one('aired') || one('releasedate');
  const premiered = normalizeDate(premieredRaw) || premieredRaw;
  let rating = num('rating');
  if (rating == null) {
    const ratings = /<ratings[\s>][\s\S]*?<\/ratings>/i.exec(xml)?.[0] || '';
    const v = parseFloat(all(ratings, 'value')[0]);
    if (Number.isFinite(v)) rating = v;
  }
  // 出演者: 名前と写真（Kodi 形式の .actors フォルダの画像 → <actor><thumb> のローカルの画像 → <thumb> の URL）
  const actors = [];
  const actorThumbs = {};
  const actorThumbSources = {}; // <actor><thumb> に書かれた画像（URL か実在するローカルのファイル。.actors への取り込み用）
  const actorBirthdates = {};
  for (const m of xml.matchAll(/<actor[\s>]([\s\S]*?)<\/actor>/gi)) {
    const name = all(m[1], 'name')[0];
    if (!name || actors.includes(name) || actors.length >= 50) continue;
    actors.push(name);
    const raw = all(m[1], 'thumb')[0];
    const t = actorThumb(baseDir, name, raw);
    if (t) actorThumbs[name] = t;
    const src = raw && (/^https?:\/\//i.test(raw) ? raw : IMAGE_EXT.includes(path.extname(raw).toLowerCase()) ? resolveLocal(baseDir, raw) : null);
    if (src) actorThumbSources[name] = src;
    const b = normalizeDate(all(m[1], 'birthdate')[0]);
    if (b) actorBirthdates[name] = b;
  }
  // 画像: <art><landscape> → <thumb> → <art><poster> の順で、実在するローカルファイルを使う
  const art = /<art[\s>][\s\S]*?<\/art>/i.exec(body)?.[0] || '';
  const thumb = [...all(art, 'landscape'), ...all(body, 'thumb'), ...all(art, 'poster')]
    .filter((t) => !/^https?:/i.test(t))
    .map((t) => resolveLocal(baseDir, t))
    .find(Boolean);

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
    tags: unique(all(body, 'tag')),
    actors,
    actorThumbs: Object.keys(actorThumbs).length ? actorThumbs : null,
    actorThumbSources: Object.keys(actorThumbSources).length ? actorThumbSources : null,
    actorBirthdates: Object.keys(actorBirthdates).length ? actorBirthdates : null,
    thumb,
  });
}

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * 出演者の写真: Kodi 形式の 動画のフォルダの .actors/名前.jpg（空白は _ に置き換えた名前も探す）
 * → <thumb> のローカルの画像ファイル → <thumb> の URL の順。なければ null
 */
function actorThumb(baseDir, name, thumb) {
  for (const n of new Set([name, name.replace(/ /g, '_')])) {
    if (/[\\/:*?"<>|]/.test(n)) continue;
    for (const ext of IMAGE_EXT) {
      const p = path.join(baseDir, '.actors', n + ext);
      if (fss.existsSync(p)) return p;
    }
  }
  if (thumb && IMAGE_EXT.includes(path.extname(thumb).toLowerCase()) && !/^https?:\/\//i.test(thumb)) {
    const p = resolveLocal(baseDir, thumb);
    if (p) return p;
  }
  if (thumb && /^https?:\/\//i.test(thumb)) return thumb;
  return null;
}

/**
 * 日付の表記をそろえる: 2019/05/25・2019.5.25・2019年5月25日・20190525・全角数字 → 2019-05-25。
 * 年月だけ・年だけも可（2019/5 → 2019-05）。空なら ''、日付として読めない・存在しない日付なら null
 */
export function normalizeDate(input) {
  const s = String(input ?? '').normalize('NFKC').trim().replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?.*$/, '');
  if (!s) return '';
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) {
    const t = s.replace(/日$/, '').replace(/[年月]/g, '-').replace(/[\s/.\-]+/g, '-').replace(/-$/, '');
    m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(t);
  }
  if (!m) return null;
  const [y, mo, d] = [m[1], m[2], m[3]].map((v) => (v === undefined ? undefined : Number(v)));
  if (mo !== undefined && (mo < 1 || mo > 12)) return null;
  if (d !== undefined && new Date(y, mo - 1, d).getDate() !== d) return null;
  return [String(y), mo && String(mo).padStart(2, '0'), d && String(d).padStart(2, '0')].filter(Boolean).join('-');
}

// ---------- 書き込み ----------

// 編集できる項目: 画面での名前 -> NFO のタグ
const TEXT_FIELDS = {
  title: 'title', originalTitle: 'originaltitle', sortTitle: 'sorttitle', tagline: 'tagline', plot: 'plot',
  year: 'year', premiered: 'premiered', season: 'season', episode: 'episode', rating: 'rating', mpaa: 'mpaa',
};
const LIST_FIELDS = { genres: 'genre', studios: 'studio', directors: 'director', tags: 'tag' };
const NUM_FIELDS = { year: ['年', 1800, 2999, true], season: ['シーズン', 0, 9999, true], episode: ['話数', 0, 99999, true], rating: ['評価', 0, 10, false] };

/**
 * 画面から送られた値を検証して、NFO に書く形にそろえる。
 * 送られてこなかった項目は含めない（その項目は NFO を変更しない）。
 */
export function nfoFields(body) {
  const out = {};
  for (const key of Object.keys(TEXT_FIELDS)) {
    if (!(key in body)) continue;
    let v = body[key] == null ? '' : String(body[key]).trim();
    if (v && key in NUM_FIELDS) {
      const [label, min, max, int] = NUM_FIELDS[key];
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
        throw new Error(`${label}は ${min}〜${max} の${int ? '整数' : '数値'}で入力してください: ${v}`);
      }
      v = String(n);
    }
    if (key === 'premiered' && v) {
      const d = normalizeDate(v);
      if (!d) throw new Error(`発売日を日付として読み取れません（2019-05-25 や 2019/05/25 の形式で入力してください）: ${v}`);
      v = d;
    }
    out[key] = v;
  }
  for (const key of [...Object.keys(LIST_FIELDS), 'actors']) {
    if (!(key in body)) continue;
    const arr = Array.isArray(body[key]) ? body[key] : [];
    out[key] = unique(arr.map((x) => String(x).trim()));
  }
  return out;
}

/**
 * NFO に値を書き込む。既存の NFO は指定した項目だけを置き換え、それ以外（<art> や <fileinfo> など）は残す。
 * file が無い場合は seed（movie.nfo など）の内容をもとにするか、新しく作る。UTF-8（BOM 付き）で保存する。
 */
export async function writeNfo(file, fields, { seed = null } = {}) {
  const src = fss.existsSync(file) ? file : seed && fss.existsSync(seed) ? seed : null;
  let xml = src
    ? decode(await fs.readFile(src))
    : '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<movie>\n</movie>\n';
  xml = xml.replace(/^(<\?xml[^>]*encoding=)(["'])[^"']*\2/i, '$1$2utf-8$2');
  const nl = xml.includes('\r\n') ? '\r\n' : '\n';

  const root = /<(movie|episodedetails|tvshow|season|musicvideo)(\s[^>]*)?(\/?)>/i.exec(xml);
  if (!root) throw new Error('NFO の形式が正しくありません');
  if (root[3]) xml = xml.slice(0, root.index) + `<${root[1]}${root[2] || ''}></${root[1]}>` + xml.slice(root.index + root[0].length);
  const bodyStart = root.index + xml.slice(root.index).indexOf('>') + 1;
  const bodyEnd = xml.toLowerCase().lastIndexOf(`</${root[1].toLowerCase()}>`);
  if (bodyEnd < bodyStart) throw new Error('NFO の形式が正しくありません');
  const body = xml.slice(bodyStart, bodyEnd);
  const indent = /\n([ \t]+)</.exec(body)?.[1] ?? '  ';

  // タグ名 -> 置き換え後の要素（空なら削除）。追加する場合はこの順で末尾に並ぶ
  const plan = new Map();
  const el = (tag, v) => `<${tag}>${escapeXml(v)}</${tag}>`;
  for (const [key, tag] of Object.entries(TEXT_FIELDS)) if (key in fields) plan.set(tag, fields[key] ? [el(tag, fields[key])] : []);
  for (const [key, tag] of Object.entries(LIST_FIELDS)) if (key in fields) plan.set(tag, fields[key].map((v) => el(tag, v)));
  if ('actors' in fields) {
    // 出演者は 名前 か { name, birthdate }。既にいる出演者は役名・画像などをそのまま残す
    const kept = new Map();
    for (const c of children(body)) {
      if (c.name !== 'actor') continue;
      const block = body.slice(c.start, c.end);
      const name = all(block, 'name')[0];
      if (name && !kept.has(name)) kept.set(name, block);
    }
    const in2 = indent + indent;
    plan.set('actor', fields.actors.map((a) => {
      const { name, birthdate } = typeof a === 'string' ? { name: a } : a;
      let block = kept.get(name);
      if (!block) return `<actor>${nl}${in2}${el('name', name)}${birthdate ? nl + in2 + el('birthdate', birthdate) : ''}${nl}${indent}</actor>`;
      // 生年月日が無ければ </actor> の前に足す（既にあれば変えない）
      if (birthdate && !/<birthdate[\s>]/i.test(block)) block = block.replace(/(\s*)<\/actor>$/i, `${nl}${in2}${el('birthdate', birthdate)}$1</actor>`);
      return block;
    }));
  }

  let out = '';
  let pos = 0;
  const placed = new Set();
  for (const c of children(body)) {
    if (!plan.has(c.name)) continue;
    // 要素とその行頭の空白・改行を取り除き、同じタグの最初の位置に新しい要素を入れる
    let s = c.start;
    while (s > pos && /[ \t]/.test(body[s - 1])) s--;
    if (s > pos && body[s - 1] === '\n') s -= s - 1 > pos && body[s - 2] === '\r' ? 2 : 1;
    out += body.slice(pos, s);
    if (!placed.has(c.name)) {
      placed.add(c.name);
      out += plan.get(c.name).map((e) => nl + indent + e).join('');
    }
    pos = c.end;
  }
  out += body.slice(pos);
  const rest = [...plan].filter(([tag]) => !placed.has(tag)).flatMap(([, els]) => els);
  if (rest.length) out = out.replace(/\s*$/, '') + rest.map((e) => nl + indent + e).join('') + nl;
  if (!/\S/.test(out)) out = nl;
  xml = xml.slice(0, bodyStart) + out + xml.slice(bodyEnd);

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, 'utf8')]));
  await fs.rename(tmp, file);
}

/** ルート要素の直下の子要素の位置（タグ名は小文字） */
function children(xml) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)(?:\s[^>]*?)?(\/?)>/g;
  let depth = 0;
  let cur = null;
  for (const m of xml.matchAll(re)) {
    if (!m[2]) continue;
    const end = m.index + m[0].length;
    if (m[1]) {
      depth--;
      if (depth === 0 && cur) {
        out.push({ ...cur, end });
        cur = null;
      }
    } else if (m[3]) {
      if (depth === 0) out.push({ name: m[2].toLowerCase(), start: m.index, end });
    } else {
      if (depth === 0) cur = { name: m[2].toLowerCase(), start: m.index };
      depth++;
    }
  }
  return out;
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
