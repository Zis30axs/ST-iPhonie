// 台词小窗 on the tavern page (设置 → 台词小窗, off at first): the latest story reply's voiced lines in a small pill over
// the story — and over a visual-novel sprite that may cover the waves in the text — so they can be heard one by one at
// the reader's pace. The pill says how many lines there are (or shows the one being said); a tap opens the list: tap a
// line to hear it (again to pause), 整条 plays them all, ✕ puts it away until the next reply; a tap elsewhere takes it
// back in. Drag it anywhere (kept by its middle); at the default place it lines up with the other islands at the top.
// It steps aside while the phone is out or a call is on.
import {joinStack, stackTop} from './island-stack.js';

const KEY = 'sttts.voiceIsland';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const WAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M7 7l10 10M17 7 7 17"/></svg>';
const BUSY = ['playing', 'generating'];

/**
 * enabled(): the setting is on. latest(): {id, name, lines: [{role, text, translation}]} of the latest reply with lines,
 * or null. now(): {id, index, phase} of what is being said. play(id, index): that line (again: pause/resume).
 * playAll(id): every line. phoneOpen(), callShown(): whether to step aside.
 */
export function createVoiceIsland({doc = document, enabled, latest, now, play, playAll, phoneOpen, callShown = () => false}) {
  const win = doc.defaultView;
  const el = doc.createElement('div');
  el.className = 'sttts-voice-island';
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.innerHTML = `<div class="vi-pill"><span class="vi-ico">${WAVE}</span><span class="vi-line" data-vi-line></span><span class="vi-bars" aria-hidden="true"><i></i><i></i><i></i></span></div>
    <div class="vi-card"><div class="vi-head"><span class="vi-ico">${WAVE}</span><b data-vi-title></b><button type="button" class="vi-btn vi-all" data-vi="all"></button><button type="button" class="vi-btn vi-close" data-vi="close" aria-label="收起">${CLOSE}</button></div>
      <div class="vi-list" data-vi-list></div></div>`;
  doc.body.append(el);
  let place = null, dismissed = '', reply = null, built = '', expanded = false, width = 0, openedAt = 0, dragged = false;
  try { place = JSON.parse(win.localStorage.getItem(KEY) || 'null'); } catch { /* the top middle */ }
  const free = () => !place || !Number.isFinite(place.cx) || !Number.isFinite(place.y);
  function where() {
    el.style.transform = 'translateX(-50%)';
    const w = el.offsetWidth || 220, h = el.offsetHeight || 40, vw = win.innerWidth, vh = win.innerHeight;
    width = w;
    if (free()) { el.style.left = '50%'; el.style.top = stackTop(el); return; }
    el.style.left = Math.min(vw - w / 2 - 6, Math.max(w / 2 + 6, place.cx * vw)) + 'px';
    el.style.top = Math.min(vh - Math.min(h, 120) - 6, Math.max(6, place.y * vh)) + 'px';
  }
  const leave = joinStack({el, order: 2, free, place: where});
  const key = r => r ? `${r.id}|${r.lines.length}|${r.lines[0]?.text || ''}` : '';
  const text = (sel, value) => { const p = el.querySelector(sel); if (p.textContent !== value) p.textContent = value; };

  function draw(r, s) {
    const mine = s && s.id === r.id && BUSY.includes(s.phase) ? s.index : -1, paused = s && s.id === r.id && s.phase === 'paused' ? s.index : -1;
    el.dataset.playing = mine >= 0 ? '1' : '';
    if (built !== key(r)) {
      built = key(r);
      text('[data-vi-title]', `${r.name || '台词'} · ${r.lines.length} 句`);
      el.querySelector('[data-vi-list]').innerHTML = r.lines.map((l, i) => `<button type="button" class="vi-row" data-vi-i="${i}"><b>${esc(l.role || '')}</b><span>${esc(l.translation || l.text)}</span>${l.translation && l.translation !== l.text ? `<small>${esc(l.text)}</small>` : ''}</button>`).join('');
    }
    for (const row of el.querySelectorAll('.vi-row')) {
      const i = Number(row.dataset.viI), state = i === mine ? 'playing' : i === paused ? 'paused' : '';
      if ((row.dataset.state || '') !== state) { if (state) row.dataset.state = state; else delete row.dataset.state; }
    }
    const said = mine >= 0 ? r.lines[mine] : null;
    text('[data-vi-line]', said ? `${said.role ? said.role + '：' : ''}${said.translation || said.text}` : `${r.lines.length} 句台词 · 点开挑一句听`);
    const all = el.querySelector('[data-vi=all]'), on = mine >= 0 ? 'pause' : paused >= 0 ? 'resume' : 'all';
    if (all.dataset.on !== on) { all.dataset.on = on; all.innerHTML = on === 'pause' ? `${PAUSE}<span>暂停</span>` : on === 'resume' ? `${PLAY}<span>继续</span>` : `${PLAY}<span>整条</span>`; }
    el.setAttribute('aria-label', `台词小窗：${r.name || ''} ${r.lines.length} 句。点一下展开`);
  }
  function setExpanded(on) {
    if (expanded === on) return;
    expanded = on; openedAt = on ? Date.now() : 0;
    el.dataset.expanded = on ? '1' : '';
    if (on) el.querySelector('.vi-row[data-state]')?.scrollIntoView?.({block: 'nearest'});
    (win.requestAnimationFrame || (fn => win.setTimeout(fn, 16))).call(win, where);
  }
  function refresh() {
    let r = null, s = null;
    try { r = enabled() ? latest() : null; s = r ? now() : null; } catch { r = null; }
    reply = r?.lines?.length ? r : null;
    if (reply && dismissed && dismissed !== key(reply)) dismissed = '';
    const show = reply && !phoneOpen() && !callShown() && dismissed !== key(reply);
    if (!show) { el.hidden = true; setExpanded(false); return; }
    draw(reply, s);
    if (el.hidden) { el.hidden = false; where(); }
    else if (el.offsetWidth !== width) where();
  }

  let drag = null;
  el.addEventListener('pointerdown', e => {
    if (e.button > 0 || e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = {id: e.pointerId, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, live: false};
    try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
  });
  el.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.live && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.live = true; el.dataset.dragging = '';
    place = {cx: (e.clientX - drag.dx) / win.innerWidth, y: (e.clientY - drag.dy) / win.innerHeight};
    where();
  });
  el.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.live; drag = null; delete el.dataset.dragging;
    if (moved) { dragged = true; try { win.localStorage.setItem(KEY, JSON.stringify(place)); } catch { /* this visit */ } }
  });
  el.addEventListener('pointercancel', () => { drag = null; delete el.dataset.dragging; });
  // Opening and closing happen on click, not on pointerup: a phone hit-tests the tap's click after the card has opened
  // under the finger, and that click used to land on 整条 or a line and play it. A tap in the first moment after
  // opening is that same tap, so it does nothing.
  el.addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    const b = e.target.closest('[data-vi], [data-vi-i]');
    if (!b) { if (!e.target.closest('.vi-list')) setExpanded(!expanded); return; }
    if (!reply || Date.now() - openedAt < 350) return;
    const id = reply.id;
    if (b.dataset.viI !== undefined) Promise.resolve().then(() => play(id, Number(b.dataset.viI))).catch(() => {});
    else if (b.dataset.vi === 'all') { const s = now(); Promise.resolve().then(() => s && s.id === id && [...BUSY, 'paused'].includes(s.phase) ? play(id, s.index) : playAll(id)).catch(() => {}); }
    else if (b.dataset.vi === 'close') { dismissed = key(reply); el.hidden = true; setExpanded(false); }
  });
  // A tap anywhere else takes the list back in.
  const away = e => { if (expanded && !el.contains(e.target)) setExpanded(false); };
  doc.addEventListener('pointerdown', away, true);
  const onResize = () => { if (!el.hidden) where(); };
  win.addEventListener('resize', onResize);
  return {refresh, get shown() { return !el.hidden; }, get expanded() { return expanded; },
    dispose() { leave(); doc.removeEventListener('pointerdown', away, true); win.removeEventListener('resize', onResize); el.remove(); }};
}
