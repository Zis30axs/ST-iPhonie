// 音乐小窗 on the tavern page: while a song plays and the phone is put away, a dynamic-island card floats over the story
// with the song, its lyric line as it is sung (the line before and after fade around it), and play/pause and next. Drag
// it by the card (the place is remembered); a double tap opens the phone's 音乐; ✕ puts it away until the next song.
// It steps aside while the call island is up.

const KEY = 'sttts.musicIsland';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6l8.5 6L6 18zM16 6h2v12h-2z"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M7 7l10 10M17 7 7 17"/></svg>';

/** status(): musicHost.status(). phoneOpen(), callShown(): whether to step aside. open(): the phone's 音乐. */
export function createMusicIsland({doc = document, status, phoneOpen, callShown = () => false, open, toggle, next}) {
  const win = doc.defaultView;
  const el = doc.createElement('div');
  el.className = 'sttts-music-island';
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.innerHTML = `<div class="mi-row"><span class="mi-disc" aria-hidden="true"><i></i></span><span class="mi-text"><b data-mi-title></b><small data-mi-sub></small></span>
    <button type="button" class="mi-btn" data-mi="toggle"></button><button type="button" class="mi-btn" data-mi="next" aria-label="下一首">${NEXT}</button><button type="button" class="mi-btn mi-close" data-mi="close" aria-label="收起">${CLOSE}</button></div>
    <div class="mi-lyrics" aria-live="polite"><p data-mi-prev></p><p class="now" data-mi-now></p><p data-mi-next></p></div>`;
  doc.body.append(el);
  let place = null, dismissed = '', now = null, built = '';
  try { place = JSON.parse(win.localStorage.getItem(KEY) || 'null'); } catch { /* top middle */ }
  function where() {
    if (!place || !Number.isFinite(place.x) || !Number.isFinite(place.y)) { el.style.left = '50%'; el.style.top = 'max(10px, env(safe-area-inset-top))'; el.style.transform = 'translateX(-50%)'; return; }
    const w = el.offsetWidth || 300, h = el.offsetHeight || 80, vw = win.innerWidth, vh = win.innerHeight;
    el.style.transform = 'none';
    el.style.left = Math.min(vw - w - 6, Math.max(6, place.x * vw)) + 'px';
    el.style.top = Math.min(vh - h - 6, Math.max(6, place.y * vh)) + 'px';
  }
  const key = s => s?.track ? `${s.track.title}|${s.track.artist}` : '';
  function draw(s) {
    const t = s.track, lines = s.lyrics || [], i = s.lyricIndex ?? -1;
    if (built !== key(s)) { built = key(s); el.querySelector('[data-mi-title]').textContent = t.title; el.querySelector('[data-mi-sub]').textContent = t.artist || (t.from === 'bgm' ? '背景音乐' : ''); }
    const playing = s.phase === 'playing';
    el.dataset.playing = playing ? '1' : '';
    const b = el.querySelector('[data-mi=toggle]');
    b.innerHTML = playing ? PAUSE : PLAY; b.setAttribute('aria-label', playing ? '暂停' : '播放');
    const set = (sel, text) => { const p = el.querySelector(sel); if (p.textContent !== text) p.textContent = text; };
    if (lines.length) { set('[data-mi-prev]', lines[i - 1]?.text || ''); set('[data-mi-now]', i >= 0 ? lines[i].text || '♪' : '♪'); set('[data-mi-next]', lines[i + 1]?.text || ''); }
    else { set('[data-mi-prev]', ''); set('[data-mi-now]', s.phase === 'loading' ? '正在找这首歌……' : s.phase === 'error' ? s.message : '♪ 这首歌没有歌词'); set('[data-mi-next]', ''); }
    el.setAttribute('aria-label', `正在放 ${t.title}${t.artist ? ' - ' + t.artist : ''}。双击打开音乐`);
  }
  /** Shown while a song is on (playing, paused or loading), the phone is away, no call island, and not put away. */
  function refresh() {
    try { now = status(); } catch { now = null; }
    const on = now?.track && ['playing', 'paused', 'loading', 'error'].includes(now.phase);
    if (on && dismissed && dismissed !== key(now)) dismissed = '';
    const show = on && !phoneOpen() && !callShown() && dismissed !== key(now);
    if (!show) { el.hidden = true; return; }
    draw(now);
    if (el.hidden) { el.hidden = false; where(); }
  }

  let drag = null, lastTap = null;
  el.addEventListener('pointerdown', e => {
    if (e.button > 0 || e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = {id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, live: false};
    try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
  });
  el.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.live && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.live = true; el.dataset.dragging = '';
    place = {x: (e.clientX - drag.dx) / win.innerWidth, y: (e.clientY - drag.dy) / win.innerHeight};
    where();
  });
  const drop = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag.live; drag = null; delete el.dataset.dragging;
    if (was) { lastTap = null; try { win.localStorage.setItem(KEY, JSON.stringify(place)); } catch { /* this visit */ } }
    return was;
  };
  el.addEventListener('pointerup', e => {
    if (drop(e) || e.target.closest('button')) return;
    const t = Date.now();
    if (lastTap && t - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { lastTap = null; open(); return; }
    lastTap = {t, x: e.clientX, y: e.clientY};
  });
  el.addEventListener('pointercancel', drop);
  el.addEventListener('dblclick', e => e.preventDefault());
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    if (b.dataset.mi === 'toggle') Promise.resolve().then(toggle).catch(() => {});
    if (b.dataset.mi === 'next') Promise.resolve().then(next).catch(() => {});
    if (b.dataset.mi === 'close') { dismissed = key(now); el.hidden = true; }
  });
  const onResize = () => { if (!el.hidden) where(); };
  win.addEventListener('resize', onResize);
  return {refresh, get shown() { return !el.hidden; }, dispose() { win.removeEventListener('resize', onResize); el.remove(); }};
}
