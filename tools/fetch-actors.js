// 動画の出演者（女優）・発売日・生年月日を取得して NFO に書き込む
//
//   node tools/fetch-actors.js [フォルダ ...]          … 取得して確認用の一覧 data/actors-review.csv を作る（NFO は変更しない）
//   node tools/fetch-actors.js --apply                 … 一覧の「適用」が ○ の行を NFO に書き込む
//
// 取得元
//   1. FANZA（DMM Web API）: ファイル名の品番（MILK-163 など）で作品を探し、出演者・発売日を取得。
//      出演者の生年月日は女優検索 API から取得する。
//      data/dmm.json に { "apiId": "…", "affiliateId": "…-990" } が必要（無い場合は 2 だけ行う）
//   2. ファイル名: API で見つからない作品は、ファイル名の末尾の名前（"… 青井いちご" "(一条みお)" など）を候補にする。
//      既に他の作品に出演者として登録されている名前なら ○、そうでなければ ?（確認が必要）にする
//
// 書き込みのルール
//   - 出演者が既に入っている NFO の出演者は変更しない（生年月日だけ足す）
//   - 発売日（<premiered>）・年（<year>）は、NFO に無い場合だけ書く
//   - 生年月日は <actor><birthdate> に書く（Micol の画面で設定した値があればそちらが優先される）
//   - 未成年を性的に扱うタイトルの作品は対象外

import fs from 'node:fs';
import path from 'node:path';
import { VIDEO_EXT, SIDE_DIRS } from '../server/library.js';
import { readNfo, writeNfo, normalizeDate } from '../server/nfo.js';
import { DATA_DIR, CACHE_DIR } from '../server/store.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const REVIEW = path.join(DATA_DIR, 'actors-review.csv');
const DMM_CACHE = path.join(CACHE_DIR, 'dmm');
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.trash']);
// 未成年を性的に扱うタイトル（対象外にする）
const MINOR = /小[○●◯〇]?学生|小[○●◯〇]生|中[○●◯〇]?学生|中[○●◯〇]生|(?<![A-Za-z])[JＪ][CＣSＳ](?![A-Za-z])|ロ[○●◯〇]ータ|ロリータ|幼女|女児|児童|幼穴|園児/;

const config = readJson(path.join(DATA_DIR, 'config.json')) || {};
const roots = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
if (!roots.length) roots.push(...(config.libraries || []).map((l) => l.path).filter((p) => !/animetion/i.test(p)));
const dmmConf = readJson(path.join(DATA_DIR, 'dmm.json')) || {};
const api = dmmConf.apiId && dmmConf.affiliateId ? { id: dmmConf.apiId, aff: dmmConf.affiliateId } : null;

// ---------- 取得 ----------

async function fetchAll() {
  if (!roots.length) return fail('対象のフォルダを指定してください（例: node tools/fetch-actors.js D:\\Video D:\\etc）');
  if (!api) console.warn('data/dmm.json（apiId / affiliateId）が無いため、FANZA からは取得せず、ファイル名からだけ取得します');
  fs.mkdirSync(DMM_CACHE, { recursive: true });

  const videos = [];
  for (const r of roots) walk(r, videos);
  console.log(`対象: ${roots.join(', ')}（動画 ${videos.length} 本）`);

  const rows = [];
  const known = new Set(); // 出演者として登録されている名前（ファイル名からの候補の確認に使う）
  let excluded = 0;
  for (const v of videos) {
    v.nfo = await readNfo(v.nfoPath, v.dir);
    for (const a of v.nfo?.actors || []) known.add(a);
    if (MINOR.test(v.base) || MINOR.test(v.nfo?.title || '')) {
      v.excluded = true;
      excluded++;
    }
  }

  // 1. FANZA
  let done = 0;
  for (const v of videos) {
    if (v.excluded) continue;
    v.code = productCode(v.base);
    if (api && v.code) {
      try {
        v.dmm = await findItem(v.code);
      } catch (e) {
        console.warn(`FANZA の検索に失敗: ${v.code} (${e.message})`);
      }
      for (const a of v.dmm?.actresses || []) known.add(a.name);
    }
    if (api && ++done % 50 === 0) console.log(`  ${done} / ${videos.length - excluded}`);
  }

  // 2. ファイル名（FANZA で出演者が分からなかったもの）
  for (const v of videos) {
    if (v.excluded) continue;
    const current = v.nfo?.actors || [];
    const released = v.dmm?.date || '';
    let names = [];
    let source = '';
    if (current.length) {
      // 出演者は変えないので、今の出演者の生年月日と発売日だけ調べる
      names = current;
      source = released ? '登録済み+FANZA(発売日)' : '登録済み';
    } else if (v.dmm?.actresses.length) {
      names = v.dmm.actresses.map((a) => a.name);
      source = 'FANZA';
    } else {
      names = namesFromFilename(v.base, known);
      if (names.length) source = released ? 'FANZA(発売日)+ファイル名' : 'ファイル名';
      else if (released) source = 'FANZA(発売日)';
    }
    const births = [];
    for (const n of names) births.push(await birthdate(n, v.dmm?.actresses.find((a) => a.name === n)?.id));
    // 書き込むものがあるか: 新しい出演者 / 無かった発売日 / 無かった生年月日
    const hasNew = (!current.length && names.length) || (released && !v.nfo?.premiered) || births.some((b, i) => b && !v.nfo?.actorBirthdates?.[names[i]]);
    const ok = !hasNew ? '-' : source.includes('ファイル名') && names.some((n) => !known.has(n)) ? '?' : '○';
    rows.push({
      適用: ok,
      品番: v.code || '',
      取得元: source || 'なし',
      出演者: names.join('／'),
      生年月日: births.map((b) => b || '-').join('／'),
      発売日: released,
      現在の出演者: current.join('／'),
      現在の発売日: v.nfo?.premiered || '',
      ファイル: v.path,
    });
  }

  rows.sort((a, b) => order(a) - order(b) || a.ファイル.localeCompare(b.ファイル, 'ja'));
  writeCsv(REVIEW, rows);
  const count = (f) => rows.filter(f).length;
  console.log(`
一覧を作成しました: ${REVIEW}
  FANZA で見つかった      : ${count((r) => r.取得元.includes('FANZA'))} 本
  出演者をファイル名から  : ${count((r) => r.取得元.includes('ファイル名'))} 本（うち要確認 ? ${count((r) => r.適用 === '?')} 本）
  書き込むものが無い      : ${count((r) => r.適用 === '-')} 本（見つからなかった・既に入っている）
  対象外（未成年を扱うタイトル）: ${excluded} 本
「適用」列が ○ の行が書き込まれます。? の行は確認して ○ か × に変えてください（出演者・発売日も直せます）。
確認したら: node tools/fetch-actors.js --apply`);
}

function order(r) {
  return { '?': 0, '○': 1, '×': 2, '-': 3 }[r.適用] ?? 4;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) walk(path.join(dir, e.name), out);
    } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      const base = e.name.slice(0, -path.extname(e.name).length);
      const side = path.join(dir, SIDE_DIRS.nfo, `${base}.nfo`);
      const local = path.join(dir, `${base}.nfo`);
      out.push({ path: path.join(dir, e.name), dir, base, nfoPath: fs.existsSync(side) || !fs.existsSync(local) ? side : local });
    }
  }
}

/** ファイル名の先頭の品番: "MILK-163 …" → { prefix: 'MILK', num: 163, suffix: '' } */
function productCode(base) {
  const m = /^([A-Za-z]{2,7})[-_ ]?(\d{2,6})([A-Za-z]?)(?=[\s_\-.(（]|$)/.exec(base);
  if (!m || /^fc/i.test(m[1])) return null;
  return `${m[1].toUpperCase()}-${m[2]}${m[3].toUpperCase()}`;
}

// ---------- FANZA（DMM Web API v3） ----------

async function dmm(endpoint, params) {
  const key = `${endpoint}-${Object.values(params).join('-')}`.replace(/[\\/:*?"<>|\s]/g, '_');
  const cacheFile = path.join(DMM_CACHE, `${key}.json`);
  const cached = readJson(cacheFile);
  if (cached) return cached;
  const q = new URLSearchParams({ api_id: api.id, affiliate_id: api.aff, output: 'json', ...params });
  await sleep(600); // API に負担をかけないよう間隔をあける
  const r = await fetch(`https://api.dmm.com/affiliate/v3/${endpoint}?${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  if (String(json.result?.status) !== '200') throw new Error(json.result?.message || JSON.stringify(json.result).slice(0, 200));
  fs.writeFileSync(cacheFile, JSON.stringify(json));
  return json;
}

/** 品番で作品を探す（配信 → 素人 → DVD の順）。見つからなければ null */
async function findItem(code) {
  const [, prefix, num, suffix] = /^([A-Z]+)-(\d+)([A-Z]?)$/.exec(code);
  for (const [service, floor] of [['digital', 'videoa'], ['digital', 'videoc'], ['mono', 'dvd']]) {
    const json = await dmm('ItemList', { site: 'FANZA', service, floor, keyword: code, hits: '20' });
    for (const it of json.result.items || []) {
      const m = /^([a-z]+)(\d+)([a-z]?)$/.exec(String(it.content_id).toLowerCase().replace(/^(h_\d+|\d+)/, '').replace(/^tk/, ''));
      if (!m || m[1] !== prefix.toLowerCase() || Number(m[2]) !== Number(num) || (suffix && m[3] !== suffix.toLowerCase())) continue;
      return {
        title: it.title,
        date: normalizeDate(it.date) || '',
        actresses: (it.iteminfo?.actress || []).map((a) => ({ id: a.id, name: a.name })),
      };
    }
  }
  return null;
}

const birthCache = new Map();
/** 女優の生年月日（FANZA の女優検索）。ID があれば ID で、無ければ名前が完全に一致する 1 人だけを使う */
async function birthdate(name, id) {
  if (!api) return '';
  const key = id || name;
  if (birthCache.has(key)) return birthCache.get(key);
  let b = '';
  try {
    const json = await dmm('ActressSearch', id ? { actress_id: String(id) } : { keyword: name, hits: '10' });
    const list = (json.result.actress || []).filter((a) => (id ? String(a.id) === String(id) : a.name === name));
    if (list.length === 1) b = normalizeDate(list[0].birthday) || '';
  } catch (e) {
    console.warn(`女優の検索に失敗: ${name} (${e.message})`);
  }
  birthCache.set(key, b);
  return b;
}

// ---------- ファイル名からの推定 ----------

const NAME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{2,10}$/u;
const NOT_NAME = /中出|調教|輪|姦|拘束|射精|ぶっかけ|ザーメン|精液|イラマ|アナル|絶頂|肛門|浣腸|編|版|作品|集|時間|スペシャル|ベスト|少女|美少女|娘|女優|素人|人妻|熟女|OL|ギャル|制服|痴漢|レイプ|潮|発射|連続|解禁|デビュー|引退|完全|限定|企画|特典|復刻|リマスター|無修正|動画|映像|第\d/;

/** ファイル名の末尾から出演者の名前を取り出す（取れなければ []） */
function namesFromFilename(base, known) {
  let t = base
    .replace(/^[A-Za-z]{2,7}[-_ ]?\d{2,6}[A-Za-z]?\s*/, '')
    .replace(/\s+-\s+MissAV.*$/i, '')
    .replace(/\s*[（(][^（）()]*\d[^（）()]*[）)]\s*$/, '') // "（120人150発）" など
    .trim();
  let tail;
  const paren = /[（(]([^（）()]+)[）)]\s*$/.exec(t);
  const dash = /\s-\s([^-]+)$/.exec(t);
  if (paren) tail = paren[1].split(/[、,・\s　]+/);
  else if (dash) tail = dash[1].split(/[\s　]+/);
  else {
    // 末尾の単語。その前にある単語も、登録済みの名前なら出演者とみなす
    const words = t.split(/[\s　]+/);
    tail = [words.pop()];
    while (words.length && known.has(clean(words[words.length - 1]))) tail.unshift(words.pop());
  }
  return [...new Set(tail.map(clean).filter((w) => w && (known.has(w) || (NAME.test(w) && !NOT_NAME.test(w)))))];
}

function clean(w) {
  return w
    .normalize('NFKC')
    .replace(/(リマスター|復刻版|完全版).*$/, '')
    .replace(/\d+(才|歳)$/, '')
    .replace(/^[「『【\[]|[」』】\]]$/g, '')
    .trim();
}

// ---------- 書き込み ----------

async function applyReview() {
  if (!fs.existsSync(REVIEW)) return fail(`一覧がありません。先に node tools/fetch-actors.js を実行してください: ${REVIEW}`);
  const rows = readCsv(REVIEW);
  let written = 0;
  let skipped = 0;
  for (const r of rows) {
    if (String(r.適用).trim() !== '○') continue;
    const file = r.ファイル;
    if (!file || !fs.existsSync(file)) {
      console.warn(`動画が見つかりません: ${file}`);
      skipped++;
      continue;
    }
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const side = path.join(dir, SIDE_DIRS.nfo, `${base}.nfo`);
    const local = path.join(dir, `${base}.nfo`);
    const nfoPath = fs.existsSync(side) || !fs.existsSync(local) ? side : local;
    const nfo = await readNfo(nfoPath, dir);

    const names = split(r.出演者);
    const births = split(r.生年月日).map((b) => (b === '-' ? '' : normalizeDate(b) || ''));
    const fields = {};
    const current = nfo?.actors || [];
    if (current.length) {
      // 既存の出演者は変えず、生年月日だけ足す
      const add = current.map((name) => ({ name, birthdate: births[names.indexOf(name)] || '' }));
      if (add.some((a) => a.birthdate && !nfo.actorBirthdates?.[a.name])) fields.actors = add;
    } else if (names.length) {
      fields.actors = names.map((name, i) => ({ name, birthdate: births[i] || '' }));
    }
    const released = normalizeDate(r.発売日);
    if (released && !nfo?.premiered) {
      fields.premiered = released;
      if (!nfo?.year) fields.year = released.slice(0, 4);
    }
    if (!Object.keys(fields).length) continue;
    try {
      await writeNfo(nfoPath, fields);
      written++;
    } catch (e) {
      console.warn(`書き込めません: ${nfoPath} (${e.message})`);
      skipped++;
    }
  }
  console.log(`NFO に書き込みました: ${written} 件${skipped ? `（書き込めなかったもの ${skipped} 件）` : ''}`);
}

const split = (s) => String(s || '').split('／').map((x) => x.trim()).filter(Boolean);

// ---------- CSV ----------

function writeCsv(file, rows) {
  const cols = Object.keys(rows[0] || { 適用: '' });
  const esc = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const text = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\r\n') + '\r\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '\uFEFF' + text); // Excel で文字化けしないよう BOM 付き
}

function readCsv(file) {
  const buf = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('shift_jis').decode(buf); // Excel で「CSV（カンマ区切り）」で保存した場合
  }
  text = text.replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') cell += text[++i];
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) records.push([...row, cell]);
  const [head, ...body] = records.filter((r) => r.some((c) => c !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

// ---------- その他 ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (apply) await applyReview();
else await fetchAll();
