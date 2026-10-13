// The dynamic islands on the tavern page (通话, 消息, 台词, 音乐) that sit at their default place line up under each
// other at the top middle instead of covering each other; one the user dragged somewhere stays where it was put.
// An island joins with its order (smaller is higher), whether it is at the default place, and how to draw its place
// again; it is laid out again whenever one of them shows, hides or changes size.

const GAP = 8;
const all = new Set(), queued = new WeakSet();

/** entry: {el, order, free(): true at the default place, place(): draws its place again}. Returns a function to leave. */
export function joinStack(entry) {
  const win = entry.el.ownerDocument.defaultView;
  all.add(entry);
  const again = () => restack(win);
  const watch = win.MutationObserver ? new win.MutationObserver(again) : null;
  watch?.observe(entry.el, {attributes: true, attributeFilter: ['hidden', 'data-expanded']});
  const size = win.ResizeObserver ? new win.ResizeObserver(again) : null;
  size?.observe(entry.el);
  return () => { all.delete(entry); watch?.disconnect(); size?.disconnect(); again(); };
}

/** How far below the top an island at the default place sits: under the shown ones before it that are there too. */
export function stackOffset(el) {
  let y = 0;
  for (const x of [...all].filter(x => x.el.ownerDocument === el.ownerDocument).sort((a, b) => a.order - b.order)) {
    if (x.el === el) return y;
    if (!x.el.hidden && x.free()) y += (x.el.offsetHeight || 40) + GAP;
  }
  return y;
}

/** The top of an island at the default place, as a CSS value. */
export const stackTop = el => `calc(max(10px, env(safe-area-inset-top)) + ${stackOffset(el)}px)`;

function restack(win) {
  if (queued.has(win)) return;
  queued.add(win);
  (win.requestAnimationFrame || (fn => win.setTimeout(fn, 16))).call(win, () => {
    queued.delete(win);
    for (const x of all) if (x.el.ownerDocument === win.document && !x.el.hidden && x.free()) x.place();
  });
}
