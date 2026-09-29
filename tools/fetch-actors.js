// 動画の出演者（女優）・発売日・生年月日を取得して NFO に書き込む
//
//   node tools/fetch-actors.js [フォルダ ...]          … 取得して確認用の一覧 data/actors-review.csv を作る（NFO は変更しない）
//   node tools/fetch-actors.js --apply                 … 一覧の「適用」が ○ の行を NFO に書き込む
//   node tools/fetch-actors.js --test MILK-163         … 1 作品だけ検索して結果を表示する（確認用）
//   --no-web を付けるとネットには接続せず、ファイル名からだけ取得する
//
// 取得元（ファイル名の品番 MILK-163 などで探す）
//   1. r18.dev（FANZA の作品情報を公開しているデータベース）: 出演者・発売日
//   2. av-wiki.net（素人・企画作品の出演者のまとめサイト）: 1 で出演者が分からない作品の出演者、
//      および出演者の生年月日（女優ページから）
//   3. ファイル名: 1・2 で出演者が分からない作品は、ファイル名の末尾の名前（"… 青井いちご" "(一条みお)" など）を候補にする。
//      既に他の作品に出演者として登録されている名前なら ○、そうでなければ ?（確認が必要）にする
//   独自の品番が別の作品と同じ場合があるので、1・2 は見つかった作品のタイトルがファイル名と似ているものだけ使う
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
const web = !args.includes('--no-web');
const REVIEW = path.join(DATA_DIR, 'actors-review.csv');
const R18_CACHE = path.join(CACHE_DIR, 'r18');
const AVWIKI_CACHE = path.join(CACHE_DIR, 'avwiki');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Micol/1.0 (personal media library)';
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.trash']);
// 未成年を性的に扱うタイトル（対象外にする）
const MINOR = /小[○●◯〇]?学生|小[○●◯〇]生|中[○●◯〇]?学生|中[○●◯〇]生|(?<![A-Za-z])[JＪ][CＣSＳ](?![A-Za-z])|ロ[○●◯〇]ータ|ロリータ|幼女|女児|児童|幼穴|園児/;

const config = readJson(path.join(DATA_DIR, 'config.json')) || {};
const roots = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--test').map((a) => path.resolve(a));
if (!roots.length) roots.push(...(config.libraries || []).map((l) => l.path).filter((p) => !/animetion/i.test(p)));

// ---------- 取得 ----------

async function fetchAll() {
  if (!roots.length) return fail('対象のフォルダを指定してください（例: node tools/fetch-actors.js D:\\Video D:\\etc）');
  console.log(web ? '作品の検索: r18.dev・av-wiki.net' : 'ネットには接続せず、ファイル名からだけ取得します');
  fs.mkdirSync(R18_CACHE, { recursive: true });
  fs.mkdirSync(AVWIKI_CACHE, { recursive: true });

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

  // 1・2. 品番で検索（r18.dev → av-wiki.net）
  const sources = {
    'r18.dev': { find: findR18, failed: 0, ok: 0, off: false },
    'av-wiki': { find: findAvWiki, failed: 0, ok: 0, off: false },
  };
  const birthOf = new Map(); // 名前 -> 生年月日（av-wiki の女優ページ）
  let done = 0;
  for (const v of videos) {
    if (v.excluded) continue;
    v.code = productCode(v.base);
    if (!web || !v.code) continue;
    v.mismatch = [];
    for (const [name, src] of Object.entries(sources)) {
      if (src.off) continue;
      let found = null;
      try {
        found = await src.find(v.code);
        src.ok++;
      } catch (e) {
        console.warn(`${name} の検索に失敗: ${v.code} (${e.message})`);
        // 続けて失敗する場合（サービス停止・仕様変更など）はそのサービスを使わない
        if (++src.failed >= 10 && !src.ok) {
          src.off = true;
          console.warn(`${name} に接続できないため、以降は使いません`);
        }
      }
      // 独自の品番が別の作品と同じ場合があるので、タイトルが似ていなければ別の作品とみなす
      if (found && !sameWork(v, found)) {
        v.mismatch.push(`${name}: ${found.title}`);
        found = null;
      }
      v[name === 'r18.dev' ? 'r18' : 'wiki'] = found;
    }
    for (const a of v.r18?.actresses || []) known.add(a);
    for (const a of v.wiki?.actresses || []) {
      known.add(a.name);
      if (a.birthdate) birthOf.set(a.name, a.birthdate);
    }
    if (++done % 50 === 0) console.log(`  ${done} 本を検索`);
  }

  // 3. ファイル名（1・2 で出演者が分からなかったもの）
  for (const v of videos) {
    if (v.excluded) continue;
    const current = v.nfo?.actors || [];
    const released = v.r18?.date || v.wiki?.date || '';
    const dateFrom = released ? `+${v.r18?.date ? 'r18.dev' : 'av-wiki'}(発売日)` : '';
    let names = [];
    let source = '';
    if (current.length) {
      // 出演者は変えない（生年月日を足すために今の出演者を並べる）
      names = current;
      source = '登録済み' + dateFrom;
    } else if (v.r18?.actresses.length) {
      names = v.r18.actresses;
      source = 'r18.dev';
    } else if (v.wiki?.actresses.length) {
      names = v.wiki.actresses.map((a) => a.name);
      source = 'av-wiki' + (v.r18?.date ? '+r18.dev(発売日)' : '');
    } else {
      names = namesFromFilename(v.base, known);
      if (names.length) source = 'ファイル名' + dateFrom;
      else if (released) source = dateFrom.slice(1);
    }
    const births = names.map((n) => v.nfo?.actorBirthdates?.[n] || birthOf.get(n) || '');
    // 書き込むものがあるか: 新しい出演者 / 無かった発売日 / 無かった生年月日
    const hasNew = (!current.length && names.length) || (released && !v.nfo?.premiered) || births.some((b, i) => b && !v.nfo?.actorBirthdates?.[names[i]]);
    const ok = !hasNew ? '-' : source.startsWith('ファイル名') && names.some((n) => !known.has(n)) ? '?' : '○';
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
      備考: v.mismatch?.length ? `品番は一致したがタイトルが違うため除外（${v.mismatch.join(' / ')}）` : '',
    });
  }

  rows.sort((a, b) => order(a) - order(b) || a.ファイル.localeCompare(b.ファイル, 'ja'));
  writeCsv(REVIEW, rows);
  const count = (f) => rows.filter(f).length;
  console.log(`
一覧を作成しました: ${REVIEW}
  出演者を r18.dev から   : ${count((r) => r.取得元 === 'r18.dev')} 本
  出演者を av-wiki から   : ${count((r) => r.取得元.startsWith('av-wiki'))} 本
  出演者をファイル名から  : ${count((r) => r.取得元.startsWith('ファイル名'))} 本（うち要確認 ? ${count((r) => r.適用 === '?')} 本）
  生年月日が分かった      : ${count((r) => /\d/.test(r.生年月日))} 本
  書き込むものが無い      : ${count((r) => r.適用 === '-')} 本（見つからなかった・既に入っている）
  対象外（未成年を扱うタイトル）: ${excluded} 本
「適用」列が ○ の行が書き込まれます。? の行は確認して ○ か × に変えてください。
出演者・発売日・生年月日は直せます（「適用」が - の行を書き込みたい場合は ○ にしてください）。
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

/** ファイル名の先頭の品番: "MILK-163 …" → "MILK-163" */
function productCode(base) {
  const m = /^([A-Za-z]{2,7})[-_ ]?(\d{2,6})([A-Za-z]?)(?=[\s_\-.(（]|$)/.exec(base);
  if (!m || /^fc/i.test(m[1])) return null;
  return `${m[1].toUpperCase()}-${m[2]}${m[3].toUpperCase()}`;
}

// ---------- r18.dev ----------

/** 品番で作品を探す（dvd_id → content_id → 作品情報）。見つからなければ null */
async function findR18(code) {
  const hit = await r18(`dvd_id=${code}`);
  const cid = (Array.isArray(hit) ? hit[0] : hit)?.content_id;
  if (!cid) return null;
  const d = await r18(`combined=${cid}`);
  if (!d) return null;
  return {
    title: d.title_ja || d.title || '',
    date: normalizeDate(d.release_date) || '',
    // "希咲エマ（HARUKI、加藤はる希）" のような別名の括弧は除く
    actresses: [...new Set((d.actresses || []).map((a) => String(a.name_kanji || a.name_romaji || '').replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim()).filter(Boolean))],
  };
}

async function r18(query) {
  const cacheFile = path.join(R18_CACHE, `${query.replace(/[\\/:*?"<>|\s]/g, '_')}.json`);
  if (fs.existsSync(cacheFile)) return readJson(cacheFile);
  await sleep(1000); // 負担をかけないよう 1 秒に 1 回まで
  const r = await fetch(`https://r18.dev/videos/vod/movies/detail/-/${query}/json`, {
    headers: { 'User-Agent': 'Micol (personal media library)' },
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 404) {
    fs.writeFileSync(cacheFile, 'null');
    return null;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  fs.writeFileSync(cacheFile, JSON.stringify(json));
  return json;
}

/**
 * 見つかった作品がこの動画と同じか: 出演者名がファイル名にあるか、タイトルの 2 文字ずつの並びが 4 割以上ファイル名・NFO のタイトルに含まれる
 */
function sameWork(v, found) {
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}●○◯〇]/gu, '');
  const mine = norm(v.base) + norm(v.nfo?.title) + norm(v.nfo?.originalTitle);
  const names = found.actresses.map((a) => (typeof a === 'string' ? a : a.name));
  if (names.some((a) => a.length >= 2 && mine.includes(norm(a)))) return true;
  const t = norm(found.title);
  // a の 2 文字ずつの並びのうち、b に含まれる割合
  const ratio = (a, b) => {
    if (a.length < 4) return 0;
    let hit = 0;
    for (let i = 0; i < a.length - 1; i++) if (b.includes(a.slice(i, i + 2))) hit++;
    return hit / (a.length - 1);
  };
  // r18.dev のタイトルが長い（出演者名などが続く）場合に備えて、逆向き（ファイル名のタイトル → r18.dev）も見る
  const own = norm(v.base.replace(/^[A-Za-z]{2,7}[-_ ]?\d{2,6}[A-Za-z]?/, ''));
  return ratio(t, mine) >= 0.4 || (own.length >= 6 && ratio(own, t) >= 0.8);
}

// ---------- av-wiki.net ----------

/** 品番の作品ページ（https://av-wiki.net/mism-105/）から出演者・配信開始日を取る。無ければ null */
async function findAvWiki(code) {
  const html = await avwiki(`https://av-wiki.net/${encodeURIComponent(code.toLowerCase())}/`);
  if (!html) return null;
  const dl = {};
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const key = strip(m[1]).replace(/[：:]$/, '');
    if (key && !(key in dl)) dl[key] = m[2];
  }
  // 別の品番のページに転送された場合などは使わない
  if (dl['メーカー品番'] && strip(dl['メーカー品番']).toUpperCase() !== code) return null;
  const title = strip(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] || '')
    .replace(/^[^：]*：/, '')
    .replace(/に出てるAV女優.*$/, '');
  const actresses = [];
  for (const m of (dl['AV女優名'] || '').matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const name = strip(m[2]);
    if (name && !actresses.some((a) => a.name === name)) actresses.push({ name, birthdate: await avwikiBirth(m[1]) });
  }
  return { title, date: normalizeDate(strip(dl['配信開始日'] || dl['発売日'] || '')) || '', actresses };
}

/** 女優ページの「生年月日」（1993年6月3日 → 1993-06-03）。無ければ '' */
async function avwikiBirth(url) {
  if (!/^https:\/\/av-wiki\.net\/av-actress\//.test(url)) return '';
  const html = await avwiki(url);
  // <dt>生年月日<span class="small">：</span></dt><dd>1993年6月3日</dd>
  for (const m of (html || '').matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    if (strip(m[1]).replace(/[：:]$/, '') === '生年月日') return normalizeDate(strip(m[2])) || '';
  }
  return '';
}

async function avwiki(url) {
  const cacheFile = path.join(AVWIKI_CACHE, `${url.replace(/^https:\/\/av-wiki\.net\//, '').replace(/[\\/:*?"<>|\s%]/g, '_')}.html`);
  if (fs.existsSync(cacheFile)) {
    const c = fs.readFileSync(cacheFile, 'utf8');
    return c === '' ? null : c;
  }
  await sleep(1500); // 負担をかけないよう 1.5 秒に 1 回まで
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (r.status === 404) {
    fs.writeFileSync(cacheFile, '');
    return null;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  fs.writeFileSync(cacheFile, html);
  return html;
}

function strip(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#8211;/g, '–').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function testOne(code) {
  code = productCode(code) || code;
  fs.mkdirSync(R18_CACHE, { recursive: true });
  fs.mkdirSync(AVWIKI_CACHE, { recursive: true });
  console.log(`r18.dev で検索: ${code}`);
  const item = await findR18(code);
  console.log(item ? JSON.stringify(item, null, 2) : '見つかりませんでした');
  console.log(`av-wiki.net で検索: ${code}`);
  const wiki = await findAvWiki(code);
  console.log(wiki ? JSON.stringify(wiki, null, 2) : '見つかりませんでした');
}

// ---------- ファイル名からの推定 ----------

const NAME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{2,10}$/u;
const NOT_NAME = /中出|調教|輪|姦|拘束|射精|ぶっかけ|ザーメン|精液|イラマ|アナル|絶頂|肛門|浣腸|編|版|作品|集|時間|スペシャル|ベスト|少女|美少女|娘|女優|素人|人妻|熟女|OL|ギャル|制服|痴漢|レイプ|潮|発射|連続|解禁|デビュー|引退|完全|限定|企画|特典|復刻|リマスター|無修正|動画|映像|第\d|嘔吐|狂|奉仕|勤務|診察|医療|過激|観光|大学生|女子大生|女子校生|漏らし|喉|尻|穴|凹|吐|飲|尿|便|責|犯|崩壊|破壊|調|式|編|篇/;

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

const testIdx = args.indexOf('--test');
if (testIdx >= 0) await testOne(args[testIdx + 1] || '');
else if (apply) await applyReview();
else await fetchAll();
