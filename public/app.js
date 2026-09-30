// ---------- ユーティリティ ----------

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let me = null; // ログイン中のユーザー { id, name, admin }

async function api(url, opts = {}) {
  const init = { ...opts };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch {}
    // セッション切れ（別の端末でパスワード変更された等）はログイン画面へ
    if (r.status === 401 && !url.startsWith('/api/auth/') && me) {
      me = null;
      showAuth();
    }
    throw new Error(msg);
  }
  return r.json();
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + String(sec).padStart(2, '0');
}

function fmtSize(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function resLabel(w, h) {
  if (!h) return '';
  if (w >= 3800 || h >= 2000) return '4K';
  if (h >= 1400) return '1440p';
  if (h >= 1000 || w >= 1900) return '1080p';
  if (h >= 700 || w >= 1260) return '720p';
  return `${h}p`;
}

let toastTimer;
function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ブラウザが再生できる映像コーデック（サーバーの再生方式判定に使う）
const CAPS = (() => {
  const v = document.createElement('video');
  const ok = (t) => v.canPlayType(t) !== '';
  const caps = [];
  if (ok('video/mp4; codecs="avc1.640028"')) caps.push('h264');
  if (ok('video/mp4; codecs="hvc1.1.6.L120.90"')) caps.push('hevc');
  if (ok('video/mp4; codecs="av01.0.08M.08"')) caps.push('av1');
  if (ok('video/mp4; codecs="vp09.00.40.08"')) caps.push('vp9');
  if (ok('video/webm; codecs="vp8"')) caps.push('vp8');
  return caps.join(',');
})();

// ---------- 部品 ----------

/**
 * サムネイル画像。見切れないよう全体を枠に収め（contain）、
 * 余白は同じ画像をぼかして敷く（同じ URL なので読み込みは 1 回）
 */
function thumbImg(src, lazy = true) {
  const l = lazy ? 'loading="lazy" ' : '';
  return `<img class="thumb-bg" ${l}src="${src}" alt="" aria-hidden="true"><img class="thumb-img" ${l}src="${src}" alt="" onerror="this.parentElement.classList.add('noimg')">`;
}

const thumbUrl = (it) => `/api/items/${it.id}/thumb?v=${it.thumb}`;
// 一覧のカード用（縮小版）。詳細画面は元の画像（thumbUrl）
const cardThumbUrl = (it) => `${thumbUrl(it)}&w=480`;

// サムネイル枠の縦横比は 16:10 で固定（app.css の --thumb-ratio）
try { localStorage.removeItem('micol.thumbRatio'); } catch {}

function episodeLabel(it) {
  if (it.episode == null) return '';
  return it.season != null ? `S${it.season} E${it.episode}` : `第${it.episode}話`;
}

function itemCard(it, sub = '') {
  const pct = it.duration && it.position ? Math.min(100, (it.position / it.duration) * 100) : 0;
  sub = sub || [episodeLabel(it), it.year].filter(Boolean).join(' ・ ');
  return `<a class="card" href="#/item/${it.id}">
    <div class="thumb">
      ${thumbImg(cardThumbUrl(it))}
      ${it.watched ? '<span class="badge" title="視聴済み">✓</span>' : ''}
      ${it.duration ? `<span class="dur">${fmtTime(it.duration)}</span>` : ''}
      <button class="play-overlay" data-play="${it.id}" title="再生" aria-label="再生">▶</button>
      ${pct ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}
    </div>
    <div class="card-title" title="${esc(it.name)}">${esc(it.name)}</div>
    ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}
  </a>`;
}

function folderCard(f) {
  return `<a class="card folder" href="#/folder/${f.id}">
    <div class="thumb">
      ${thumbImg(`/api/folders/${f.id}/thumb?w=480`)}
      <span class="badge count">${f.count}</span>
    </div>
    <div class="card-title" title="${esc(f.name)}">${esc(f.name)}</div>
    ${f.year ? `<div class="card-sub">${f.year}</div>` : ''}
  </a>`;
}

/** NFO の概要（年・評価・ジャンル・あらすじなど） */
function nfoBlock(nfo, { people = false, cast = [], itemId = null } = {}) {
  const birth = Object.fromEntries(cast.map((c) => [c.name, c.birthdate]));
  const photo = Object.fromEntries(cast.map((c) => [c.name, c.thumb]));
  if (!nfo) return '';
  const meta = [
    nfo.year,
    nfo.premiered && nfo.premiered !== String(nfo.year) ? `発売日 ${nfo.premiered}` : null,
    nfo.rating != null ? `★ ${nfo.rating}` : null,
    nfo.mpaa,
    ...(nfo.genres || []),
  ].filter(Boolean);
  const rows = people
    ? [
        ['原題', nfo.originalTitle],
        ['監督', nfo.directors?.join(', ')],
        ['制作', nfo.studios?.join(', ')],
        ['出演', nfo.actors?.length ? `<div class="cast">${nfo.actors.map((a) => {
          const age = ageLabel(birth[a], nfo.premiered);
          const src = photo[a] ? `/api/person/thumb?name=${encodeURIComponent(a)}${itemId ? `&item=${itemId}` : ''}&v=${encodeURIComponent(photo[a])}` : '';
          return `<a class="cast-chip" href="${personHref(a)}">
            <span class="cast-photo" style="--hue:${nameHue(a)}"><span>${esc([...a.trim()][0] || '?')}</span>${src ? `<img src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</span>
            <span class="cast-name"><span class="person-link">${esc(a)}</span>${age ? `<span class="age">当時 ${age}</span>` : ''}</span>
          </a>`;
        }).join('')}</div>` : '', true],
        ['タグ', nfo.tags?.join(', ')],
      ].filter(([, v]) => v)
    : [];
  return `<div class="nfo">
    ${meta.length ? `<div class="meta">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${nfo.tagline ? `<p class="tagline">${esc(nfo.tagline)}</p>` : ''}
    ${nfo.plot ? `<p class="plot">${esc(nfo.plot)}</p>` : ''}
    ${rows.length ? `<dl class="tech">${rows.map(([k, v, html]) => `<dt>${k}</dt><dd>${html ? v : esc(v)}</dd>`).join('')}</dl>` : ''}
  </div>`;
}

const section = (title, body) => `<section class="section"><h2 class="section-title">${esc(title)}</h2>${body}</section>`;

function crumbs(list) {
  return `<nav class="crumbs"><a href="#/">ホーム</a>${list
    .map((c) => `<span class="sep">›</span><a href="#/folder/${c.id}">${esc(c.name)}</a>`)
    .join('')}</nav>`;
}

const SIZES = ['s', 'm', 'l'];
function setCardSize(size) {
  if (!SIZES.includes(size)) size = 'm';
  document.body.dataset.size = size;
  document.querySelectorAll('.size-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === size)));
  try { localStorage.setItem('micol.cardSize', size); } catch {}
}
let savedSize = 'm';
try { savedSize = localStorage.getItem('micol.cardSize') || 'm'; } catch {}
setCardSize(savedSize);

// カード上の再生ボタン（リンク内のボタンなので伝播を止める）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-play]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  location.hash = `#/play/${btn.dataset.play}`;
});

// ---------- サイドバー ----------

const NAV_ICON = {
  home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  history: 'M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  folder: 'M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z',
  settings: 'M19.14 12.94a7.07 7.07 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.03 7.03 0 00-1.63-.94l-.36-2.54A.5.5 0 0013.9 2h-3.84a.5.5 0 00-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.67 8.48a.5.5 0 00.12.64l2.03 1.58a7.07 7.07 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z',
  key: 'M12.65 10A5.99 5.99 0 007 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 005.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
  logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
};
const navSvg = (name) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="${NAV_ICON[name]}"/></svg>`;

let libraries = null; // サイドバーに出すライブラリ（ルートフォルダ）。null は読み込み前
let navActive = '#/';

// 広い画面ではサイドバーを常に表示し、メニューボタンでミニ表示と切り替える。
// 狭い画面では普段は隠しておき、メニューボタンで上に重ねて開く
const wideNav = matchMedia('(min-width: 1100px)');
try { document.body.classList.toggle('nav-mini', localStorage.getItem('micol.navMini') === '1'); } catch {}
const closeNav = () => document.body.classList.remove('nav-open');

$('#menu-btn').addEventListener('click', () => {
  if (wideNav.matches) {
    const mini = document.body.classList.toggle('nav-mini');
    try { localStorage.setItem('micol.navMini', mini ? '1' : '0'); } catch {}
  } else {
    document.body.classList.toggle('nav-open');
  }
});
$('#sidebar-backdrop').addEventListener('click', closeNav);
wideNav.addEventListener('change', closeNav);

// ヘッダーの高さ（スマホ幅では 2 段になる）に合わせてサイドバーの位置を決める
const topbar = $('.topbar');
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);

function navLink(href, icon, label) {
  return `<a class="nav-item" href="${href}" title="${esc(label)}">${navSvg(icon)}<span>${esc(label)}</span></a>`;
}

function renderSidebar() {
  $('#sidebar').innerHTML = `
    <div class="nav-group">
      ${navLink('#/', 'home', 'ホーム')}
      ${navLink('#/history', 'history', '履歴')}
      ${navLink('#/people', 'person', '女優')}
    </div>
    <div class="nav-group nav-libs">
      <div class="nav-heading">ライブラリ</div>
      ${libraries?.map((l) => navLink(`#/folder/${l.id}`, 'folder', l.name)).join('')
        || (libraries ? `<div class="nav-empty">${me.admin ? '<a href="#/settings">設定から追加</a>' : 'まだありません'}</div>` : '')}
    </div>
    <div class="nav-group">${navLink('#/settings', 'settings', '設定')}</div>`;
  markNav(navActive);
}

/** サイドバーの現在地を強調する（フォルダや動画の中ではそのライブラリ） */
function markNav(href) {
  navActive = href;
  document.querySelectorAll('#sidebar .nav-item').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === href));
}

async function loadLibraries() {
  try {
    const d = await api('/api/libraries');
    libraries = d.libraries;
  } catch { return; }
  renderSidebar();
}

// ---------- アカウントメニュー ----------

/** 名前から決まる色（色相）と頭文字の丸アイコン */
function nameHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}
const initial = (name) => [...name][0]?.toUpperCase() || '?';
const avatar = (user, cls = 'avatar') => `<span class="${cls}" style="--hue:${nameHue(user.name)}" aria-hidden="true">${esc(initial(user.name))}</span>`;

const accountBtn = $('#account-btn');
const accountMenu = $('#account-menu');

function renderAccountButton() {
  accountBtn.style.setProperty('--hue', nameHue(me.name));
  accountBtn.textContent = initial(me.name);
  accountBtn.title = `${me.name}${me.admin ? '（管理者）' : ''}`;
}

function setAccountMenu(open) {
  accountMenu.hidden = !open;
  accountBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  accountMenu.innerHTML = `
    <div class="account-head">${avatar(me, 'avatar big')}<div><div class="account-name">${esc(me.name)}</div>
      <div class="muted">${me.admin ? '管理者' : 'ユーザー'}</div></div></div>
    <a class="menu-item" role="menuitem" href="#/account">${navSvg('key')}アカウント・パスワード変更</a>
    <a class="menu-item" role="menuitem" href="#/settings">${navSvg('settings')}設定</a>
    <button type="button" class="menu-item" role="menuitem" data-act="logout">${navSvg('logout')}ログアウト</button>`;
}

accountBtn.addEventListener('click', () => setAccountMenu(accountMenu.hidden));
accountMenu.addEventListener('click', (e) => {
  if (e.target.closest('[data-act="logout"]')) logout();
  if (e.target.closest('.menu-item')) setAccountMenu(false);
});
document.addEventListener('click', (e) => {
  if (!accountMenu.hidden && !e.target.closest('.account')) setAccountMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!accountMenu.hidden) setAccountMenu(false);
  closeNav();
});

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  me = null;
  showAuth();
}

// ---------- スクロール位置 ----------
// 戻る・進むで前の画面に戻ったときは、前にいた位置までスクロールする（新しく開いた画面は一番上から）。
// 履歴の項目ごとに history.state に目印（micolKey）を付け、その目印でスクロール位置を覚える

history.scrollRestoration = 'manual';
const SCROLL_STORE = 'micol.scroll';
let scrollPos = new Map();
try { scrollPos = new Map(JSON.parse(sessionStorage.getItem(SCROLL_STORE) || '[]')); } catch {}
let scrollKey = null; // 今の画面の目印（描画中は null にして、描き替えで位置を上書きしない）

window.addEventListener('scroll', () => { if (scrollKey) scrollPos.set(scrollKey, window.scrollY); }, { passive: true });
// 再読み込み後も戻れるよう、ページを離れるときに保存する（新しい 100 件まで）
window.addEventListener('pagehide', () => {
  try { sessionStorage.setItem(SCROLL_STORE, JSON.stringify([...scrollPos].slice(-100))); } catch {}
});

let lastHash = null; // 直前に表示した画面（新しい履歴の項目に「1 つ前の画面」として覚える）

/** 今の履歴の項目の目印（無ければ付ける）と、既に付いていたか（= 戻る・進む・描き直しで来たか） */
function historyKey() {
  const had = history.state?.micolKey;
  if (had) return { key: had, revisit: true };
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  history.replaceState({ ...(history.state || {}), micolKey: key, prevHash: lastHash }, '');
  return { key, revisit: false };
}

// パンくずなどのリンクの行き先が 1 つ前の画面と同じなら、ブラウザの「戻る」にしてスクロール位置も戻す
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href^="#/"]');
  if (!a || a.target) return;
  const prev = history.state?.prevHash;
  if (prev && a.getAttribute('href') === prev) {
    e.preventDefault();
    history.back();
  }
});

/** 覚えておいた位置までスクロールする。画像の読み込みなどで高さが足りない間は少し待ってやり直す */
function restoreScroll(y, seq) {
  let tries = 0;
  const attempt = () => {
    if (seq !== routeSeq) return;
    window.scrollTo(0, y);
    if (Math.abs(window.scrollY - y) > 2 && ++tries < 20) setTimeout(attempt, 50);
  };
  attempt();
}

// ---------- ルーター ----------

let cleanup = null;
let routeSeq = 0;

async function router() {
  scrollKey = null;
  cleanup?.();
  cleanup = null;
  const seq = ++routeSeq;
  const { key, revisit } = historyKey();
  const [p, qs = ''] = (location.hash.slice(1) || '/').split('?');
  const parts = p.split('/').filter(Boolean);
  const params = new URLSearchParams(qs);
  const view = $('#view');
  document.body.classList.toggle('playing', parts[0] === 'play');
  if (parts[0] !== 'search') $('#search-form').q.value = '';
  // スマホ幅: 検索結果の画面では検索欄を開いたままにし、それ以外の画面に移ったら閉じる
  $('.topbar').classList.toggle('searching', parts[0] === 'search');
  closeNav();
  setAccountMenu(false);
  markNav(parts[0] === 'folder' ? `#/folder/${parts[1]}` : parts[0] === 'person' || parts[0] === 'aliases' ? '#/people' : `#/${parts[0] || ''}`);
  try {
    switch (parts[0]) {
      case undefined: await renderHome(view, seq); break;
      case 'folder': await renderFolder(view, parts[1], seq); break;
      case 'item': await renderItem(view, parts[1]); break;
      case 'play': await renderPlayer(view, parts[1], params, seq); break;
      case 'search': await renderSearch(view, params.get('q') || ''); break;
      case 'history': await renderHistory(view); break;
      case 'people': await renderPeople(view); break;
      case 'person': await renderPerson(view, params.get('name') || ''); break;
      case 'aliases': await renderAliasSuggestions(view); break;
      case 'settings': await renderSettings(view); break;
      case 'account': renderAccount(view); break;
      default: view.innerHTML = '<div class="empty">ページが見つかりません</div>';
    }
  } catch (e) {
    if (seq === routeSeq) view.innerHTML = `<div class="empty"><h2>エラー</h2><p>${esc(e.message)}</p><a class="btn" href="#/">ホームへ</a></div>`;
  }
  if (seq !== routeSeq) return;
  if (parts[0] !== 'play') {
    if (revisit && scrollPos.has(key)) restoreScroll(scrollPos.get(key), seq);
    else window.scrollTo(0, 0);
  }
  scrollKey = key;
  lastHash = location.hash || '#/';
}

window.addEventListener('hashchange', () => me && router());

let searchTimer;
const searchForm = $('#search-form');

// スマホ幅では検索欄を虫眼鏡ボタンの中にしまい、押すとヘッダー全体が検索欄になる
// 検索結果は履歴を置き換えて表示するので、閉じるときは開く前の画面に戻す
let searchReturn = null;
$('#search-open').addEventListener('click', () => {
  if (!location.hash.startsWith('#/search')) searchReturn = location.hash || '#/';
  $('.topbar').classList.add('searching');
  searchForm.q.focus();
});
function closeSearch() {
  $('.topbar').classList.remove('searching');
  if (location.hash.startsWith('#/search')) location.replace(searchReturn || '#/');
}
$('#search-close').addEventListener('click', closeSearch);
searchForm.q.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearch();
});
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchForm.q.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});
searchForm.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = searchForm.q.value.trim();
    if (q) location.replace(`#/search?q=${encodeURIComponent(q)}`);
  }, 350);
});

// スキャン中は数秒ごとに再描画する
function refreshWhileScanning(scanning, seq) {
  if (!scanning) return;
  const t = setTimeout(() => { if (seq === routeSeq) router(); }, 3000);
  cleanup = () => clearTimeout(t);
}

// ---------- ホーム ----------

async function renderHome(view, seq) {
  const d = await api('/api/home');
  const libKey = (list) => list?.map((l) => l.id + l.name).join('|');
  if (libKey(d.libraries) !== libKey(libraries)) {
    libraries = d.libraries;
    renderSidebar();
  }
  if (!d.libraries.length) {
    view.innerHTML = `<div class="empty"><h2>ライブラリがありません</h2>
      <p>設定から動画フォルダを追加すると、ここに表示されます。</p>
      <a class="btn primary" href="#/settings">設定を開く</a></div>`;
    return;
  }
  view.innerHTML = `
    ${section('ライブラリ', `<div class="grid">${d.libraries.map(folderCard).join('')}</div>`)}
    ${d.resume.length ? section('続きを見る', `<div class="row">${d.resume.map((it) => itemCard(it, `残り ${fmtTime(it.duration - it.position)}`)).join('')}</div>`) : ''}
    ${d.recent.length ? section('最近追加されたメディア', `<div class="row">${d.recent.map((it) => itemCard(it)).join('')}</div>`) : ''}
    ${d.scanning ? '<p class="muted">ライブラリをスキャン中…</p>' : ''}`;
  refreshWhileScanning(d.scanning && !d.recent.length, seq);
}

// ---------- フォルダ ----------

async function renderFolder(view, id, seq) {
  const d = await api(`/api/folders/${id}`);
  const items = d.items;
  const target = items.find((it) => it.position > 10 && !it.watched) || items.find((it) => !it.watched) || items[0];
  if (seq === routeSeq) markNav(`#/folder/${d.breadcrumbs[0]?.id}`);
  view.innerHTML = `
    ${crumbs(d.breadcrumbs.slice(0, -1))}
    <h1 class="page-title">${esc(d.folder.name)}</h1>
    ${d.folder.nfo ? `<div class="folder-nfo">${nfoBlock(d.folder.nfo)}</div>` : ''}
    <div class="toolbar">
      <span class="muted">${[d.folders.length && `${d.folders.length} フォルダ`, items.length && `${items.length} 本`].filter(Boolean).join(' ・ ')}</span>
      ${target ? `<a class="btn primary" href="#/play/${target.id}">▶ ${target.position > 10 ? '続きを再生' : '再生'}</a>` : ''}
    </div>
    ${d.folders.length ? `<div class="grid">${d.folders.map(folderCard).join('')}</div>` : ''}
    ${items.length ? `<div class="grid">${items.map((it) => itemCard(it)).join('')}</div>` : ''}
    ${!d.folders.length && !items.length ? `<div class="empty">${d.scanning ? 'スキャン中…' : 'メディアがありません'}</div>` : ''}`;
  refreshWhileScanning(d.scanning && !d.folders.length && !items.length, seq);
}

// ---------- 詳細 ----------

const LANG = { jpn: '日本語', ja: '日本語', eng: '英語', en: '英語', chi: '中国語', zho: '中国語', kor: '韓国語', ko: '韓国語', und: '' };
const langName = (l) => LANG[l] ?? l;

function audioLabel(a) {
  return [langName(a.lang), a.title, a.codec?.toUpperCase(), a.channels && `${a.channels}ch`].filter(Boolean).join(' / ') || `音声 ${a.index}`;
}

async function renderItem(view, id) {
  const it = await api(`/api/items/${id}`);
  if (it.breadcrumbs[0]) markNav(`#/folder/${it.breadcrumbs[0].id}`);
  const v = it.video;
  const resume = it.position > 10;
  const ep = episodeLabel(it);
  view.innerHTML = `
    ${crumbs(it.breadcrumbs)}
    <div class="detail">
      <div>
        <div class="detail-thumb">${thumbImg(thumbUrl(it), false)}</div>
        ${me.admin ? '<button class="btn small thumb-edit" id="edit-thumb">🖼 サムネイルを変更</button><button class="btn small thumb-edit" id="edit-nfo">✎ メタデータを編集</button>' : ''}
      </div>
      <div>
        ${it.nfo?.showTitle ? `<div class="muted">${esc(it.nfo.showTitle)}</div>` : ''}
        <h1>${ep ? `<span class="ep">${esc(ep)}</span>` : ''}${esc(it.name)}</h1>
        <div class="meta">${[
          it.duration && fmtTime(it.duration),
          v && resLabel(v.width, v.height),
          it.container.toUpperCase(),
          fmtSize(it.size),
          it.watched && '視聴済み',
        ].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>
        <div class="actions">
          ${resume
            ? `<a class="btn primary" href="#/play/${id}">▶ 続きから (${fmtTime(it.position)})</a><a class="btn" href="#/play/${id}?t=0">最初から</a>`
            : `<a class="btn primary" href="#/play/${id}?t=0">▶ 再生</a>`}
          <button class="btn" id="toggle-watched">${it.watched ? '未視聴にする' : '視聴済みにする'}</button>
        </div>
        ${resume && it.duration ? `<div class="bar"><div style="width:${(it.position / it.duration) * 100}%"></div></div>` : ''}
        ${nfoBlock(it.nfo, { people: true, cast: it.cast, itemId: it.id })}
        <dl class="tech">
          <dt>映像</dt><dd>${v ? esc(`${v.codec.toUpperCase()} ${v.profile} ${v.width}×${v.height}`) : '—'}</dd>
          <dt>音声</dt><dd>${it.audio.length ? it.audio.map((a) => esc(audioLabel(a))).join('<br>') : '—'}</dd>
          <dt>字幕</dt><dd>${it.subtitles.length ? it.subtitles.map((s) => esc(s.label + (s.supported ? '' : '（非対応）'))).join('<br>') : '—'}</dd>
          <dt>ファイル</dt><dd>${esc(it.path)}</dd>
        </dl>
        <div class="nav-links">
          <span>${it.prev ? `<a class="btn small" href="#/item/${it.prev.id}">‹ ${esc(it.prev.name)}</a>` : ''}</span>
          <span>${it.next ? `<a class="btn small" href="#/item/${it.next.id}">${esc(it.next.name)} ›</a>` : ''}</span>
        </div>
      </div>
    </div>`;
  $('#toggle-watched', view).onclick = async () => {
    await api(`/api/items/${id}/watched`, { method: 'POST', body: { watched: !it.watched } });
    router();
  };
  if (me.admin) $('#edit-thumb', view).onclick = async () => {
    if (await thumbEditor(it)) router();
  };
  if (me.admin) $('#edit-nfo', view).onclick = async () => {
    if (await nfoEditor(it)) router();
  };
}

/** メタデータ（NFO）の編集ダイアログ。保存したら true を返す */
function nfoEditor(it) {
  const n = it.nfo || {};
  const list = (a) => (a || []).join(', ');
  const text = (name, label, value, attrs = '') =>
    `<label class="field ${attrs.includes('grow') ? 'grow' : ''}">${label}<input name="${name}" value="${esc(value ?? '')}" ${attrs.replace('grow', '')}></label>`;
  // 保存先は常に .nfo\動画名.nfo（別の場所の NFO を使っていた場合はその内容を引き継ぐ）
  const target = `${it.path.replace(/[^\\/]+$/, '')}.nfo\\${it.file.replace(/\.[^.]+$/, '')}.nfo`;
  const note = !it.nfoPath ? '（新規作成）' : it.nfoPath.toLowerCase() === target.toLowerCase() ? '' : `（${it.nfoPath} の内容を引き継ぎます）`;
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<form class="modal-box wide nfo-form" role="dialog" aria-label="メタデータを編集">
      <h3>メタデータを編集</h3>
      <div class="nfo-fields">
        <div class="form-row">${text('title', 'タイトル', n.title ?? it.name, 'grow')}</div>
        <div class="form-row">${text('originalTitle', '原題', n.originalTitle, 'grow')}${text('sortTitle', '並べ替え用タイトル', n.sortTitle, 'grow')}</div>
        <div class="form-row">
          ${text('year', '年', n.year, 'inputmode="numeric" size="6"')}
          ${text('premiered', '発売日', n.premiered, 'size="12" placeholder="2019/05/25"')}
          ${text('season', 'シーズン', n.season, 'inputmode="numeric" size="5"')}
          ${text('episode', '話数', n.episode, 'inputmode="numeric" size="5"')}
          ${text('rating', '評価 (0〜10)', n.rating, 'inputmode="decimal" size="6"')}
          ${text('mpaa', '年齢制限', n.mpaa, 'size="8"')}
        </div>
        <div class="form-row">${text('tagline', 'キャッチコピー', n.tagline, 'grow')}</div>
        <div class="form-row"><label class="field grow">あらすじ<textarea name="plot" rows="5">${esc(n.plot || '')}</textarea></label></div>
        <p class="hint">以下は複数ある場合、カンマ（, または 、）で区切って入力します</p>
        <div class="form-row">${text('genres', 'ジャンル', list(n.genres), 'grow')}${text('tags', 'タグ', list(n.tags), 'grow')}</div>
        <div class="form-row">${text('studios', '制作', list(n.studios), 'grow')}${text('directors', '監督', list(n.directors), 'grow')}</div>
        <div class="form-row">${text('actors', '出演', list(n.actors), 'grow')}</div>
        <p class="hint">保存先: ${esc(target + note)}</p>
      </div>
      <div class="modal-actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`;
    document.body.append(modal);
    const form = $('form', modal);
    const close = (changed) => {
      modal.remove();
      resolve(changed);
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-act="cancel"]')) close(false);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const body = {};
      for (const k of ['title', 'originalTitle', 'sortTitle', 'year', 'premiered', 'season', 'episode', 'rating', 'mpaa', 'tagline', 'plot']) body[k] = f.get(k);
      for (const k of ['genres', 'tags', 'studios', 'directors', 'actors']) body[k] = String(f.get(k)).split(/[,、，]/).map((s) => s.trim()).filter(Boolean);
      form.querySelectorAll('button, input, textarea').forEach((b) => { b.disabled = true; });
      try {
        await api(`/api/items/${it.id}/nfo`, { method: 'PUT', body });
        toast('メタデータを保存しました');
        close(true);
      } catch (err) {
        toast(`保存できませんでした: ${err.message}`, 6000);
        form.querySelectorAll('button, input, textarea').forEach((b) => { b.disabled = false; });
      }
    });
    // 発売日: 入力欄を離れたら 2019-05-25 の形に整え、年が空なら発売日の年を入れる
    const released = form.premiered;
    released.addEventListener('blur', () => {
      const d = normalizeDate(released.value);
      released.setCustomValidity(d === null ? '日付として読み取れません（例: 2019/05/25）' : '');
      if (d === null) return released.reportValidity();
      released.value = d;
      if (d && !form.year.value.trim()) form.year.value = d.slice(0, 4);
    });
    released.addEventListener('input', () => released.setCustomValidity(''));
    $('input[name="title"]', modal).focus();
  });
}

/**
 * 日付の表記をそろえる: 2019/05/25・2019.5.25・2019年5月25日・20190525・全角数字 → 2019-05-25。
 * 年月だけ・年だけも可（2019/5 → 2019-05）。空なら ''、日付として読めない・存在しない日付なら null
 */
function normalizeDate(input) {
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

/** サムネイル変更ダイアログ。変更したら true を返す */
function thumbEditor(it) {
  return new Promise((resolve) => {
    const dur = Math.floor(it.duration || 0);
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-box wide" role="dialog" aria-label="サムネイルを変更">
      <h3>サムネイルを変更</h3>
      <div class="thumb-preview"><img src="${thumbUrl(it)}" alt=""></div>
      ${dur ? `<div class="frame-picker">
        <input type="range" class="seek" min="0" max="${dur}" step="1" value="0" aria-label="場面">
        <span class="frame-time">スライダーで動画の場面を選べます</span>
      </div>` : ''}
      <div class="modal-actions">
        <label class="btn">画像ファイルを選択…<input type="file" accept="image/jpeg,image/png,image/webp" hidden></label>
        ${it.customThumb ? '<button class="btn danger" data-act="reset">画像を削除</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" data-act="cancel">キャンセル</button>
        ${dur ? '<button class="btn primary" data-act="frame" disabled>この場面に設定</button>' : ''}
      </div>
    </div>`;
    document.body.append(modal);
    const img = $('.thumb-preview img', modal);
    const range = $('.frame-picker input', modal);
    const frameBtn = $('[data-act="frame"]', modal);
    let timer;

    const close = (changed) => {
      clearTimeout(timer);
      modal.remove();
      resolve(changed);
    };
    const busy = (on) => modal.querySelectorAll('button, input').forEach((b) => { b.disabled = on; });
    async function save(send, msg) {
      busy(true);
      try {
        const r = await send();
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        toast(msg);
        close(true);
      } catch (e) {
        toast(`設定できませんでした: ${e.message}`);
        busy(false);
      }
    }

    range?.addEventListener('input', () => {
      const t = Number(range.value);
      range.style.setProperty('--p', `${(t / dur) * 100}%`);
      $('.frame-time', modal).textContent = fmtTime(t);
      frameBtn.disabled = false;
      clearTimeout(timer);
      timer = setTimeout(() => { img.src = `/api/items/${it.id}/frame?t=${t}`; }, 200);
    });

    $('input[type=file]', modal).addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      save(() => fetch(`/api/items/${it.id}/thumb`, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file,
      }), 'サムネイルを設定しました');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) return close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(false);
      if (act === 'reset' && confirm('.thumbs フォルダのサムネイル画像を削除して、自動生成に戻しますか？\n（削除した画像は元に戻せません）')) {
        save(() => fetch(`/api/items/${it.id}/thumb`, { method: 'DELETE' }), 'サムネイル画像を削除しました');
      }
      if (act === 'frame') {
        save(() => fetch(`/api/items/${it.id}/thumb`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t: Number(range.value) }),
        }), 'サムネイルを設定しました');
      }
    });
  });
}

// ---------- 女優（NFO の出演者） ----------

/** 'YYYY' / 'YYYY-MM' / 'YYYY-MM-DD' を、その期間の最初と最後の日 [[年,月,日], [年,月,日]] にする */
function dateSpan(s) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s || '');
  if (!m) return null;
  const y = +m[1];
  if (m[3]) return [[y, +m[2], +m[3]], [y, +m[2], +m[3]]];
  if (m[2]) return [[y, +m[2], 1], [y, +m[2], new Date(y, +m[2], 0).getDate()]];
  return [[y, 1, 1], [y, 12, 31]];
}
const ageOn = (b, d) => d[0] - b[0] - (d[1] < b[1] || (d[1] === b[1] && d[2] < b[2]) ? 1 : 0);

/**
 * 生年月日と日付から年齢を「25歳」の形で返す。どちらかが年や年月だけで
 * 年齢が 1 つに決まらないときは「24〜25歳」、計算できないときは空文字
 */
function ageLabel(birthdate, date) {
  const b = dateSpan(birthdate);
  const d = dateSpan(date);
  if (!b || !d) return '';
  const max = ageOn(b[0], d[1]);
  const min = Math.max(0, ageOn(b[1], d[0]));
  if (max < 0) return '';
  return min === max ? `${min}歳` : `${min}〜${max}歳`;
}

function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const personHref = (name) => `#/person?name=${encodeURIComponent(name)}`;

/** 女優の写真。写真がない・読めないときは頭文字を表示する */
function personPhoto(p, lazy = true) {
  return `<div class="thumb person-thumb" style="--hue:${nameHue(p.name)}">
    <span class="person-initial" aria-hidden="true">${esc([...p.name.trim()][0] || '?')}</span>
    ${p.thumb ? `<img class="person-img" ${lazy ? 'loading="lazy" ' : ''}src="/api/person/thumb?name=${encodeURIComponent(p.name)}&v=${encodeURIComponent(p.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
  </div>`;
}

function personCard(p) {
  return `<a class="card person" href="${personHref(p.name)}">
    ${personPhoto(p)}
    <div class="card-title" title="${esc([p.name, ...(p.aliases || [])].join('／'))}">${esc(p.name)}</div>
    <div class="card-sub">${[`${p.count} 作品`, p.birthdate && ageLabel(p.birthdate, todayStr()), p.aliases?.length && `別名 ${p.aliases.length}`].filter(Boolean).join(' ・ ')}</div>
  </a>`;
}

async function renderPeople(view) {
  const d = await api('/api/people');
  if (!d.people.length) {
    view.innerHTML = `<h1 class="page-title">女優</h1>
      <div class="empty"><p>出演者が登録された動画がありません。</p>
      <p class="muted">NFO の &lt;actor&gt; か、詳細画面の「メタデータを編集」の出演に名前を入れると、ここに表示されます。</p></div>`;
    return;
  }
  let sort = 'count';
  try { sort = localStorage.getItem('micol.peopleSort') || 'count'; } catch {}
  view.innerHTML = `<h1 class="page-title">女優</h1>
    <div class="toolbar">
      <input type="search" class="people-filter" placeholder="名前・年齢（25歳、20-25歳）で絞り込み" aria-label="名前・年齢で絞り込み">
      <select class="people-sort" aria-label="並べ替え">
        <option value="count">作品数が多い順</option>
        <option value="name">名前順</option>
      </select>
      <span class="muted people-count"></span>
    </div>
    ${d.suggestions ? `<p class="hint alias-hint">同じ女優かもしれない名義が ${d.suggestions} 組あります。<a href="#/aliases">別名の候補を確認</a></p>` : ''}
    <div class="grid people-grid"></div>`;
  const filter = $('.people-filter', view);
  const sortSel = $('.people-sort', view);
  const grid = $('.people-grid', view);
  sortSel.value = sort;
  const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  function draw() {
    const q = filter.value.trim().normalize('NFKC').toLowerCase();
    // "25歳" "20-25歳" は現在の年齢で絞り込む
    const am = /^(\d{1,2})\s*(?:[-〜~～]\s*(\d{1,2})\s*)?(?:歳|才)$/.exec(q);
    const [amin, amax] = am ? [Number(am[1]), Number(am[2] ?? am[1])].sort((x, y) => x - y) : [];
    const ageHit = (p) => {
      const b = dateSpan(p.birthdate);
      const t = dateSpan(todayStr());
      return b && t && ageOn(b[0], t[1]) >= amin && Math.max(0, ageOn(b[1], t[0])) <= amax;
    };
    const list = d.people
      .filter((p) => !q || (am ? ageHit(p) : [p.name, ...(p.aliases || [])].some((n) => n.normalize('NFKC').toLowerCase().includes(q))))
      .sort((a, b) => (sortSel.value === 'count' ? b.count - a.count : 0) || collator.compare(a.name, b.name));
    $('.people-count', view).textContent = `${list.length} 人`;
    grid.innerHTML = list.length ? list.map(personCard).join('') : '<div class="empty">見つかりませんでした</div>';
  }
  filter.addEventListener('input', draw);
  sortSel.addEventListener('change', () => {
    try { localStorage.setItem('micol.peopleSort', sortSel.value); } catch {}
    draw();
  });
  draw();
}

async function renderPerson(view, name) {
  const d = await api(`/api/person?name=${encodeURIComponent(name)}`);
  const target = d.items.find((it) => it.position > 10 && !it.watched) || d.items.find((it) => !it.watched) || d.items[0];
  view.innerHTML = `
    <nav class="crumbs"><a href="#/people">女優</a></nav>
    <div class="person-head">
      ${personPhoto(d, false)}
      <div>
        <h1 class="page-title">${esc(d.name)}</h1>
        <div class="muted">${d.items.length} 作品</div>
        <div class="aliases">${d.aliases.length ? `別名：${d.aliases.map((a) => esc(a)).join('、')}` : '<span class="muted">別名 なし</span>'}
          ${me.admin ? '<button class="btn small" id="edit-aliases">別名を編集</button><button class="btn small" id="merge-person">別の女優と統合</button>' : ''}</div>
        ${me.admin ? `<div class="photo-actions">
          <label class="btn small">写真を変更…<input type="file" id="photo-file" accept="image/jpeg,image/png,image/webp" hidden></label>
          ${d.thumb ? '<button class="btn small" id="photo-clear">写真を削除</button>' : ''}
        </div>` : ''}
        <form class="birth-form" id="alias-form" hidden>
          <input name="aliases" size="40" placeholder="別名（、または , で区切る）" aria-label="別名">
          <button class="btn small primary">保存</button>
          <button type="button" class="btn small" data-act="cancel">キャンセル</button>
        </form>
        <form class="birth-form" id="merge-form" hidden>
          <input name="other" list="people-names" size="24" placeholder="統合する女優の名前" aria-label="統合する女優">
          <datalist id="people-names"></datalist>
          <button class="btn small primary">統合</button>
          <button type="button" class="btn small" data-act="cancel">キャンセル</button>
        </form>
        <div class="birth">${d.birthdate ? `生年月日 ${esc(d.birthdate)}（${ageLabel(d.birthdate, todayStr())}）` : '<span class="muted">生年月日 未設定</span>'}
          ${me.admin ? '<button class="btn small" id="edit-birth">生年月日を設定</button>' : ''}</div>
        <form class="birth-form" id="birth-form" hidden>
          <input type="date" name="birthdate" max="${todayStr()}" aria-label="生年月日">
          <button class="btn small primary">保存</button>
          <button type="button" class="btn small" data-act="clear">削除</button>
          <button type="button" class="btn small" data-act="cancel">キャンセル</button>
        </form>
        ${target ? `<div class="actions"><a class="btn primary" href="#/play/${target.id}">▶ ${target.position > 10 ? '続きを再生' : '再生'}</a></div>` : ''}
      </div>
    </div>
    <div class="grid">${d.items.map((it) => itemCard(it, [
      it.credited ? `${it.credited} 名義` : '',
      it.released ? `発売 ${it.released}` : '',
      ageLabel(d.birthdate, it.released) ? `当時 ${ageLabel(d.birthdate, it.released)}` : '',
    ].filter(Boolean).join(' ・ '))).join('')}</div>`;

  if (!me.admin) return;
  // 写真の変更・削除（出演作のフォルダの .actors/名義.jpg を書き換える）
  $('#photo-file', view).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    toast('写真を保存しています…', 10000);
    try {
      const r = await fetch(`/api/person/photo?name=${encodeURIComponent(d.name)}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      toast(`写真を変更しました（${j.written} か所）`);
      router();
    } catch (err) { toast(`保存できませんでした: ${err.message}`, 6000); }
  });
  $('#photo-clear', view)?.addEventListener('click', async () => {
    if (!confirm(`${d.name} の写真（各作品のフォルダの .actors の画像）を削除しますか？\n（NFO に画像の指定があれば、そちらが表示されます）`)) return;
    try {
      const j = await api(`/api/person/photo?name=${encodeURIComponent(d.name)}`, { method: 'DELETE' });
      toast(`写真を削除しました（${j.removed} 件）`);
      router();
    } catch (err) { toast(err.message); }
  });
  // 別名の編集: 入れた名義を同じ女優にまとめる（外した名義は別の女優に戻る）
  const aliasForm = $('#alias-form', view);
  $('#edit-aliases', view).onclick = () => {
    aliasForm.hidden = false;
    aliasForm.aliases.value = d.aliases.join('、');
    aliasForm.aliases.focus();
  };
  aliasForm.onsubmit = async (e) => {
    e.preventDefault();
    const list = aliasForm.aliases.value.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
    try {
      const p = await api(`/api/person/aliases?name=${encodeURIComponent(d.name)}`, { method: 'PUT', body: { aliases: list } });
      toast('別名を保存しました');
      location.hash = personHref(p.name); // 作品数で代表名が変わることがある
      router();
    } catch (err) { toast(err.message); }
  };
  aliasForm.querySelector('[data-act="cancel"]').onclick = () => { aliasForm.hidden = true; };
  // 統合: 選んだ女優の名義をすべてこの女優の別名にする
  const mergeForm = $('#merge-form', view);
  $('#merge-person', view).onclick = async () => {
    mergeForm.hidden = false;
    mergeForm.other.focus();
    try {
      const all = (await api('/api/people')).people.filter((p) => p.name !== d.name);
      $('#people-names', view).innerHTML = all.map((p) => `<option value="${esc(p.name)}">${p.count} 作品</option>`).join('');
    } catch {}
  };
  mergeForm.onsubmit = async (e) => {
    e.preventDefault();
    const other = mergeForm.other.value.trim();
    if (!other) return toast('統合する女優の名前を入力してください');
    if (!confirm(`「${other}」を「${d.name}」と同じ女優としてまとめますか？`)) return;
    try {
      const p = await api(`/api/person/merge?name=${encodeURIComponent(d.name)}`, { method: 'POST', body: { name: other } });
      toast('統合しました');
      location.hash = personHref(p.name);
      router();
    } catch (err) { toast(err.message); }
  };
  mergeForm.querySelector('[data-act="cancel"]').onclick = () => { mergeForm.hidden = true; };

  const form = $('#birth-form', view);
  const save = async (birthdate) => {
    try {
      await api(`/api/person?name=${encodeURIComponent(d.name)}`, { method: 'PUT', body: { birthdate } });
      toast(birthdate ? '生年月日を保存しました' : '生年月日を削除しました');
      router();
    } catch (e) { toast(e.message); }
  };
  $('#edit-birth', view).onclick = () => {
    form.hidden = false;
    form.birthdate.value = /^\d{4}-\d{2}-\d{2}$/.test(d.birthdate || '') ? d.birthdate : '';
    form.birthdate.focus();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!form.birthdate.value) return toast('生年月日を入力してください');
    save(form.birthdate.value);
  };
  form.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') form.hidden = true;
    if (act === 'clear' && confirm(`${d.name} の生年月日を削除しますか？`)) save('');
  });
}

// ---------- 別名の候補（1 か所の情報源だけで見つかった組） ----------

async function renderAliasSuggestions(view) {
  const d = await api('/api/people/suggestions');
  const row = (s, i) => {
    const who = (p) => (p.person
      ? `<a href="${personHref(p.person)}">${esc(p.name)}</a><span class="muted">（${p.person !== p.name ? `${esc(p.person)} の別名・` : ''}${p.count} 作品）</span>`
      : `${esc(p.name)}<span class="muted">（ライブラリに作品なし）</span>`);
    return `<li class="alias-row" data-i="${i}">
      <div class="alias-names">${who(s.people[0])} ⇔ ${who(s.people[1])}</div>
      <div class="muted alias-src">情報源: ${s.sources.map(esc).join('、')}</div>
      <div class="alias-actions">
        <button class="btn small primary" data-act="accept">同じ女優</button>
        <button class="btn small" data-act="reject">違う</button>
      </div>
    </li>`;
  };
  // どちらの名義にも作品がある組を先に（作品のない名義との組は検索用の別名になるだけなので、既定では隠す）
  const both = (s) => s.people.every((p) => p.person);
  d.suggestions.sort((a, b) => both(b) - both(a));
  view.innerHTML = `
    <nav class="crumbs"><a href="#/people">女優</a></nav>
    <h1 class="page-title">別名の候補</h1>
    <p class="hint">情報源が 1 か所だけの組です（2 か所以上で一致した組は自動でまとめています）。「同じ女優」にすると 1 人にまとまり、作品数が多い名義が代表名になります。</p>
    <label class="alias-toggle"><input type="checkbox" id="show-all"> 作品のない名義との組も表示（${d.suggestions.filter((s) => !both(s)).length} 組）</label>
    ${d.suggestions.length ? `<ul class="alias-list">${d.suggestions.map(row).join('')}</ul>` : '<div class="empty">確認待ちの候補はありません</div>'}`;
  const applyFilter = () => {
    const all = $('#show-all', view).checked;
    view.querySelectorAll('.alias-row').forEach((li) => { li.hidden = !all && !both(d.suggestions[Number(li.dataset.i)]); });
  };
  $('#show-all', view).addEventListener('change', applyFilter);
  applyFilter();
  view.querySelectorAll('.alias-row').forEach((li) => {
    const s = d.suggestions[Number(li.dataset.i)];
    li.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      li.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await api('/api/people/suggestions', { method: 'POST', body: { names: s.names, accept: act === 'accept' } });
        li.remove();
        toast(act === 'accept' ? `${s.names.join(' と ')} をまとめました` : '候補から外しました');
      } catch (err) {
        toast(err.message);
        li.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    });
  });
}

// ---------- 検索 ----------

async function renderSearch(view, q) {
  if (searchForm.q.value.trim() !== q) searchForm.q.value = q;
  const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
  // 年齢での検索（"20歳" "20-25歳"）: 女優は現在の年齢、動画は出演当時の年齢で探した結果
  const age = d.age ? (d.age.min === d.age.max ? `${d.age.min}歳` : `${d.age.min}〜${d.age.max}歳`) : '';
  view.innerHTML = `<h1 class="page-title">「${esc(q)}」の検索結果</h1>
    ${age ? `<p class="hint age-hint">${d.age.only === 'people' ? `現在 ${age} の女優です。` : d.age.only === 'items' ? `出演者が当時 ${age} の作品です（発売日と生年月日から計算）。` : `女優は現在 ${age}、動画は出演者が当時 ${age} の作品です（発売日と生年月日から計算）。「当時${age}」「現在${age}」で片方だけにできます。`}</p>` : ''}
    ${d.people?.length ? section(age ? `女優（現在 ${age}）` : '女優', `<div class="grid people-grid">${d.people.map(personCard).join('')}</div>`) : ''}
    ${d.folders.length ? section('フォルダ', `<div class="grid">${d.folders.map(folderCard).join('')}</div>`) : ''}
    ${d.items.length ? section(age ? `動画（出演当時 ${age}）` : '動画', `<div class="grid">${d.items.map((it) => itemCard(it, it.ageNote || '')).join('')}</div>`) : ''}
    ${!d.folders.length && !d.items.length && !d.people?.length ? '<div class="empty">見つかりませんでした</div>' : ''}`;
}

// ---------- 履歴 ----------

function dayLabel(ts) {
  const d = new Date(ts);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  if (diff < 7) return d.toLocaleDateString('ja-JP', { weekday: 'long' });
  return d.toLocaleDateString('ja-JP', d.getFullYear() === new Date().getFullYear() ? { month: 'long', day: 'numeric' } : { dateStyle: 'long' });
}

function historyRow(it) {
  const pct = it.duration && it.position ? Math.min(100, (it.position / it.duration) * 100) : 0;
  const state = it.watched ? '視聴済み' : it.position ? `${fmtTime(it.position)} まで視聴` : '';
  const time = new Date(it.updated).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return `<div class="hist-row" data-id="${it.id}">
    <a class="thumb" href="#/item/${it.id}">
      ${thumbImg(cardThumbUrl(it))}
      ${it.watched ? '<span class="badge" title="視聴済み">✓</span>' : ''}
      ${it.duration ? `<span class="dur">${fmtTime(it.duration)}</span>` : ''}
      <button class="play-overlay" data-play="${it.id}" title="再生" aria-label="再生">▶</button>
      ${pct ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}
    </a>
    <div class="hist-info">
      <a class="hist-title" href="#/item/${it.id}">${esc(it.name)}</a>
      <div class="card-sub">${esc([it.folder, episodeLabel(it)].filter(Boolean).join(' ・ '))}</div>
      <div class="card-sub">${esc([time, state].filter(Boolean).join(' ・ '))}</div>
    </div>
    <button class="icon-btn" data-remove title="履歴から削除" aria-label="履歴から削除">${navSvg('close')}</button>
  </div>`;
}

async function renderHistory(view) {
  const { items } = await api('/api/history');
  const groups = new Map();
  for (const it of items) {
    const label = dayLabel(it.updated);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(it);
  }
  view.innerHTML = `<div class="history">
    <div class="toolbar">
      <h1 class="page-title">履歴</h1>
      <span class="spacer"></span>
      ${items.length ? '<button class="btn small danger" id="clear-history">すべての履歴を削除</button>' : ''}
    </div>
    ${items.length
      ? [...groups].map(([label, list]) => section(label, `<div class="hist-list">${list.map(historyRow).join('')}</div>`)).join('')
      : '<div class="empty">視聴履歴はありません</div>'}
  </div>`;

  view.querySelector('.history').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const row = b.closest('.hist-row');
    try {
      await api(`/api/history/${row.dataset.id}`, { method: 'DELETE' });
    } catch (err) { return toast(err.message); }
    const sec = row.closest('.section');
    row.remove();
    if (!sec.querySelector('.hist-row')) sec.remove();
    if (!view.querySelector('.hist-row')) router();
    toast('履歴から削除しました');
  });

  $('#clear-history', view)?.addEventListener('click', async () => {
    if (!confirm('すべての視聴履歴を削除しますか？\n（続きから再生する位置と「視聴済み」の記録も消えます）')) return;
    try {
      await api('/api/history', { method: 'DELETE' });
      toast('履歴を削除しました');
      router();
    } catch (err) { toast(err.message); }
  });
}

// ---------- アカウント ----------

function renderAccount(view) {
  view.innerHTML = `
    <div class="settings">
      <h1 class="page-title">アカウント</h1>
      <section class="panel">
        <div class="account-head">${avatar(me, 'avatar big')}<div>
          <div class="account-name">${esc(me.name)}</div>
          <div class="muted">${me.admin ? '管理者' : 'ユーザー'}としてログイン中</div>
        </div><span class="spacer"></span><button class="btn" id="logout">ログアウト</button></div>
      </section>
      <section class="panel">
        <h2>パスワードの変更</h2>
        <form class="form-row" id="pw-form">
          <label class="field"><span>現在のパスワード</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="field"><span>新しいパスワード（8 文字以上）</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
          <label class="field"><span>新しいパスワード（確認）</span><input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
          <button class="btn primary">パスワードを変更</button>
        </form>
        <p class="hint">変更すると、この端末以外ではログアウトされます。</p>
      </section>
    </div>`;
  $('#logout', view).onclick = logout;
  const form = $('#pw-form', view);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.password.value !== form.confirm.value) return toast('新しいパスワードが一致しません');
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: form.current.value, password: form.password.value } });
      form.reset();
      toast('パスワードを変更しました（他の端末はログアウトされます）');
    } catch (err) { toast(err.message); }
  };
}

// ---------- プレーヤー ----------

const MODE_LABEL = { direct: 'ダイレクト再生', remux: 'リマックス', audio: '音声変換', transcode: 'トランスコード' };
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>',
  rew: '<svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3L19 9.59 17.59 8.17 15.17 10.6 12.76 8.17 11.34 9.59 13.76 12l-2.42 2.41 1.42 1.42 2.41-2.42 2.42 2.42L19 14.41z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  snap: '<svg viewBox="0 0 24 24"><path d="M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2L7.17 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2h-3.17L15 2H9zm3 15a5 5 0 110-10 5 5 0 010 10z"/></svg>',
};

function parseVtt(text) {
  const ts = (s) => s.split(':').reduce((acc, x) => acc * 60 + parseFloat(x), 0);
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const body = lines.slice(i + 1).join('\n')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .trim();
    if (body) cues.push({ s: ts(a.trim()), e: ts(b.trim().split(/\s+/)[0]), text: body });
  }
  return cues;
}

async function renderPlayer(view, id, params, seq) {
  const it = await api(`/api/items/${id}`);
  if (seq !== routeSeq) return;
  const startAt = params.has('t') ? Number(params.get('t')) || 0 : it.position > 10 ? it.position : 0;

  view.innerHTML = `
    <div class="player">
      <video playsinline preload="auto"></video>
      <div class="subs"></div>
      <div class="spinner"></div>
      <div class="ctl ctl-top">
        <button class="pbtn" data-a="back" title="戻る">${ICON.back}</button>
        <div class="ptitle">${esc(it.name)}</div>
        <span class="mode-badge"></span>
        ${me.admin ? `<button class="pbtn" data-a="snap" title="この場面をサムネイルに設定">${ICON.snap}</button>` : ''}
      </div>
      <div class="ctl ctl-bottom">
        <div class="trick" hidden><div class="trick-img"></div><span class="trick-time"></span></div>
        <input type="range" class="seek" min="0" max="0" step="0.1" value="0" aria-label="再生位置">
        <div class="ctl-row">
          <button class="pbtn" data-a="pp" title="再生/一時停止 (Space)">${ICON.play}</button>
          <span class="skip-group">
            <button class="pbtn skip" data-skip="-300" title="5分戻る (Shift+←)" aria-label="5分戻る">${ICON.rew}<span>5分</span></button>
            <button class="pbtn skip" data-skip="-10" title="10秒戻る (←)" aria-label="10秒戻る">${ICON.rew}<span>10秒</span></button>
            <button class="pbtn skip" data-skip="10" title="10秒進む (→)" aria-label="10秒進む">${ICON.fwd}<span>10秒</span></button>
            <button class="pbtn skip" data-skip="300" title="5分進む (Shift+→)" aria-label="5分進む">${ICON.fwd}<span>5分</span></button>
          </span>
          ${it.next ? `<button class="pbtn" data-a="next" title="次へ: ${esc(it.next.name)}">${ICON.next}</button>` : ''}
          <button class="pbtn" data-a="mute" title="ミュート (M)">${ICON.vol}</button>
          <input type="range" class="vol" min="0" max="1" step="0.05" aria-label="音量">
          <span class="ptime">0:00 / 0:00</span>
          <span class="spacer"></span>
          ${it.audio.length > 1 ? `<select class="psel" data-s="audio" title="音声">${it.audio.map((a) => `<option value="${a.index}">${esc(audioLabel(a))}</option>`).join('')}</select>` : ''}
          <select class="psel" data-s="sub" title="字幕">
            <option value="">字幕なし</option>
            ${it.subtitles.map((s) => `<option value="${s.key}" ${s.supported ? '' : 'disabled'}>${esc(s.label)}${s.supported ? '' : '（非対応）'}</option>`).join('')}
          </select>
          <select class="psel" data-s="quality" title="再生方式">
            <option value="auto">自動</option>
            <option value="transcode">トランスコード</option>
          </select>
          <button class="pbtn" data-a="fs" title="全画面 (F)">${ICON.fs}</button>
        </div>
      </div>
    </div>`;

  const player = $('.player', view);
  const video = $('video', player);
  const subsEl = $('.subs', player);
  const spinner = $('.spinner', player);
  const badge = $('.mode-badge', player);
  const seekEl = $('.seek', player);
  const timeEl = $('.ptime', player);
  const volEl = $('.vol', player);
  const btn = (a) => $(`[data-a="${a}"]`, player);
  const sel = (s) => $(`[data-s="${s}"]`, player);

  let mode = null;       // 再生方式
  let offset = 0;        // ffmpeg 配信時の開始位置（video.currentTime はここからの相対）
  let audio = null;      // 選択中の音声ストリーム番号
  let force = false;     // トランスコード強制
  let cues = null;       // 字幕
  let alive = true;
  let started = false;   // 実際に再生が始まったか（誤って 0 秒を保存しないため）
  let dragging = false;
  let pendingSeek = null;
  let seekTimer, hideTimer, raf;
  let loadSeq = 0;
  let lastSaved = -100;

  const duration = () => (mode === 'direct' && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : it.duration);
  const current = () => pendingSeek ?? (mode === 'direct' ? video.currentTime : offset + video.currentTime);
  const showSpinner = (on) => { spinner.hidden = !on; };

  // --- 読み込み ---
  async function start(t) {
    const my = ++loadSeq;
    showSpinner(true);
    const q = new URLSearchParams({ caps: CAPS, audio: audio ?? '', force: force ? '1' : '0' });
    const d = await api(`/api/items/${id}/playback?${q}`);
    if (my !== loadSeq || !alive) return;
    mode = d.mode;
    audio = d.audioIndex;
    badge.textContent = MODE_LABEL[mode];
    await load(t, my);
  }

  async function load(t, my = ++loadSeq) {
    const d = duration();
    t = Math.max(0, d ? Math.min(t, d - 1) : t);
    showSpinner(true);
    if (mode === 'direct') {
      if (video.src.includes('mode=direct')) {
        video.currentTime = t;
      } else {
        video.src = `/api/items/${id}/stream?mode=direct`;
        if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
      }
    } else {
      // 映像をコピーする方式ではキーフレームにしか飛べないので、先に位置を合わせる
      if (mode !== 'transcode' && t > 0) {
        try { t = (await api(`/api/items/${id}/keyframe?t=${t.toFixed(3)}`)).t; } catch {}
        if (my !== loadSeq || !alive) return;
      }
      offset = t;
      const q = new URLSearchParams({ mode, t: t.toFixed(3) });
      if (audio != null) q.set('audio', audio);
      video.src = `/api/items/${id}/stream?${q}`;
    }
    pendingSeek = null;
    video.play().catch(() => showSpinner(false));
  }

  function seek(t) {
    if (!mode) return;
    t = Math.max(0, Math.min(t, duration() || t));
    if (mode === 'direct') {
      video.currentTime = t;
      return;
    }
    // 連続操作で ffmpeg を何度も起動しないよう少し待ってからまとめて読み込む
    pendingSeek = t;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => load(t), 300);
  }

  // --- 視聴位置の保存 ---
  function saveProgress(force = false) {
    if (!started || !mode) return;
    const position = current();
    if (!force && Math.abs(position - lastSaved) < 5) return;
    lastSaved = position;
    fetch(`/api/items/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position, duration: duration() }),
      keepalive: true,
    }).catch(() => {});
  }

  // --- 字幕 ---
  async function selectSub(key) {
    cues = null;
    subsEl.textContent = '';
    if (!key) return;
    toast('字幕を読み込み中…', 10000);
    try {
      const r = await fetch(`/api/items/${id}/subs/${key}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const parsed = parseVtt(await r.text());
      if (sel('sub').value === key) cues = parsed;
      toast(`字幕: ${parsed.length} 件`);
    } catch (e) {
      toast(`字幕を読み込めません: ${e.message}`);
    }
  }

  let lastSubText = '';
  function renderSubs(t) {
    const text = cues ? cues.filter((c) => t >= c.s && t <= c.e).map((c) => c.text).join('\n') : '';
    if (text === lastSubText) return;
    lastSubText = text;
    subsEl.innerHTML = text ? `<span>${esc(text)}</span>` : '';
  }

  // --- UI 更新 ---
  let lastTimeText = '';
  function frame() {
    if (!alive) return;
    const d = duration() || 0;
    const t = dragging ? Number(seekEl.value) : current();
    if (!dragging) {
      seekEl.max = d;
      seekEl.value = t;
    }
    seekEl.style.setProperty('--p', d ? `${(t / d) * 100}%` : '0%');
    const text = `${fmtTime(t)} / ${fmtTime(d)}`;
    if (text !== lastTimeText) timeEl.textContent = lastTimeText = text;
    renderSubs(current());
    raf = requestAnimationFrame(frame);
  }

  function poke() {
    player.classList.remove('idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!video.paused) player.classList.add('idle'); }, 3000);
  }

  const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
    else video.webkitEnterFullscreen?.();
  };
  const setVolume = (v) => {
    video.volume = Math.max(0, Math.min(1, v));
    video.muted = false;
  };
  const goBack = () => (history.length > 1 ? history.back() : (location.hash = `#/item/${id}`));

  // --- イベント ---
  video.addEventListener('play', () => { btn('pp').innerHTML = ICON.pause; poke(); });
  video.addEventListener('pause', () => { btn('pp').innerHTML = ICON.play; player.classList.remove('idle'); saveProgress(true); });
  video.addEventListener('playing', () => { started = true; showSpinner(false); });
  video.addEventListener('waiting', () => showSpinner(true));
  video.addEventListener('seeking', () => showSpinner(true));
  video.addEventListener('seeked', () => showSpinner(false));
  video.addEventListener('canplay', () => showSpinner(false));
  video.addEventListener('volumechange', () => {
    const v = video.muted ? 0 : video.volume;
    volEl.value = v;
    volEl.style.setProperty('--p', `${v * 100}%`);
    btn('mute').innerHTML = v ? ICON.vol : ICON.mute;
    try { localStorage.setItem('micol.volume', String(video.volume)); } catch {}
  });
  video.addEventListener('ended', () => {
    if (!alive) return;
    fetch(`/api/items/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: duration(), duration: duration() }),
    }).catch(() => {});
    started = false; // cleanup での上書き保存を防ぐ
    if (it.next) location.replace(`#/play/${it.next.id}?t=0`);
    else goBack();
  });
  video.addEventListener('error', () => {
    if (!alive || !video.getAttribute('src')) return;
    const t = current();
    if (mode !== 'transcode') {
      force = true;
      sel('quality').value = 'transcode';
      toast('この形式は直接再生できないため、トランスコードに切り替えます');
      start(t).catch((e) => toast(e.message));
    } else {
      showSpinner(false);
      toast('再生できませんでした（ffmpeg のログを確認してください）', 6000);
    }
  });

  video.addEventListener('click', () => (player.classList.contains('idle') ? poke() : togglePlay()));
  video.addEventListener('dblclick', toggleFullscreen);
  player.addEventListener('mousemove', poke);
  player.addEventListener('touchstart', poke, { passive: true });

  btn('pp').onclick = togglePlay;
  // スキップ（10秒 / 5分）。連打すると移動量が積み重なる（seek は連続操作をまとめて読み込む）
  player.querySelectorAll('[data-skip]').forEach((b) => {
    b.onclick = () => seek(current() + Number(b.dataset.skip));
  });
  btn('back').onclick = goBack;
  btn('fs').onclick = toggleFullscreen;
  if (me.admin) btn('snap').onclick = async () => {
    try {
      await api(`/api/items/${id}/thumb`, { method: 'PUT', body: { t: current() } });
      toast(`${fmtTime(current())} の場面をサムネイルに設定しました`);
    } catch (e) {
      toast(`設定できませんでした: ${e.message}`);
    }
  };
  btn('mute').onclick = () => { video.muted = !video.muted; };
  if (it.next) btn('next').onclick = () => location.replace(`#/play/${it.next.id}?t=0`);
  volEl.oninput = () => setVolume(Number(volEl.value));

  seekEl.addEventListener('input', () => { dragging = true; poke(); showTrick(Number(seekEl.value)); });
  seekEl.addEventListener('change', () => { dragging = false; hideTrick(); seek(Number(seekEl.value)); });

  // --- シークバーのプレビュー（トリックプレイ） ---
  const trickEl = $('.trick', player);
  const trickImg = $('.trick-img', player);
  let trick = null;
  let trickRetry;
  async function loadTrick() {
    try {
      const d = await api(`/api/items/${id}/trickplay`);
      if (!alive) return;
      if (d.sheets) trick = d;
      // 生成中なら少し待ってから確認し直す
      else if (d.pending) trickRetry = setTimeout(loadTrick, 20000);
    } catch {}
  }
  function showTrick(t) {
    const d = duration();
    if (!trick || !d) return;
    const i = Math.max(0, Math.min(trick.count - 1, Math.floor(t / trick.interval)));
    const per = trick.cols * trick.rows;
    const sheet = Math.floor(i / per);
    const k = i % per;
    // 画面幅に合わせて縮小（最大はタイルの実寸）
    const w = Math.min(trick.width, Math.round(player.clientWidth * 0.4));
    const scale = w / trick.width;
    const h = Math.round(trick.height * scale);
    trickImg.style.width = `${w}px`;
    trickImg.style.height = `${h}px`;
    trickImg.style.backgroundImage = `url("/api/items/${id}/trickplay/${sheet}?v=${trick.v}")`;
    trickImg.style.backgroundSize = `${trick.width * trick.cols * scale}px ${trick.height * trick.rows * scale}px`;
    trickImg.style.backgroundPosition = `${-(k % trick.cols) * w}px ${-Math.floor(k / trick.cols) * h}px`;
    $('.trick-time', trickEl).textContent = fmtTime(t);
    // シークバー上の位置に合わせて表示（左右ははみ出さないように）
    const bar = seekEl.getBoundingClientRect();
    const box = trickEl.parentElement.getBoundingClientRect();
    const x = bar.left - box.left + (t / d) * bar.width;
    trickEl.style.left = `${Math.max(0, Math.min(box.width - w, x - w / 2))}px`;
    trickEl.style.bottom = `${box.bottom - bar.top + 8}px`;
    trickEl.hidden = false;
  }
  const hideTrick = () => { trickEl.hidden = true; };
  seekEl.addEventListener('pointermove', (e) => {
    if (dragging || e.pointerType === 'touch') return;
    const bar = seekEl.getBoundingClientRect();
    showTrick(Math.max(0, Math.min(1, (e.clientX - bar.left) / bar.width)) * (duration() || 0));
  });
  seekEl.addEventListener('pointerleave', () => { if (!dragging) hideTrick(); });
  loadTrick();

  sel('audio')?.addEventListener('change', (e) => {
    audio = Number(e.target.value);
    start(current()).catch((err) => toast(err.message));
  });
  sel('sub').addEventListener('change', (e) => selectSub(e.target.value));
  sel('quality').addEventListener('change', (e) => {
    force = e.target.value === 'transcode';
    start(current()).catch((err) => toast(err.message));
  });

  function onKey(e) {
    if (e.target.tagName === 'SELECT' || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    if (k === ' ' || k === 'k') togglePlay();
    else if (k === 'ArrowLeft' || k === 'j') seek(current() - (e.shiftKey ? 300 : k === 'j' ? 30 : 10));
    else if (k === 'ArrowRight' || k === 'l') seek(current() + (e.shiftKey ? 300 : k === 'l' ? 30 : 10));
    else if (k === 'ArrowUp') setVolume(video.volume + 0.05);
    else if (k === 'ArrowDown') setVolume(video.volume - 0.05);
    else if (k === 'f') toggleFullscreen();
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'n' && it.next) location.replace(`#/play/${it.next.id}?t=0`);
    else if (k === 'Escape' && !document.fullscreenElement) goBack();
    else return;
    e.preventDefault();
    poke();
  }
  const onUnload = () => saveProgress(true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onUnload);
  const saveTimer = setInterval(() => { if (!video.paused) saveProgress(); }, 10000);

  cleanup = () => {
    saveProgress(true);
    alive = false;
    cancelAnimationFrame(raf);
    clearInterval(saveTimer);
    clearTimeout(hideTimer);
    clearTimeout(seekTimer);
    clearTimeout(trickRetry);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    video.pause();
    video.removeAttribute('src');
    video.load(); // 接続を切ってサーバー側の ffmpeg を止める
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  let vol = 1;
  try { vol = Number(localStorage.getItem('micol.volume') ?? 1); } catch {}
  video.volume = Number.isFinite(vol) ? vol : 1;
  video.dispatchEvent(new Event('volumechange'));

  const defSub = it.subtitles.find((s) => s.supported && s.default);
  if (defSub) {
    sel('sub').value = defSub.key;
    selectSub(defSub.key);
  }

  raf = requestAnimationFrame(frame);
  poke();
  await start(startAt);
}

// ---------- 設定 ----------

/** 設定の「表示」パネル（このブラウザだけに保存される設定。すべてのユーザーが変更できる） */
function displayPanel() {
  return `<section class="panel">
    <h2>表示</h2>
    <div class="form-row" style="align-items:center">
      <span style="flex:1">サムネイルの大きさ</span>
      <div class="size-toggle" role="group" aria-label="サムネイルの大きさ">
        <button type="button" data-size="s">小</button>
        <button type="button" data-size="m">中</button>
        <button type="button" data-size="l">大</button>
      </div>
    </div>
    <p class="hint">この設定は、このブラウザ（端末）だけに保存されます。</p>
  </section>`;
}

function bindDisplay(view) {
  const toggle = $('.size-toggle', view);
  toggle.addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (b) setCardSize(b.dataset.size);
  });
  setCardSize(document.body.dataset.size); // 今の選択をボタンに反映
}

async function renderSettings(view) {
  if (!me.admin) {
    view.innerHTML = `<div class="settings"><h1 class="page-title">設定</h1>${displayPanel()}</div>`;
    bindDisplay(view);
    return;
  }
  let s;
  try {
    s = await api('/api/settings');
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>設定</h2><p>${esc(e.message)}</p></div>`;
    return;
  }

  const ENC_LABEL = {
    libx264: 'CPU (libx264)',
    h264_nvenc: 'NVIDIA (NVENC)',
    h264_qsv: 'Intel (Quick Sync)',
    h264_amf: 'AMD (AMF)',
  };

  view.innerHTML = `
    <div class="settings">
      <h1 class="page-title">設定</h1>
      ${displayPanel()}
      <section class="panel">
        <h2>ライブラリ（メディアフォルダ）</h2>
        <ul class="lib-list" id="lib-list"></ul>
        <form class="form-row" id="add-lib">
          <label class="field"><span>表示名</span><input name="name" placeholder="例: アニメ"></label>
          <label class="field grow"><span>フォルダ</span><input name="path" placeholder="例: D:\\Videos" required></label>
          <button type="button" class="btn" id="browse">参照…</button>
          <button class="btn primary">追加</button>
        </form>
        <p class="hint">フォルダ内の変更は自動で検出され、数秒後に反映されます。</p>
      </section>
      <section class="panel">
        <h2>ユーザー</h2>
        <ul class="lib-list" id="user-list"></ul>
        <form class="form-row" id="add-user">
          <label class="field"><span>ユーザー名</span><input name="name" required maxlength="32" autocomplete="off"></label>
          <label class="field"><span>パスワード（8 文字以上）</span><input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label class="check"><input type="checkbox" name="admin"> 管理者</label>
          <button class="btn primary">追加</button>
        </form>
        <p class="hint">管理者は設定の変更・ユーザー管理・アップデート・サムネイルの変更ができます。視聴履歴はユーザーごとに記録されます。</p>
      </section>
      <section class="panel">
        <h2>トランスコード</h2>
        <form class="form-row" id="tc">
          <label class="field"><span>エンコーダー</span>
            <select name="videoEncoder">${s.encoders.map((e) => `<option value="${e}">${esc(ENC_LABEL[e] || e)}</option>`).join('')}</select>
          </label>
          <label class="field"><span>最大解像度</span>
            <select name="maxHeight">${[480, 720, 1080, 1440, 2160].map((h) => `<option value="${h}">${h}p</option>`).join('')}</select>
          </label>
          <label class="field"><span>画質 (小さいほど高画質)</span><input name="quality" type="number" min="15" max="40" step="1"></label>
          <button class="btn primary">保存</button>
        </form>
        <p class="hint">ブラウザで再生できない形式（HEVC 非対応ブラウザ、10bit H.264、AVI/WMV など）のみ変換されます。GPU エンコーダーは起動時に動作確認できたものだけ表示されます。</p>
      </section>
      <section class="panel">
        <h2>スキャン</h2>
        <div class="form-row" style="align-items:center">
          <span id="status" class="muted" style="flex:1"></span>
          <button class="btn" id="scan">今すぐ再スキャン</button>
        </div>
      </section>
      <section class="panel">
        <h2>アップデート</h2>
        <div class="form-row" style="align-items:center">
          <span id="version" class="muted" style="flex:1"></span>
          <button class="btn" id="update-check">更新を確認</button>
          <button class="btn primary" id="update-apply" hidden>今すぐ更新</button>
        </div>
        <div id="update-result" class="hint"></div>
      </section>
    </div>`;

  bindDisplay(view);
  const list = $('#lib-list', view);
  const addForm = $('#add-lib', view);
  const tcForm = $('#tc', view);

  function drawLibs() {
    list.innerHTML = s.libraries.length
      ? s.libraries.map((l, i) => `<li>
          <div class="info"><div>${esc(l.name)}</div><div class="path">${esc(l.path)}</div></div>
          <button class="btn small danger" data-remove="${i}">削除</button>
        </li>`).join('')
      : '<li class="muted">まだフォルダが登録されていません</li>';
  }

  async function saveLibs(libraries) {
    const r = await api('/api/settings', { method: 'PUT', body: { libraries } });
    s.libraries = r.libraries;
    drawLibs();
    libsChanged = true; // スキャンが終わったらサイドバーに反映する
    updateStatus();
  }

  list.onclick = async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const lib = s.libraries[Number(b.dataset.remove)];
    if (!confirm(`「${lib.name}」をライブラリから外しますか？（ファイルは削除されません）`)) return;
    try {
      await saveLibs(s.libraries.filter((l) => l !== lib));
      toast('削除しました');
    } catch (err) { toast(err.message); }
  };

  addForm.onsubmit = async (e) => {
    e.preventDefault();
    const name = addForm.name.value.trim();
    const p = addForm.path.value.trim();
    try {
      await saveLibs([...s.libraries, { name, path: p }]);
      addForm.reset();
      toast('追加しました。スキャンを開始します');
    } catch (err) { toast(err.message); }
  };

  $('#browse', view).onclick = async () => {
    const p = await pickFolder(addForm.path.value.trim());
    if (!p) return;
    addForm.path.value = p;
    if (!addForm.name.value.trim()) addForm.name.value = p.split('\\').filter(Boolean).pop() || p;
  };

  tcForm.videoEncoder.value = s.transcode.videoEncoder;
  tcForm.maxHeight.value = s.transcode.maxHeight;
  tcForm.quality.value = s.transcode.quality;
  tcForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: { transcode: { videoEncoder: tcForm.videoEncoder.value, maxHeight: tcForm.maxHeight.value, quality: tcForm.quality.value } },
      });
      toast('保存しました');
    } catch (err) { toast(err.message); }
  };

  $('#scan', view).onclick = async () => {
    await api('/api/scan', { method: 'POST', body: {} });
    toast('スキャンを開始しました');
    updateStatus();
  };

  // --- 手動アップデート ---
  const checkBtn = $('#update-check', view);
  const applyBtn = $('#update-apply', view);
  const resultEl = $('#update-result', view);

  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    applyBtn.hidden = true;
    resultEl.textContent = 'GitHub を確認しています…';
    try {
      const u = await api('/api/update/check', { method: 'POST', body: {} });
      if (!u.commits.length) {
        resultEl.textContent = '最新の状態です。';
      } else {
        resultEl.innerHTML = `<div>${u.commits.length} 件の更新があります:</div><ul class="commit-list">${u.commits
          .map((c) => `<li><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">${esc(c.date)}</span></li>`)
          .join('')}</ul>${
          u.local ? '<div>この PC のリポジトリに独自のコミットがあるため、更新できません。</div>'
          : !u.supervised ? '<div>start.bat で起動しているため、ここからは更新できません。git pull してから起動し直してください。</div>'
          : ''}`;
        applyBtn.hidden = !u.supervised || u.local > 0;
      }
    } catch (err) {
      resultEl.textContent = err.message;
    }
    checkBtn.disabled = false;
  };

  applyBtn.onclick = async () => {
    if (!confirm('更新してサーバーを再起動します。再生中の人がいる場合は中断されます。よろしいですか？')) return;
    const before = (await api('/api/status')).version;
    applyBtn.disabled = checkBtn.disabled = true;
    resultEl.textContent = '更新しています…（サーバーが再起動します）';
    try {
      await api('/api/update/apply', { method: 'POST', body: {} });
    } catch (err) {
      resultEl.textContent = err.message;
      applyBtn.disabled = checkBtn.disabled = false;
      return;
    }
    // 再起動して新しいバージョンになるのを待ってから読み込み直す
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const st = await api('/api/status');
        if (st.version !== before) {
          toast(`更新しました: ${st.version}`);
          setTimeout(hardReload, 800);
          return;
        }
      } catch {}
    }
    resultEl.textContent = '更新を確認できませんでした。data/logs/micol.log を確認してください。';
    applyBtn.disabled = checkBtn.disabled = false;
  };

  let libsChanged = false;
  async function updateStatus() {
    try {
      const st = await api('/api/status');
      if (libsChanged && !st.scanning) {
        libsChanged = false;
        loadLibraries();
      }
      $('#version', view).textContent = `現在のバージョン: ${st.version}`;
      $('#status', view).textContent = [
        st.scanning ? 'スキャン中…' : '待機中',
        `${st.items} 本 / ${st.folders} フォルダ`,
        st.probePending ? `メディア解析 残り ${st.probePending} 件` : '',
      ].filter(Boolean).join(' ・ ');
    } catch {}
  }

  bindUsers(view);
  drawLibs();
  updateStatus();
  const timer = setInterval(updateStatus, 2000);
  cleanup = () => clearInterval(timer);
}

function pickFolder(initial) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-box" role="dialog" aria-label="フォルダを選択">
      <h3>フォルダを選択</h3>
      <div class="picker-path"></div>
      <ul class="picker-list"></ul>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">キャンセル</button>
        <button class="btn primary" data-act="ok">このフォルダを選択</button>
      </div>
    </div>`;
    document.body.append(modal);
    const pathEl = $('.picker-path', modal);
    const listEl = $('.picker-list', modal);
    const okBtn = $('[data-act="ok"]', modal);
    let cur = '';

    async function go(p) {
      try {
        const d = await api(`/api/fs?path=${encodeURIComponent(p || '')}`);
        cur = d.path;
        pathEl.textContent = d.path || 'PC（ドライブ一覧）';
        okBtn.disabled = !d.path;
        listEl.innerHTML =
          (d.parent !== null ? `<li data-p="${esc(d.parent)}">⬆ 上へ</li>` : '') +
          (d.dirs.length ? d.dirs.map((x) => `<li data-p="${esc(x.path)}">📁 ${esc(x.name)}</li>`).join('') : '<li class="muted">サブフォルダなし</li>');
      } catch (e) {
        toast(e.message);
        if (p) go('');
      }
    }

    const close = (v) => { modal.remove(); resolve(v); };
    listEl.onclick = (e) => {
      const li = e.target.closest('li[data-p]');
      if (li) go(li.dataset.p);
    };
    modal.onclick = (e) => {
      if (e.target === modal) close(null);
      const act = e.target.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'ok') close(cur);
    };
    go(initial);
  });
}

boot();

/**
 * スーパーリロード（Ctrl+F5 相当）。ブラウザのキャッシュを使わずに
 * ページとスクリプトを取り直してから再読み込みする
 */
async function hardReload() {
  const urls = ['/', '/index.html', '/app.js', '/app.css'];
  for (const s of document.querySelectorAll('script[src], link[rel="stylesheet"]')) urls.push(s.getAttribute('src') || s.getAttribute('href'));
  await Promise.all(urls.map((u) => fetch(u, { cache: 'reload' }).catch(() => {})));
  location.reload();
}

// ---------- ユーザー管理 ----------

function bindUsers(view) {
  const list = $('#user-list', view);
  const form = $('#add-user', view);
  let users = [];

  async function load() {
    try {
      users = await api('/api/users');
    } catch (err) { return toast(err.message); }
    list.innerHTML = users.map((u) => `<li>
      <div class="info"><div>${esc(u.name)}${u.admin ? ' <span class="tag">管理者</span>' : ''}${u.id === me.id ? ' <span class="muted">（あなた）</span>' : ''}</div></div>
      <button class="btn small" data-act="admin" data-id="${u.id}">${u.admin ? '管理者を外す' : '管理者にする'}</button>
      <button class="btn small" data-act="password" data-id="${u.id}">パスワード再設定</button>
      <button class="btn small danger" data-act="delete" data-id="${u.id}">削除</button>
    </li>`).join('');
  }

  list.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const u = users.find((x) => x.id === b.dataset.id);
    try {
      if (b.dataset.act === 'admin') {
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { admin: !u.admin } });
        if (u.id === me.id) return location.reload();
      } else if (b.dataset.act === 'password') {
        const pw = prompt(`「${u.name}」の新しいパスワード（8 文字以上）`);
        if (!pw) return;
        await api(`/api/users/${u.id}`, { method: 'PUT', body: { password: pw } });
        toast('パスワードを再設定しました');
      } else if (b.dataset.act === 'delete') {
        if (!confirm(`「${u.name}」を削除しますか？（視聴履歴も削除されます）`)) return;
        await api(`/api/users/${u.id}`, { method: 'DELETE' });
        if (u.id === me.id) return location.reload();
        toast('削除しました');
      }
      load();
    } catch (err) { toast(err.message); }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: { name: form.name.value, password: form.password.value, admin: form.admin.checked } });
      form.reset();
      toast('ユーザーを追加しました');
      load();
    } catch (err) { toast(err.message); }
  };

  load();
}

// ---------- ログイン / 初回セットアップ ----------

async function showAuth() {
  cleanup?.();
  cleanup = null;
  document.body.classList.remove('playing');
  document.body.classList.add('auth-mode');
  const view = $('#view');
  let st;
  try {
    st = await api('/api/auth/status');
  } catch (err) {
    view.innerHTML = `<div class="empty"><h2>サーバーに接続できません</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (st.user) return enterApp(st.user);

  if (st.setup && !st.canSetup) {
    view.innerHTML = `<div class="auth-box">
      <div class="logo big"><img class="logo-mark" src="/icons/icon.svg" alt="">Micol</div>
      <h2>初期設定がまだです</h2>
      <p class="muted">最初の管理者アカウントは、セキュリティのため<strong>サーバーと同じネットワーク（LAN）内</strong>から作成する必要があります。<br>
      サーバー PC か、同じ LAN の PC で <code>http://サーバーのIP:8420</code> を開いてください。</p>
    </div>`;
    return;
  }

  const setup = st.setup;
  view.innerHTML = `<form class="auth-box" id="auth-form">
    <div class="logo big"><img class="logo-mark" src="/icons/icon.svg" alt="">Micol</div>
    <h2>${setup ? '管理者アカウントを作成' : 'ログイン'}</h2>
    ${setup ? '<p class="muted">最初のユーザーが管理者になります。あとから設定画面でユーザーを追加できます。</p>' : ''}
    <label class="field"><span>ユーザー名</span><input name="name" required maxlength="32" autocomplete="username" autofocus></label>
    <label class="field"><span>パスワード${setup ? '（8 文字以上）' : ''}</span><input name="password" type="password" required ${setup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>
    ${setup ? '<label class="field"><span>パスワード（確認）</span><input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label>' : ''}
    <button class="btn primary">${setup ? '作成してはじめる' : 'ログイン'}</button>
  </form>`;
  const form = $('#auth-form', view);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (setup && form.password.value !== form.confirm.value) return toast('パスワードが一致しません');
    const btn = $('button', form);
    btn.disabled = true;
    try {
      const r = await api(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: { name: form.name.value, password: form.password.value },
      });
      enterApp(r.user);
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false;
      form.password.select();
    }
  };
}

function enterApp(user) {
  me = user;
  document.body.classList.remove('auth-mode');
  renderAccountButton();
  renderSidebar();
  loadLibraries();
  router();
}

async function boot() {
  try {
    const st = await api('/api/auth/status');
    if (st.user) return enterApp(st.user);
  } catch {}
  showAuth();
}
