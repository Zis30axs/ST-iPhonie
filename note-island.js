// 动态小窗 on the tavern page: something happened in 朋友圈 while the phone is put away — a character posted, someone
// liked or commented on the user's post, someone answered the user's comment. A small dynamic-island card drops in
// with who and what, and goes again after a few seconds (not while a pointer rests on it). A tap opens the phone on
// 动态; × puts it away. Several at once: the newest shows, with how many more there are.
// What is new is found by comparing 朋友圈 with how it was the time before (watchMoments): likes have no time of their own.
// It wears the call island's look (style.css .sttts-call-island).

import {joinStack, stackTop} from './island-stack.js';
import {inSpace} from './core/chat.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>';
const STAY = 7000;

/** One line for a notice: {who, text}. */
export function noteLine(n) {
  const who = n.who.join('、');
  if (n.kind === 'post') return {who: n.who[0], text: `发了一条朋友圈${n.text ? '：' + n.text : ''}`};
  if (n.kind === 'like') return {who, text: '赞了你的动态'};
  if (n.kind === 'reply') return {who: n.who[0], text: `回复了你：${n.text}`};
  return {who: n.who[0], text: `评论了你的动态：${n.text}`};
}

/**
 * What changed in 朋友圈 that the user would want to hear of, between two lists of posts (before: null = nothing to
 * compare with yet). [{kind: 'post'|'like'|'comment'|'reply', who: [names], text, postId}].
 */
export function momentNotes(before, posts) {
  if (!before) return [];
  const old = new Map(before.map(p => [p.id, p])), out = [];
  for (const p of posts) {
    const was = old.get(p.id);
    if (!was && p.author !== 'me') out.push({kind: 'post', who: [p.author], text: String(p.text || (p.photoId || p.imageTags ? '[图片]' : '')).slice(0, 120), postId: p.id});
    if (p.author === 'me') {
      const liked = (p.likes || []).filter(n => n !== 'me' && !(was?.likes || []).includes(n));
      if (liked.length) out.push({kind: 'like', who: liked, text: '', postId: p.id});
    }
    const seen = new Set((was?.comments || []).map(c => c.id));
    for (const c of p.comments || []) {
      if (c.from === 'me' || seen.has(c.id)) continue;
      if (c.to === 'me') out.push({kind: 'reply', who: [c.from], text: c.text.slice(0, 120), postId: p.id});
      else if (p.author === 'me' && !c.to) out.push({kind: 'comment', who: [c.from], text: c.text.slice(0, 120), postId: p.id});
    }
  }
  return out;
}

/**
 * Watches 朋友圈 (backend 'moments' events) and tells notify(notes) what is new in this card's 朋友圈. Moving to another
 * card (分区) or a first look only takes note of how things are.
 */
export function watchMoments({backend, notify}) {
  let before = null, key = null, running = Promise.resolve();
  const look = () => { running = running.then(async () => {
    const here = backend.here?.(), now = JSON.stringify(here || null);
    const posts = (await backend.moments.list()).filter(p => inSpace(p, here));
    const notes = now === key ? momentNotes(before, posts) : [];
    before = posts.map(p => ({id: p.id, author: p.author, likes: [...(p.likes || [])], comments: (p.comments || []).map(c => ({id: c.id}))}));
    key = now;
    if (notes.length) notify(notes);
  }).catch(() => {}); return running; };
  const off = backend.subscribe?.(e => { if (e?.type === 'moments') look(); });
  look();
  return {look, dispose() { if (typeof off === 'function') off(); }};
}

/**
 * doc: the tavern page. phoneOpen(): whether the phone is showing. open(): the phone on 动态. avatar(name): a picture
 * URL or ''. label(name): the name the user gave them. Returns {show(notes), refresh(), dispose()}.
 */
export function createNoteIsland({doc = document, phoneOpen, open, avatar = () => '', label = name => name}) {
  const win = doc.defaultView;
  const el = doc.createElement('div');
  el.className = 'sttts-call-island sttts-note-island';
  el.dataset.kind = 'note';
  el.hidden = true;
  el.setAttribute('role', 'status');
  doc.body.append(el);
  let count = 0, timer = 0, resting = false;
  const where = () => { el.style.left = '50%'; el.style.top = stackTop(el); el.style.transform = 'translateX(-50%)'; el.style.setProperty('--ci-from', 'translateX(-50%)'); };
  const leave = joinStack({el, order: 1.5, free: () => true, place: where});
  function hide() { el.hidden = true; count = 0; win.clearTimeout(timer); }
  function later() { win.clearTimeout(timer); timer = win.setTimeout(() => { if (!resting) hide(); else later(); }, STAY); }
  /** New 朋友圈 notices: the newest shows, the count of the rest beside it. */
  function show(notes) {
    if (!notes?.length || phoneOpen()) return;
    count = (el.hidden ? 0 : count) + notes.length;
    const last = notes.at(-1), line = noteLine({...last, who: last.who.map(n => label(n) || n)}), pic = avatar(last.who[0]);
    el.innerHTML = `<button type="button" class="ci-head ni-open" data-ni="open" aria-label="打开朋友圈：${esc(line.who)} ${esc(line.text)}">
        <span class="ci-av">${pic ? `<img src="${esc(pic)}" alt="">` : esc(String(line.who || '?').slice(0, 1))}</span>
        <span class="ci-text"><b>${esc(line.who)}<em> · 朋友圈</em></b><small>${esc(line.text)}</small></span>
        ${count > 1 ? `<span class="ni-more">+${count - 1}</span>` : ''}</button>
      <button type="button" class="ci-end ci-close" data-ni="close" aria-label="收起">${CLOSE}</button>`;
    if (el.hidden) { el.hidden = false; where(); }
    later();
  }
  el.addEventListener('pointerenter', () => { resting = true; });
  el.addEventListener('pointerleave', () => { resting = false; });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-ni]');
    if (!b) return;
    hide();
    if (b.dataset.ni === 'open') open();
  });
  const onResize = () => { if (!el.hidden) where(); };
  win.addEventListener('resize', onResize);
  return {
    show,
    /** The phone was taken out: the card goes (动态 shows it there). */
    refresh() { if (phoneOpen() && !el.hidden) hide(); },
    get shown() { return !el.hidden; },
    dispose() { leave(); win.clearTimeout(timer); win.removeEventListener('resize', onResize); el.remove(); },
  };
}
