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

function episodeLabel(it) {
  if (it.episode == null) return '';
  return it.season != null ? `S${it.season} E${it.episode}` : `第${it.episode}話`;
}

function itemCard(it, sub = '') {
  const pct = it.duration && it.position ? Math.min(100, (it.position / it.duration) * 100) : 0;
  sub = sub || [episodeLabel(it), it.year].filter(Boolean).join(' ・ ');
  return `<a class="card" href="#/item/${it.id}">
    <div class="thumb">
      ${thumbImg(thumbUrl(it))}
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
      ${thumbImg(`/api/folders/${f.id}/thumb`)}
      <span class="badge count">${f.count}</span>
    </div>
    <div class="card-title" title="${esc(f.name)}">${esc(f.name)}</div>
    ${f.year ? `<div class="card-sub">${f.year}</div>` : ''}
  </a>`;
}

/** NFO の概要（年・評価・ジャンル・あらすじなど） */
function nfoBlock(nfo, { people = false } = {}) {
  if (!nfo) return '';
  const meta = [
    nfo.year,
    nfo.premiered && nfo.premiered !== String(nfo.year) ? nfo.premiered : null,
    nfo.rating != null ? `★ ${nfo.rating}` : null,
    nfo.mpaa,
    ...(nfo.genres || []),
  ].filter(Boolean);
  const rows = people
    ? [
        ['原題', nfo.originalTitle],
        ['監督', nfo.directors?.join(', ')],
        ['制作', nfo.studios?.join(', ')],
        ['出演', nfo.actors?.join(', ')],
        ['タグ', nfo.tags?.join(', ')],
      ].filter(([, v]) => v)
    : [];
  return `<div class="nfo">
    ${meta.length ? `<div class="meta">${meta.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${nfo.tagline ? `<p class="tagline">${esc(nfo.tagline)}</p>` : ''}
    ${nfo.plot ? `<p class="plot">${esc(nfo.plot)}</p>` : ''}
    ${rows.length ? `<dl class="tech">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
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
document.querySelector('.size-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('[data-size]');
  if (b) setCardSize(b.dataset.size);
});

// カード上の再生ボタン（リンク内のボタンなので伝播を止める）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-play]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  location.hash = `#/play/${btn.dataset.play}`;
});

// ---------- ルーター ----------

let cleanup = null;
let routeSeq = 0;

async function router() {
  cleanup?.();
  cleanup = null;
  const seq = ++routeSeq;
  const [p, qs = ''] = (location.hash.slice(1) || '/').split('?');
  const parts = p.split('/').filter(Boolean);
  const params = new URLSearchParams(qs);
  const view = $('#view');
  document.body.classList.toggle('playing', parts[0] === 'play');
  if (parts[0] !== 'search') $('#search-form').q.value = '';
  try {
    switch (parts[0]) {
      case undefined: await renderHome(view, seq); break;
      case 'folder': await renderFolder(view, parts[1], seq); break;
      case 'item': await renderItem(view, parts[1]); break;
      case 'play': await renderPlayer(view, parts[1], params, seq); break;
      case 'search': await renderSearch(view, params.get('q') || ''); break;
      case 'settings': await renderSettings(view); break;
      default: view.innerHTML = '<div class="empty">ページが見つかりません</div>';
    }
  } catch (e) {
    if (seq === routeSeq) view.innerHTML = `<div class="empty"><h2>エラー</h2><p>${esc(e.message)}</p><a class="btn" href="#/">ホームへ</a></div>`;
  }
  if (parts[0] !== 'play') window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => me && router());

let searchTimer;
const searchForm = $('#search-form');
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
        ${nfoBlock(it.nfo, { people: true })}
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
          ${text('premiered', '公開日 (2024-01-31)', n.premiered, 'size="12"')}
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
    $('input[name="title"]', modal).focus();
  });
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

// ---------- 検索 ----------

async function renderSearch(view, q) {
  if (searchForm.q.value.trim() !== q) searchForm.q.value = q;
  const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
  view.innerHTML = `<h1 class="page-title">「${esc(q)}」の検索結果</h1>
    ${d.folders.length ? section('フォルダ', `<div class="grid">${d.folders.map(folderCard).join('')}</div>`) : ''}
    ${d.items.length ? section('動画', `<div class="grid">${d.items.map((it) => itemCard(it)).join('')}</div>`) : ''}
    ${!d.folders.length && !d.items.length ? '<div class="empty">見つかりませんでした</div>' : ''}`;
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
          <button class="pbtn hide-sm" data-a="rew" title="10秒戻る (←)">${ICON.rew}</button>
          <button class="pbtn hide-sm" data-a="fwd" title="10秒進む (→)">${ICON.fwd}</button>
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
  btn('rew').onclick = () => seek(current() - 10);
  btn('fwd').onclick = () => seek(current() + 10);
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
    else if (k === 'ArrowLeft' || k === 'j') seek(current() - (k === 'j' ? 30 : 10));
    else if (k === 'ArrowRight' || k === 'l') seek(current() + (k === 'l' ? 30 : 10));
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

async function renderSettings(view) {
  if (!me.admin) {
    view.innerHTML = `<div class="settings"><h1 class="page-title">設定</h1>${accountPanel()}</div>`;
    bindAccount(view);
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
      ${accountPanel()}
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

  async function updateStatus() {
    try {
      const st = await api('/api/status');
      $('#version', view).textContent = `現在のバージョン: ${st.version}`;
      $('#status', view).textContent = [
        st.scanning ? 'スキャン中…' : '待機中',
        `${st.items} 本 / ${st.folders} フォルダ`,
        st.probePending ? `メディア解析 残り ${st.probePending} 件` : '',
      ].filter(Boolean).join(' ・ ');
    } catch {}
  }

  bindAccount(view);
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

// ---------- アカウント ----------

function accountPanel() {
  return `<section class="panel">
    <h2>アカウント</h2>
    <div class="form-row" style="align-items:center">
      <span style="flex:1">${esc(me.name)} としてログイン中${me.admin ? '（管理者）' : ''}</span>
      <button class="btn" id="logout">ログアウト</button>
    </div>
    <form class="form-row" id="pw-form">
      <label class="field"><span>現在のパスワード</span><input type="password" name="current" required autocomplete="current-password"></label>
      <label class="field"><span>新しいパスワード</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field"><span>新しいパスワード（確認）</span><input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
      <button class="btn">パスワードを変更</button>
    </form>
  </section>`;
}

function bindAccount(view) {
  $('#logout', view).onclick = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    me = null;
    showAuth();
  };
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
  router();
}

async function boot() {
  try {
    const st = await api('/api/auth/status');
    if (st.user) return enterApp(st.user);
  } catch {}
  showAuth();
}
