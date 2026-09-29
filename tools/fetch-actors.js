// 動画の出演者（女優）・発売日・生年月日を取得して NFO に書き込む
//
//   node tools/fetch-actors.js [フォルダ ...]          … 取得して確認用の一覧 data/actors-review.csv を作る（NFO は変更しない）
//   node tools/fetch-actors.js --apply                 … 一覧の「適用」が ○ の行を NFO に書き込む
//   node tools/fetch-actors.js --births                … 一覧の ○ の行で生年月日が空の出演者を、女優名で検索して埋める
//   node tools/fetch-actors.js --titles                … 一覧の出演者が空の行を、av-wiki.net を品番・タイトルで検索して埋める
//   node tools/fetch-actors.js --romaji                … ファイル名がローマ字の女優名だけの行（TFF-109 Rena Matsumoto 1 など）を日本語名で埋める
//   node tools/fetch-actors.js --aliases               … 同じ女優の別名の候補を data/people-aliases-suggested.json に書き出す（Micol が取り込む）
//   node tools/fetch-actors.js --photos                … 女優の画像を探して、動画フォルダの .actors/名義.jpg に保存する
//   node tools/fetch-actors.js --fix-thumbs            … NFO の出演者の画像のパス（Jellyfin のフォルダなど）を .actors の画像に書き換える
//   node tools/fetch-actors.js --tff                   … TFF（Tokyo Face Fuck）の行を tokyo-face-fuck.com の出演女優リストで埋める
//   node tools/fetch-actors.js --test MILK-163         … 1 作品だけ検索して結果を表示する（確認用）
//   --no-web を付けるとネットには接続せず、ファイル名からだけ取得する
//
// 取得元（ファイル名の品番 MILK-163 などで探す）
//   1. r18.dev（FANZA の作品情報を公開しているデータベース）: 出演者・発売日
//   2. av-wiki.net（素人・企画作品の出演者のまとめサイト）: 1 で出演者が分からない作品の出演者、
//      および出演者の生年月日（女優ページから）
//   生年月日（--births）: av-wiki.net の女優ページ → Wikipedia（AV 女優の記事）→ みんなのAV（minnano-av.com）の女優ページ
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
import crypto from 'node:crypto';
import { VIDEO_EXT, SIDE_DIRS } from '../server/library.js';
import { readNfo, writeNfo, normalizeDate } from '../server/nfo.js';
import { DATA_DIR, CACHE_DIR } from '../server/store.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const web = !args.includes('--no-web');
const REVIEW = path.join(DATA_DIR, 'actors-review.csv');
const R18_CACHE = path.join(CACHE_DIR, 'r18');
const AVWIKI_CACHE = path.join(CACHE_DIR, 'avwiki');
const WIKI_CACHE = path.join(CACHE_DIR, 'wikipedia');
const MINNANO_CACHE = path.join(CACHE_DIR, 'minnano');
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
  const r = await politeFetch(`https://r18.dev/videos/vod/movies/detail/-/${query}/json`, {
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

/**
 * 品番の作品ページから出演者・配信開始日を取る。無ければ null。
 * https://av-wiki.net/mism-105/ が無い場合は品番で検索する（https://av-wiki.net/550ene-003/ のような番号付きのページ）
 */
async function findAvWiki(code) {
  const direct = await avwiki(`https://av-wiki.net/${encodeURIComponent(code.toLowerCase())}/`);
  if (direct) return parseAvWikiWork(direct, code);
  const slug = code.toLowerCase();
  for (const w of (await avwikiSearchWorks(code)).filter((w) => w.slug.replace(/^\d+/, '') === slug).slice(0, 3)) {
    const found = await parseAvWikiWork(await avwiki(w.url), code);
    if (found) return found;
  }
  return null;
}

/** ファイル名のタイトルで av-wiki.net を検索し、タイトルが十分に似ている作品を返す（品番が無い・品番で見つからない作品用） */
async function findAvWikiByTitle(v) {
  const q = titleQuery(v.base);
  // 短いタイトル（"Mizuki 1" など）は別の作品に当たりやすいので検索しない
  const own = v.base.replace(/^[A-Za-z]{2,7}[-_ ]?\d{2,6}[A-Za-z]?/, '').normalize('NFKC').replace(/[\s\p{P}\p{S}\d]/gu, '');
  // ローマ字だけのタイトル（"Rena Matsumoto" など）も別の作品に当たりやすいので、漢字・かなを含むものだけ
  if (q.length < 6 || own.length < 10 || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(own)) return null;
  for (const w of (await avwikiSearchWorks(q)).slice(0, 3)) {
    const found = await parseAvWikiWork(await avwiki(w.url));
    if (found && sameWork(v, found) && titleRatio(v.base, found.title) >= 0.6) return { ...found, url: w.url };
  }
  return null;
}

/** 検索に使うタイトル: 品番と【】「」などの括弧書きを除き、いちばん長い部分（30 文字まで） */
function titleQuery(base) {
  const t = base
    .replace(/^[A-Za-z]{2,7}[-_ ]?\d{2,6}[A-Za-z]?\s*/, '')
    .replace(/[【\[「『][^】\]」』]*[】\]」』]/g, ' ')
    .replace(/[（(][^（）()]*[）)]/g, ' ');
  const parts = t.split(/[\s　]+/).filter(Boolean).sort((a, b) => b.length - a.length);
  return (parts[0] || '').slice(0, 30);
}

/** ファイル名のタイトル（品番を除く）の 2 文字ずつの並びのうち、found のタイトルに含まれる割合 */
function titleRatio(base, title) {
  const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}●○◯〇]/gu, '');
  const a = norm(base.replace(/^[A-Za-z]{2,7}[-_ ]?\d{2,6}[A-Za-z]?/, ''));
  const b = norm(title);
  if (a.length < 4) return 0;
  let hit = 0;
  for (let i = 0; i < a.length - 1; i++) if (b.includes(a.slice(i, i + 2))) hit++;
  return hit / (a.length - 1);
}

/** av-wiki.net の検索結果の作品ページ */
async function avwikiSearchWorks(query) {
  const html = await avwiki(`https://av-wiki.net/?s=${encodeURIComponent(query)}`);
  const out = [];
  for (const m of (html || '').matchAll(/<a[^>]*href="(https:\/\/av-wiki\.net\/([a-z0-9-]+)\/)"/g)) {
    if (/^(av-actress|category|tag|page|author|wp-|feed)/.test(m[2]) || !/\d/.test(m[2])) continue;
    if (!out.some((o) => o.url === m[1])) out.push({ url: m[1], slug: m[2] });
  }
  return out;
}

/** 作品ページの内容。code を指定した場合、メーカー品番が違えば null */
async function parseAvWikiWork(html, code = null) {
  if (!html) return null;
  const dl = {};
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const key = strip(m[1]).replace(/[：:]$/, '');
    if (key && !(key in dl)) dl[key] = m[2];
  }
  // 別の品番のページに転送された場合などは使わない
  // 配信サイトの番号が付いた品番（550ENE-003）も同じとみなす
  if (code && dl['メーカー品番'] && strip(dl['メーカー品番']).toUpperCase().replace(/^\d+/, '') !== code) return null;
  const title = strip(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] || '')
    .replace(/^[^：]*：/, '')
    .replace(/に出てるAV女優.*$/, '');
  const actresses = [];
  for (const m of (dl['AV女優名'] || '').matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const name = strip(m[2]);
    if (name && !actresses.some((a) => a.name === name)) actresses.push({ name, birthdate: await avwikiBirth(m[1]) });
  }
  return { title, date: normalizeDate(strip(dl['配信開始日'] || dl['発売日'] || '')) || '', actresses, code: strip(dl['メーカー品番'] || '') };
}

// ---------- 出演者が空の行を av-wiki で埋める（--titles） ----------

async function fillFromTitles() {
  if (!fs.existsSync(REVIEW)) return fail(`一覧がありません: ${REVIEW}`);
  fs.mkdirSync(AVWIKI_CACHE, { recursive: true });
  const rows = readCsv(REVIEW);
  const targets = rows.filter((r) => !split(r.出演者).length && r.ファイル && fs.existsSync(r.ファイル));
  console.log(`出演者が空の行: ${targets.length} 行を av-wiki.net で検索します`);
  let byCode = 0;
  let byTitle = 0;
  let done = 0;
  for (const r of targets) {
    const base = path.basename(r.ファイル, path.extname(r.ファイル));
    const dir = path.dirname(r.ファイル);
    if (MINOR.test(base)) continue;
    const side = path.join(dir, SIDE_DIRS.nfo, `${base}.nfo`);
    const v = { base, nfo: await readNfo(fs.existsSync(side) ? side : path.join(dir, `${base}.nfo`), dir) };
    if (MINOR.test(v.nfo?.title || '')) continue;
    const code = productCode(base);
    let found = null;
    let how = '';
    try {
      if (code) {
        found = await findAvWiki(code);
        if (found && !sameWork(v, found)) found = null;
        if (found) how = 'av-wiki(品番)';
      }
      if (!found || !found.actresses.length) {
        const t = await findAvWikiByTitle(v);
        if (t?.actresses.length) {
          found = t;
          how = code && t.code.toUpperCase().replace(/^\d+/, '') === code ? 'av-wiki(品番)' : 'av-wiki(タイトル)';
        }
      }
    } catch (e) {
      console.warn(`av-wiki の検索に失敗: ${base} (${e.message})`);
    }
    if (++done % 50 === 0) console.log(`  ${done} / ${targets.length} 行を検索`);
    if (!found?.actresses.length) continue;
    r.出演者 = found.actresses.map((a) => a.name).join('／');
    r.生年月日 = found.actresses.map((a) => a.birthdate || '-').join('／');
    if (!r.発売日 && found.date && !r.現在の発売日) r.発売日 = found.date;
    r.取得元 = how;
    // 品番で確かめられたものは ○、タイトルだけで見つけたものは ?（確認が必要）
    r.適用 = how === 'av-wiki(品番)' ? '○' : '?';
    r.備考 = [r.備考, `av-wiki: ${found.title}`].filter(Boolean).join(' / ');
    if (how === 'av-wiki(品番)') byCode++;
    else byTitle++;
  }
  writeCsv(REVIEW, rows);
  console.log(`
出演者を埋めました: 品番で ${byCode} 行（○）、タイトルで ${byTitle} 行（? 要確認）
一覧: ${REVIEW}`);
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
  const cacheFile = path.join(AVWIKI_CACHE, cacheName(url.replace(/^https:\/\/av-wiki\.net\//, '').replace(/[\\/:*?"<>|\s%]/g, '_'), '.html'));
  if (fs.existsSync(cacheFile)) {
    const c = fs.readFileSync(cacheFile, 'utf8');
    return c === '' ? null : c;
  }
  await sleep(1500); // 負担をかけないよう 1.5 秒に 1 回まで
  const r = await politeFetch(url, { headers: { 'User-Agent': UA } });
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
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#8211;/g, '–').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
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

// ---------- 生年月日を女優名で探す（--births） ----------
//
// 名前ごとに次の順で探す（見つかった名前と取得元は一覧の「備考」に書く）
//   1. 保存済みの av-wiki の女優ページ（名前・別名義が一致）
//   2. 別名（r18.dev の "希咲エマ（HARUKI、加藤はる希）" など）で 1 を探す
//   3. av-wiki を名前で検索: 名前が一致する女優ページ、または別名義にその名前がある女優ページ
//   4. Wikipedia: その名前の記事（転送を含む）
//   5. Wikipedia を検索: AV 女優の記事で、プロフィール欄か冒頭にその名前（旧芸名など）があるもの
//   6. みんなのAV: 五十音の女優一覧（初回だけ全ページを読んで保存）で名前が一致する女優が 1 人だけなら、その女優ページ

async function fillBirthdates() {
  if (!fs.existsSync(REVIEW)) return fail(`一覧がありません: ${REVIEW}`);
  fs.mkdirSync(AVWIKI_CACHE, { recursive: true });
  fs.mkdirSync(WIKI_CACHE, { recursive: true });
  fs.mkdirSync(MINNANO_CACHE, { recursive: true });
  const rows = readCsv(REVIEW);
  const profiles = avwikiKnownProfiles();
  const aliases = r18Aliases();
  const cache = new Map();

  const fromProfiles = (name) => {
    const p = profiles.find((x) => x.birth && (x.name === name || x.aliases.includes(name)));
    return p ? { birth: p.birth, from: p.name === name ? 'av-wiki' : `av-wiki(${p.name} の別名義)` } : null;
  };
  const steps = [
    async (name) => fromProfiles(name),
    async (name) => {
      for (const a of aliases.get(name) || []) {
        const r = fromProfiles(a);
        if (r) return { ...r, from: `${r.from}・別名 ${a}` };
      }
      return null;
    },
    async (name) => {
      const p = await avwikiSearchProfile(name);
      if (p) profiles.push(p);
      return p?.birth ? { birth: p.birth, from: p.name === name ? 'av-wiki' : `av-wiki(${p.name} の別名義)` } : null;
    },
    async (name) => {
      for (const n of [name, ...(aliases.get(name) || [])]) {
        const b = birthFromWikitext(await wikipediaPage(n), n);
        if (b) return { birth: b, from: n === name ? 'Wikipedia' : `Wikipedia(別名 ${n})` };
      }
      return null;
    },
    async (name) => {
      const hit = await wikipediaSearch(name);
      return hit ? { birth: hit.birth, from: `Wikipedia(${hit.title})` } : null;
    },
    async (name) => {
      for (const n of [name, ...(aliases.get(name) || [])]) {
        const b = await minnanoBirth(n);
        if (b) return { birth: b, from: n === name ? 'みんなのAV' : `みんなのAV(別名 ${n})` };
      }
      return null;
    },
  ];
  const find = async (name) => {
    if (!cache.has(name)) {
      let r = null;
      for (const step of steps) {
        try {
          r = await step(name);
        } catch (e) {
          console.warn(`検索に失敗: ${name} (${e.message})`);
        }
        if (r) break;
      }
      cache.set(name, r);
      if (cache.size % 25 === 0) console.log(`  ${cache.size} 人を検索`);
    }
    return cache.get(name);
  };

  let filled = 0;
  const notFound = new Set();
  for (const r of rows) {
    if (String(r.適用).trim() !== '○') continue;
    const names = split(r.出演者);
    const births = String(r.生年月日 || '').split('／').map((b) => b.trim());
    const from = [];
    let changed = false;
    for (let i = 0; i < names.length; i++) {
      if (births[i] && births[i] !== '-') continue;
      const hit = await find(names[i]);
      if (hit) {
        births[i] = hit.birth;
        from.push(`${names[i]}=${hit.from}`);
        changed = true;
        filled++;
      } else {
        births[i] = '-';
        notFound.add(names[i]);
      }
    }
    if (changed) {
      r.生年月日 = names.map((_, i) => births[i] || '-').join('／');
      r.備考 = [r.備考, `生年月日: ${from.join(', ')}`].filter(Boolean).join(' / ');
    }
  }
  writeCsv(REVIEW, rows);
  console.log(`
生年月日を埋めました: ${filled} 件（${cache.size} 人を検索、見つからなかった ${notFound.size} 人）
一覧: ${REVIEW}（取得元は「備考」列）`);
  if (notFound.size) console.log(`見つからなかった: ${[...notFound].join('、')}`);
}

/** r18.dev の出演者名の括弧書きから 名前 -> [別名] を作る（"希咲エマ（HARUKI、加藤はる希）"） */
function r18Aliases() {
  const map = new Map();
  const add = (a, b) => {
    if (a === b) return;
    if (!map.has(a)) map.set(a, []);
    if (!map.get(a).includes(b)) map.get(a).push(b);
  };
  // tokyo-face-fuck.com の別名（--tff で保存）
  for (const [name, list] of Object.entries(readJson(path.join(CACHE_DIR, 'tff', 'aliases.json')) || {})) {
    for (const x of [name, ...list]) for (const y of [name, ...list]) add(x, y);
  }
  if (!fs.existsSync(R18_CACHE)) return map;
  for (const f of fs.readdirSync(R18_CACHE)) {
    if (!f.startsWith('combined=')) continue;
    for (const a of readJson(path.join(R18_CACHE, f))?.actresses || []) {
      const m = /^(.+?)\s*[（(]([^（）()]+)[）)]\s*$/.exec(String(a.name_kanji || ''));
      if (!m) continue;
      const group = [m[1].trim(), ...m[2].split(/[、,，]/).map((s) => s.trim()).filter(Boolean)];
      for (const x of group) for (const y of group) add(x, y);
    }
  }
  return map;
}

/** 保存済みの av-wiki の女優ページのプロフィール一覧 */
function avwikiKnownProfiles() {
  const list = [];
  for (const f of fs.readdirSync(AVWIKI_CACHE)) {
    if (!f.startsWith('av-actress_')) continue;
    const p = avwikiProfile(fs.readFileSync(path.join(AVWIKI_CACHE, f), 'utf8'));
    if (p.name) list.push(p);
  }
  return list;
}

/** 女優ページのプロフィール: { name: '長谷川まや', aliases: [...], birth: '1993-06-03' } */
function avwikiProfile(html) {
  const out = { name: '', aliases: [], birth: '' };
  for (const m of String(html || '').matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
    const key = strip(m[1]).replace(/[：:]$/, '');
    const val = strip(m[2]);
    if (key === 'AV女優名' && !out.name) out.name = val.replace(/[（(].*$/, '').trim();
    if (key === '別名義' && !out.aliases.length) {
      out.aliases = val
        .split(/[、,，/／]/)
        .map((s) => s.replace(/[（(][^（）()]*[）)]/g, '').replace(/\s*[–-]\s*[a-z][a-z -]*$/i, '').trim())
        .filter((s) => s && !/^([–—―\-\s]|&#\d+;)+$/.test(s) && s !== 'など');
    }
    if (key === '生年月日' && !out.birth) out.birth = normalizeDate(val) || '';
  }
  return out;
}

/**
 * av-wiki.net を名前で検索し、名前が一致するか、別名義にその名前がある女優ページのプロフィールを返す。
 * 候補が複数に当てはまる場合は使わない
 */
async function avwikiSearchProfile(name) {
  const html = await avwiki(`https://av-wiki.net/?s=${encodeURIComponent(name)}`);
  const urls = [];
  for (const m of (html || '').matchAll(/<a[^>]*href="(https:\/\/av-wiki\.net\/av-actress\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (!urls.some((u) => u.url === m[1])) urls.push({ url: m[1], text: strip(m[2]) });
  }
  const exact = urls.filter((u) => u.text === name);
  const candidates = exact.length ? exact : urls.slice(0, 5);
  const hits = [];
  for (const u of candidates) {
    const p = avwikiProfile(await avwiki(u.url));
    if (p.name === name || p.aliases.includes(name)) hits.push(p);
  }
  return hits.length === 1 ? hits[0] : null;
}

async function wikipediaApi(params) {
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const cacheFile = path.join(WIKI_CACHE, `${Object.values(params).join('_').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 150)}.json`);
  const cached = readJson(cacheFile);
  if (cached) return cached;
  await sleep(1000);
  const r = await politeFetch(`https://ja.wikipedia.org/w/api.php?${q}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  fs.writeFileSync(cacheFile, JSON.stringify(json));
  return json;
}

/** Wikipedia の記事の本文（転送をたどる）。無ければ '' */
async function wikipediaPage(title) {
  const cacheFile = path.join(WIKI_CACHE, `${title.replace(/[\\/:*?"<>|\s]/g, '_')}.json`);
  let json = readJson(cacheFile);
  if (!json) {
    json = await wikipediaApi({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title, redirects: '1' });
    fs.writeFileSync(cacheFile, JSON.stringify(json));
  }
  return json.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content || '';
}

/**
 * Wikipedia を検索し、AV 女優の記事のうち、プロフィール欄か冒頭（旧芸名など）に name があるものの生年月日を返す。
 * 当てはまる記事が複数ある場合は使わない
 */
async function wikipediaSearch(name) {
  const res = await wikipediaApi({ action: 'query', list: 'search', srsearch: `"${name}" AV女優`, srlimit: '5', srnamespace: '0' });
  const hits = [];
  for (const s of res.query?.search || []) {
    if (/一覧|リスト|受賞|アワード/.test(s.title)) continue;
    const text = await wikipediaPage(s.title);
    const infobox = /\{\{\s*AV女優[\s\S]*?\n\}\}/.exec(text)?.[0] || '';
    const lead = text.slice(infobox ? text.indexOf(infobox) + infobox.length : 0).slice(0, 800);
    if (!infobox.includes(name) && !lead.includes(name)) continue;
    const birth = birthFromWikitext(text, name);
    if (birth && !hits.some((h) => h.title === s.title)) hits.push({ title: s.title, birth });
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Wikipedia の記事の本文から生年月日を読む。
 * 同名の別人を避けるため、AV 女優の記事（本文に「AV女優」を含み、曖昧さ回避ではない）だけを使う
 */
function birthFromWikitext(text) {
  if (!text || !/AV女優/.test(text) || /\{\{\s*(Aimai|曖昧さ回避|人名の曖昧さ回避)/i.test(text)) return '';
  // | 生年月日 = {{生年月日と年齢|1990|5|1}} / 1990年5月1日
  const line = /\|\s*生年月日\s*=\s*([^\n]*)/.exec(text)?.[1] || '';
  const tpl = /\{\{\s*生年月日と年齢\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/.exec(line);
  if (tpl) return normalizeDate(`${tpl[1]}-${tpl[2]}-${tpl[3]}`) || '';
  const plain = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(line.replace(/\[\[|\]\]/g, ''));
  if (plain) return normalizeDate(`${plain[1]}-${plain[2]}-${plain[3]}`) || '';
  // {{AV女優}} の基礎情報: | 生年 = 1992 | 生月 = 11 | 生日 = 12（年だけ・年月だけの場合もある）
  const field = (k) => new RegExp(`\\|\\s*${k}\\s*=\\s*(\\d{1,4})\\s*(?=[|\\n}<])`).exec(text)?.[1];
  const [y, m, d] = [field('生年'), field('生月'), field('生日')];
  if (!y || y.length !== 4) return '';
  return normalizeDate([y, m, m && d].filter(Boolean).join('-')) || '';
}

// ---------- みんなのAV（minnano-av.com） ----------

const MINNANO = 'https://www.minnano-av.com/';
const GOJUON = 'a,i,u,e,o,ka,ki,ku,ke,ko,sa,shi,su,se,so,ta,chi,tsu,te,to,na,ni,nu,ne,no,ha,hi,hu,he,ho,ma,mi,mu,me,mo,ya,yu,yo,ra,ri,ru,re,ro,wa,wo,n'.split(',');
let minnanoNames = null;

/** 五十音の女優一覧（サイトマップに載っているページ）を全部読み、名前 -> [女優ページの ID] を作る（保存して再利用） */
async function minnanoIndex() {
  if (minnanoNames) return minnanoNames;
  const indexFile = path.join(MINNANO_CACHE, 'index.json');
  const saved = readJson(indexFile);
  // 30 日以内に作ったものは再利用する
  if (saved && Date.now() - saved.created < 30 * 86400000) return (minnanoNames = new Map(Object.entries(saved.names)));
  console.log('みんなのAV の女優一覧を読み込んでいます（初回のみ・30 分ほどかかります）');
  const names = new Map();
  let pages = 0;
  for (const g of GOJUON) {
    for (let page = 1; page <= 200; page++) {
      const html = await minnanoGet(`actress_list.php?gojuon=${g}${page > 1 ? `&page=${page}` : ''}`);
      if (!html) break;
      let n = 0;
      for (const m of html.matchAll(/"name":\s*"([^"]+)",\s*"url":\s*"https:\/\/www\.minnano-av\.com\/actress(\d+)\.html"/g)) {
        const name = m[1].trim();
        if (!names.has(name)) names.set(name, []);
        if (!names.get(name).includes(m[2])) names.get(name).push(m[2]);
        n++;
      }
      if (++pages % 50 === 0) console.log(`  一覧 ${pages} ページ（${names.size} 人）`);
      if (!n || !/rel="next"/.test(html)) break;
    }
  }
  fs.writeFileSync(indexFile, JSON.stringify({ created: Date.now(), names: Object.fromEntries(names) }));
  console.log(`  みんなのAV の女優一覧: ${names.size} 人`);
  return (minnanoNames = names);
}

/** 名前が一致する女優が 1 人だけなら、その女優ページの生年月日（"birthDate": "2003-10-30"） */
async function minnanoBirth(name) {
  const names = await minnanoIndex();
  const ids = names.get(name) || names.get(name.normalize('NFKC').replace(/\s+/g, '')) || [];
  if (ids.length !== 1) return '';
  const html = await minnanoGet(`actress${ids[0]}.html`);
  const b = /"birthDate"\s*:\s*"([^"]+)"/.exec(html || '')?.[1];
  return (b && normalizeDate(b)) || '';
}

async function minnanoGet(rel) {
  const cacheFile = path.join(MINNANO_CACHE, `${rel.replace(/[\\/:*?"<>|&=]/g, '_')}.html`);
  if (fs.existsSync(cacheFile)) {
    const c = fs.readFileSync(cacheFile, 'utf8');
    return c === '' ? null : c;
  }
  await sleep(2000); // 負担をかけないよう 2 秒に 1 回まで
  const r = await politeFetch(MINNANO + rel, { headers: { 'User-Agent': UA } });
  if (r.status === 404) {
    fs.writeFileSync(cacheFile, '');
    return null;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  fs.writeFileSync(cacheFile, html);
  return html;
}

// ---------- ローマ字名から日本語名を探す（--romaji） ----------
//
// "TFF-109 Rena Matsumoto 1" のように、ファイル名にローマ字の女優名だけがある作品用。
// av-wiki.net の女優ページのアドレス（/av-actress/姓-名/）が名前のローマ字なので、
// 「名 姓」「姓 名」の両方で開き、見つかれば日本語名と生年月日を入れる（○）。
// 見つからなければローマ字名のまま入れる（? 要確認）

async function fillFromRomaji() {
  if (!fs.existsSync(REVIEW)) return fail(`一覧がありません: ${REVIEW}`);
  fs.mkdirSync(AVWIKI_CACHE, { recursive: true });
  const rows = readCsv(REVIEW);
  const cache = new Map();
  let found = 0;
  let romaji = 0;
  for (const r of rows) {
    if (split(r.出演者).length || !r.ファイル) continue;
    const base = path.basename(r.ファイル, path.extname(r.ファイル));
    // 品番のあとがローマ字の 2 語（+ パート番号）だけのもの
    const m = /^[A-Za-z]{2,7}[-_ ]?\d{2,6}[A-Za-z]?\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)(?:\s+\d+)?$/.exec(base);
    if (!m) continue;
    const [given, family] = [m[1], m[2]];
    const key = `${given} ${family}`;
    if (!cache.has(key)) {
      let p = null;
      for (const slug of [`${family}-${given}`, `${given}-${family}`].map((s) => s.toLowerCase())) {
        try {
          const html = await avwiki(`https://av-wiki.net/av-actress/${slug}/`);
          const prof = html && avwikiProfile(html);
          if (prof?.name) {
            p = prof;
            break;
          }
        } catch (e) {
          console.warn(`av-wiki の検索に失敗: ${key} (${e.message})`);
        }
      }
      cache.set(key, p);
    }
    const p = cache.get(key);
    if (p) {
      r.出演者 = p.name;
      r.生年月日 = p.birth || '-';
      r.取得元 = 'av-wiki(ローマ字名)';
      r.適用 = '○';
      r.備考 = [r.備考, `${key} → ${p.name}`].filter(Boolean).join(' / ');
      found++;
    } else {
      r.出演者 = key;
      r.生年月日 = '-';
      r.取得元 = 'ファイル名(ローマ字)';
      r.適用 = '?';
      romaji++;
    }
  }
  writeCsv(REVIEW, rows);
  const names = [...cache.values()];
  console.log(`
ローマ字名の女優: ${cache.size} 人（日本語名が見つかった ${names.filter(Boolean).length} 人）
  日本語名で埋めた行: ${found} 行（○）
  ローマ字名のまま入れた行: ${romaji} 行（? 要確認）
一覧: ${REVIEW}`);
}

// ---------- Tokyo Face Fuck（--tff） ----------
//
// tokyo-face-fuck.com の出演女優リストの女優ページに、日本語名・別名と作品番号（099_MisakiAkari → TFF-099）がある。
// ファイル名の TFF-099 からその女優を入れる（作品番号で結び付くので ○）。別名は --births で生年月日を探すときに使う

const TFF_CACHE = path.join(CACHE_DIR, 'tff');

async function tffGet(url) {
  const cacheFile = path.join(TFF_CACHE, cacheName(url.replace(/^https:\/\/tokyo-face-fuck\.com\//, '').replace(/[\\/:*?"<>|\s]/g, '_'), '.html'));
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8');
  await sleep(2000);
  const r = await politeFetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  fs.writeFileSync(cacheFile, html);
  return html;
}

/** 作品番号 -> { name, kana, aliases } と、名前 -> [別名] */
async function tffIndex() {
  fs.mkdirSync(TFF_CACHE, { recursive: true });
  const list = await tffGet('https://tokyo-face-fuck.com/actress/');
  const pages = [...new Set([...list.matchAll(/href="(?:\.\.\/)?actress\/([a-z0-9-]+\.html)"/g)].map((m) => m[1]))];
  const works = new Map();
  const aliases = {};
  for (const page of pages) {
    const html = await tffGet(`https://tokyo-face-fuck.com/actress/${page}`);
    const m = /名前：([^（<]+)（([^）<]*)）/.exec(html);
    if (!m) continue;
    const name = m[1].trim();
    const alias = (/別名：([^<]*)</.exec(html)?.[1] || '')
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter((s) => s && s !== 'など');
    if (alias.length) aliases[name] = alias;
    for (const w of html.matchAll(/>(\d{3})_[A-Za-z]+</g)) {
      const code = `TFF-${w[1]}`;
      if (!works.has(code)) works.set(code, []);
      if (!works.get(code).some((x) => x.name === name)) works.get(code).push({ name, kana: m[2].trim(), aliases: alias });
    }
  }
  fs.writeFileSync(path.join(TFF_CACHE, 'aliases.json'), JSON.stringify(aliases, null, 1));
  console.log(`tokyo-face-fuck.com: 女優 ${pages.length} 人・作品 ${works.size} 本`);
  return works;
}

async function fillFromTff() {
  if (!fs.existsSync(REVIEW)) return fail(`一覧がありません: ${REVIEW}`);
  const works = await tffIndex();
  const rows = readCsv(REVIEW);
  const profiles = avwikiKnownProfiles();
  let filled = 0;
  const missing = new Set();
  for (const r of rows) {
    const base = path.basename(r.ファイル || '', path.extname(r.ファイル || ''));
    const m = /^TFF[-_ ]?(\d{3})\b/i.exec(base);
    if (!m) continue;
    const list = works.get(`TFF-${m[1]}`);
    if (!list) {
      missing.add(`TFF-${m[1]}`);
      continue;
    }
    // 生年月日: 一覧に既にある値 → 保存済みの av-wiki の女優ページ（名前・別名義） → 空（--births で探す）
    const oldNames = split(r.出演者);
    const oldBirths = String(r.生年月日 || '').split('／');
    const births = list.map((a) => {
      const i = oldNames.indexOf(a.name);
      if (i >= 0 && /\d/.test(oldBirths[i] || '')) return oldBirths[i];
      const p = profiles.find((x) => x.birth && [a.name, ...a.aliases].some((n) => x.name === n || x.aliases.includes(n)));
      return p?.birth || '-';
    });
    r.出演者 = list.map((a) => a.name).join('／');
    r.生年月日 = births.join('／');
    r.取得元 = 'tokyo-face-fuck.com';
    r.適用 = '○';
    r.備考 = list.map((a) => `${a.name}（${a.kana}）${a.aliases.length ? ` 別名: ${a.aliases.join('、')}` : ''}`).join(' / ');
    filled++;
  }
  writeCsv(REVIEW, rows);
  console.log(`
TFF の行を埋めました: ${filled} 行（○）${missing.size ? `\n作品番号が見つからなかった: ${[...missing].join('、')}` : ''}
一覧: ${REVIEW}（生年月日が - の出演者は --births で探せます）`);
}

// ---------- 別名の候補（--aliases） ----------
//
// 取得済みのデータ（キャッシュ）から「同じ女優の名義」の組を集め、どの情報源が一致しているかを書き出す。
// Micol はこのファイルを読み、2 か所以上の情報源で一致した組を自動で同じ女優にまとめる（残りは画面で確認）
//   r18.dev: "希咲エマ（HARUKI、加藤はる希）"  av-wiki: 別名義  tokyo-face-fuck.com: 別名  Wikipedia: {{AV女優}} の 別名

async function suggestAliases() {
  const pairs = new Map(); // 'a\tb' -> { names: [a, b], sources: Set }
  const addGroup = (names, source) => {
    const list = [...new Set(names.map((n) => String(n || '').trim()).filter((n) => n.length >= 2 && !/^([–—―\-\s]|&#\d+;)+$/.test(n)))];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const names = [list[i], list[j]].sort();
        const key = names.join('\t');
        if (!pairs.has(key)) pairs.set(key, { names, sources: new Set() });
        pairs.get(key).sources.add(source);
      }
    }
  };

  // r18.dev
  if (fs.existsSync(R18_CACHE)) {
    for (const f of fs.readdirSync(R18_CACHE)) {
      if (!f.startsWith('combined=')) continue;
      for (const a of readJson(path.join(R18_CACHE, f))?.actresses || []) {
        const m = /^(.+?)\s*[（(]([^（）()]+)[）)]\s*$/.exec(String(a.name_kanji || ''));
        if (m) addGroup([m[1], ...m[2].split(/[、,，]/)], 'r18.dev');
      }
    }
  }
  // av-wiki
  if (fs.existsSync(AVWIKI_CACHE)) {
    for (const p of avwikiKnownProfiles()) if (p.aliases.length) addGroup([p.name, ...p.aliases], 'av-wiki');
  }
  // tokyo-face-fuck.com
  for (const [name, list] of Object.entries(readJson(path.join(CACHE_DIR, 'tff', 'aliases.json')) || {})) addGroup([name, ...list], 'tokyo-face-fuck.com');
  // Wikipedia（AV 女優の記事の 別名 欄）
  if (fs.existsSync(WIKI_CACHE)) {
    for (const f of fs.readdirSync(WIKI_CACHE)) {
      const page = readJson(path.join(WIKI_CACHE, f))?.query?.pages?.[0];
      const text = page?.revisions?.[0]?.slots?.main?.content || '';
      const infobox = /\{\{\s*AV女優[\s\S]*?\n\}\}/.exec(text)?.[0];
      if (!infobox || /\{\{\s*(Aimai|曖昧さ回避)/i.test(text)) continue;
      const name = (/\|\s*名前\s*=\s*([^\n|]*)/.exec(infobox)?.[1] || page.title).replace(/\s+/g, '').replace(/[（(].*$/, '');
      const alias = /\|\s*別名\s*=\s*([^\n]*)/.exec(infobox)?.[1] || '';
      const list = alias
        .replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, '')
        .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/<br\s*\/?>/g, '、')
        .split(/[、,，/／]/)
        .map((s) => s.replace(/[（(][^（）()]*[）)]/g, '').replace(/\s+/g, '').trim())
        .filter((s) => s && !/[={}<>]/.test(s));
      if (name && list.length) addGroup([name, ...list], 'Wikipedia');
    }
  }

  // ライブラリの出演者（どちらかの名義がライブラリにある組だけ残す）
  const videos = [];
  for (const r of roots) walk(r, videos);
  const library = new Set();
  for (const v of videos) for (const a of (await readNfo(v.nfoPath, v.dir))?.actors || []) library.add(a);
  const out = [...pairs.values()]
    .filter((p) => p.names.some((n) => library.has(n)))
    .map((p) => ({ names: p.names, sources: [...p.sources].sort() }))
    .sort((a, b) => b.sources.length - a.sources.length || a.names[0].localeCompare(b.names[0], 'ja'));
  const file = path.join(DATA_DIR, 'people-aliases-suggested.json');
  fs.writeFileSync(file, JSON.stringify({ created: Date.now(), pairs: out }, null, 1));
  console.log(`別名の候補: ${out.length} 組（2 か所以上で一致 ${out.filter((p) => p.sources.length >= 2).length} 組・自動で取り込み）
${file}
Micol の女優一覧を開くと取り込まれます（1 か所だけのものは「別名の候補」で確認できます）`);
}

// ---------- 女優の画像（--photos） ----------
//
// ライブラリの NFO の出演者ごとに画像を用意し、その作品の動画フォルダの .actors/名義.jpg に保存する（Kodi 形式。Micol はこれを優先して表示する）。
//   1. その作品の NFO の <actor><thumb> にある画像（URL ならダウンロード、ローカルのファイルならコピー）
//   2. 同じ女優（別名を含む）の他の作品の NFO にある画像
//   3. FANZA の女優画像（r18.dev の image_url → https://pics.dmm.co.jp/mono/actjpgs/…）
//   4. みんなのAV の女優ページの写真（名前が一致する女優が 1 人だけの場合）
// 既に .actors に画像がある名義は変更しない。NFO の <thumb> の記述もそのまま残す

const PHOTO_CACHE = path.join(CACHE_DIR, 'photos');
const PHOTO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

async function fetchPhotos() {
  fs.mkdirSync(PHOTO_CACHE, { recursive: true });
  fs.mkdirSync(MINNANO_CACHE, { recursive: true });
  // ライブラリの出演者: 名義 -> Map(動画フォルダ -> その作品の NFO の <thumb> の画像 | null)
  const videos = [];
  for (const r of roots) walk(r, videos);
  const folders = new Map();
  for (const v of videos) {
    const nfo = await readNfo(v.nfoPath, v.dir);
    for (const name of nfo?.actors || []) {
      if (!folders.has(name)) folders.set(name, new Map());
      const dirs = folders.get(name);
      if (!dirs.get(v.dir)) dirs.set(v.dir, nfo.actorThumbSources?.[name] || null);
    }
  }
  // 別名のグループ（Micol の data/aliases.json）
  const groups = readJson(path.join(DATA_DIR, 'aliases.json'))?.groups || [];
  const groupOf = (name) => groups.find((g) => g.includes(name)) || [name];

  // r18.dev: 名前 -> 画像ファイル名
  const r18Images = new Map();
  if (fs.existsSync(R18_CACHE)) {
    for (const f of fs.readdirSync(R18_CACHE)) {
      if (!f.startsWith('combined=')) continue;
      for (const a of readJson(path.join(R18_CACHE, f))?.actresses || []) {
        if (!a.image_url || /now_printing|noimage/i.test(a.image_url)) continue;
        const m = /^(.+?)\s*[（(]([^（）()]+)[）)]\s*$/.exec(String(a.name_kanji || ''));
        for (const n of m ? [m[1], ...m[2].split(/[、,，]/)] : [a.name_kanji]) if (n?.trim()) r18Images.set(n.trim(), a.image_url);
      }
    }
  }

  const needs = (name, dir) => !/[\\/:*?"<>|]/.test(name) && !['.jpg', '.jpeg', '.png', '.webp'].some((ext) => fs.existsSync(path.join(dir, '.actors', name + ext)) || fs.existsSync(path.join(dir, '.actors', name.replace(/ /g, '_') + ext)));
  const todo = [...folders].filter(([name, dirs]) => [...dirs.keys()].some((d) => needs(name, d)));
  console.log(`女優の画像を用意します: ${todo.length} 名義（${folders.size} 名義のうち、.actors に画像が無い作品があるもの）`);

  // NFO の <thumb> の画像（URL・ローカル）: 元の画像 -> 取り込んだ画像
  const own = new Map();
  const ownPhoto = async (src) => {
    if (!own.has(src)) {
      let p = null;
      try {
        p = /^https?:/i.test(src) ? await downloadPhoto(src, 'NFO の画像') : localPhoto(src);
      } catch (e) {
        console.warn(`画像を取得できません: ${src} (${e.message})`);
      }
      own.set(src, p);
    }
    return own.get(src);
  };

  const byGroup = new Map(); // グループの先頭の名前 -> 画像
  const hashes = new Map(); // 画像のハッシュ -> グループ（写真未登録の共通画像を見分ける）
  let done = 0;
  for (const [name] of todo) {
    const group = groupOf(name);
    const key = group[0];
    if (byGroup.has(key)) continue;
    let photo = null;
    // 2. 同じ女優の作品の NFO にある画像
    for (const n of group) {
      for (const src of folders.get(n)?.values() || []) {
        if (src && (photo = await ownPhoto(src))) break;
      }
      if (photo) break;
    }
    // 3. FANZA
    for (const n of group) {
      if (photo) break;
      const img = r18Images.get(n);
      if (img) photo = await downloadPhoto(`https://pics.dmm.co.jp/mono/actjpgs/${img}`, 'FANZA');
    }
    // 4. みんなのAV
    for (const n of group) {
      if (photo) break;
      try {
        const url = await minnanoPhotoUrl(n);
        if (url) photo = await downloadPhoto(url, 'みんなのAV');
      } catch (e) {
        console.warn(`みんなのAV の検索に失敗: ${n} (${e.message})`);
      }
    }
    if (photo && photo.from !== 'NFO の画像') {
      if (!hashes.has(photo.hash)) hashes.set(photo.hash, []);
      hashes.get(photo.hash).push(key);
    }
    byGroup.set(key, photo);
    if (++done % 25 === 0) console.log(`  ${done} 人を検索`);
  }
  // 3 人以上で同じ画像は「写真未登録」の共通画像とみなして使わない
  for (const keys of hashes.values()) if (keys.length >= 3) for (const k of keys) byGroup.set(k, null);

  let saved = 0;
  const stats = {};
  const people = new Set();
  const missing = new Set();
  for (const [name, dirs] of todo) {
    for (const [dir, src] of dirs) {
      if (!needs(name, dir)) continue;
      // 1. その作品の NFO の画像 → 同じ女優の画像
      const photo = (src && (await ownPhoto(src))) || byGroup.get(groupOf(name)[0]);
      if (!photo) {
        missing.add(name);
        continue;
      }
      fs.mkdirSync(path.join(dir, '.actors'), { recursive: true });
      fs.copyFileSync(photo.file, path.join(dir, '.actors', name + photo.ext));
      stats[photo.from] = (stats[photo.from] || 0) + 1;
      saved++;
      people.add(name);
    }
  }
  console.log(`
.actors に保存: ${saved} 件（${people.size} 名義）  ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join('・')}
画像が見つからなかった名義: ${missing.size}${missing.size ? `（${[...missing].slice(0, 30).join('、')}${missing.size > 30 ? ' …' : ''}）` : ''}
Micol はフォルダの変更を検知して読み込み直します`);
}

/** 画像をダウンロードして data/cache/photos に保存する（同じ URL は再利用）。画像でなければ null */
async function downloadPhoto(url, from) {
  const base = path.join(PHOTO_CACHE, crypto.createHash('sha1').update(url).digest('hex').slice(0, 20));
  let file = Object.values(PHOTO_EXT).map((ext) => base + ext).find((f) => fs.existsSync(f));
  if (!file) {
    await sleep(1000);
    const r = await politeFetch(url, { headers: { 'User-Agent': UA } });
    const ext = PHOTO_EXT[(r.headers.get('content-type') || '').split(';')[0].trim()];
    const buf = Buffer.from(await r.arrayBuffer());
    // 画像でない・極端に小さい（ダミーの 1px 画像など）ものは使わない
    if (!r.ok || !ext || buf.length < 1500) return null;
    file = base + ext;
    fs.writeFileSync(file, buf);
  }
  return { file, ext: path.extname(file), from, hash: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') };
}

/** NFO に書かれたローカルの画像ファイル */
function localPhoto(file) {
  const ext = path.extname(file).toLowerCase();
  if (!fs.existsSync(file) || !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return null;
  return { file, ext: ext === '.jpeg' ? '.jpg' : ext, from: 'NFO の画像', hash: '' };
}

/** みんなのAV で名前が一致する女優が 1 人だけなら、その女優ページの写真の URL（"image": "…"） */
async function minnanoPhotoUrl(name) {
  const names = await minnanoIndex();
  const ids = names.get(name) || [];
  if (ids.length !== 1) return '';
  const html = await minnanoGet(`actress${ids[0]}.html`);
  const url = /"@type":\s*"Person"[\s\S]*?"image":\s*"([^"]+)"/.exec(html || '')?.[1] || '';
  return /no_?image|noimg|dummy/i.test(url) ? '' : url;
}

// ---------- NFO の出演者の画像のパスを .actors に書き換える（--fix-thumbs） ----------
//
// <actor><thumb> が Jellyfin のフォルダ（…\Jellyfin\…）や存在しないファイルを指していて、
// 動画フォルダの .actors に同じ名義の画像がある場合、<thumb> をその画像のパスに書き換える。
// URL や、別の場所にある実在の画像はそのまま。書き換える前の NFO は data/backup/thumbs-日時/ に残す

async function fixActorThumbs() {
  const backupDir = path.join(DATA_DIR, 'backup', `thumbs-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const videos = [];
  for (const r of roots) walk(r, videos);
  const nfos = new Map(); // 同じ NFO（movie.nfo など）を 2 回処理しない
  for (const v of videos) {
    // 動画の NFO と、同じフォルダの movie.nfo（.nfo の中・動画の隣）
    for (const f of [v.nfoPath, path.join(v.dir, SIDE_DIRS.nfo, 'movie.nfo'), path.join(v.dir, 'movie.nfo')]) if (fs.existsSync(f)) nfos.set(f, v.dir);
  }
  let files = 0;
  let thumbs = 0;
  const left = new Set(); // .actors に画像が無く、書き換えられなかった名義
  for (const [file, dir] of nfos) {
    const buf = fs.readFileSync(file);
    const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    let xml;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(bom ? buf.subarray(3) : buf);
    } catch {
      continue; // UTF-8 でない NFO は書き換えない
    }
    let changed = 0;
    const out = xml.replace(/<actor(\s[^>]*)?>([\s\S]*?)<\/actor>/gi, (block) => {
      const name = strip(/<name>([\s\S]*?)<\/name>/i.exec(block)?.[1] || '');
      const m = /(<thumb(?:\s[^>]*)?>)([^<]*)(<\/thumb>)/i.exec(block);
      if (!name || !m) return block;
      const value = strip(m[2]);
      if (!value || /^https?:\/\//i.test(value)) return block;
      const current = path.isAbsolute(value) ? value : path.join(dir, value);
      if (fs.existsSync(current) && !/[\\/]Jellyfin[\\/]/i.test(current)) return block;
      let photo = ['.jpg', '.jpeg', '.png', '.webp']
        .flatMap((ext) => [name + ext, name.replace(/ /g, '_') + ext])
        .map((f) => path.join(dir, '.actors', f))
        .find((f) => fs.existsSync(f));
      // .actors に無くても、今の画像（Jellyfin のフォルダなど）が残っていればコピーして使う
      const ext = path.extname(current).toLowerCase();
      if (!photo && fs.existsSync(current) && ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && !/[\\/:*?"<>|]/.test(name)) {
        photo = path.join(dir, '.actors', name + (ext === '.jpeg' ? '.jpg' : ext));
        fs.mkdirSync(path.dirname(photo), { recursive: true });
        fs.copyFileSync(current, photo);
      }
      if (!photo) {
        left.add(name);
        return block;
      }
      changed++;
      return block.replace(m[0], () => m[1] + photo.replace(/&/g, '&amp;').replace(/</g, '&lt;') + m[3]);
    });
    if (!changed) continue;
    const dst = path.join(backupDir, file.replace(/^([A-Za-z]):/, '$1'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
    const data = Buffer.from(out, 'utf8');
    fs.writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]) : data);
    files++;
    thumbs += changed;
  }
  console.log(`
<thumb> を .actors の画像に書き換えました: ${thumbs} 件（NFO ${files} 件）
${files ? `書き換える前の NFO: ${backupDir}\n` : ''}${left.size ? `.actors に画像が無いため書き換えなかった名義: ${left.size}（${[...left].slice(0, 20).join('、')}${left.size > 20 ? ' …' : ''}）` : ''}`);
}

// ---------- 書き込み ----------

async function applyReview() {
  // 書き換える前の NFO を data/backup/nfo-日時/ に元のフォルダ構成で残す
  const backupDir = path.join(DATA_DIR, 'backup', `nfo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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
      if (fs.existsSync(nfoPath)) {
        const dst = path.join(backupDir, nfoPath.replace(/^([A-Za-z]):/, '$1'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(nfoPath, dst);
      }
      await writeNfo(nfoPath, fields);
      written++;
    } catch (e) {
      console.warn(`書き込めません: ${nfoPath} (${e.message})`);
      skipped++;
    }
  }
  console.log(`NFO に書き込みました: ${written} 件${skipped ? `（書き込めなかったもの ${skipped} 件）` : ''}`);
  if (written) console.log(`書き換える前の NFO: ${backupDir}`);
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

/**
 * fetch に「アクセスが多すぎる」（429 / 503）への対応を足したもの:
 * Retry-After（無ければ 60 秒・120 秒・240 秒）待ってから最大 3 回やり直す
 */
async function politeFetch(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
    if ((r.status !== 429 && r.status !== 503) || attempt >= 3) return r;
    const wait = Math.max(Number(r.headers.get('retry-after')) || 0, 60 * 2 ** attempt);
    console.warn(`  アクセスが多すぎるため ${wait} 秒待ちます（${new URL(url).host}）`);
    await sleep(wait * 1000);
  }
}

/** キャッシュのファイル名: 長すぎる（Windows のパスの上限を超える）場合は先頭とハッシュにする */
function cacheName(name, ext) {
  if (name.length <= 150) return name + ext;
  return `${name.slice(0, 60)}-${crypto.createHash('sha1').update(name).digest('hex').slice(0, 16)}${ext}`;
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
else if (args.includes('--births')) await fillBirthdates();
else if (args.includes('--titles')) await fillFromTitles();
else if (args.includes('--romaji')) await fillFromRomaji();
else if (args.includes('--tff')) await fillFromTff();
else if (args.includes('--aliases')) await suggestAliases();
else if (args.includes('--photos')) await fetchPhotos();
else if (args.includes('--fix-thumbs')) await fixActorThumbs();
else if (apply) await applyReview();
else await fetchAll();
