// 画画的画面: shows the picture turned, moved and zoomed, and turns pens, fingers and the mouse into strokes and
// gestures, as on Procreate:
// - a pen, a finger or the mouse draws; once a pen has been seen, fingers no longer draw (the palm can rest);
// - two fingers pinch, turn and move the picture; a quick two-finger tap undoes, three fingers redo;
// - holding still for a moment picks the colour under the point;
// - on a computer: the wheel zooms where the pointer is, space or the middle button drags the picture.
import {beginStroke, extendStroke, endStroke, compose, colorAt, steady} from './engine.js';

const HOLD = 480, TAP = 280;
/** The view's turn, place and zoom: picture point → screen point, and back. */
export function viewMath(t) {
  const cos = Math.cos(t.angle), sin = Math.sin(t.angle);
  return {
    toScreen: (x, y) => ({x: t.x + (x * cos - y * sin) * t.scale, y: t.y + (x * sin + y * cos) * t.scale}),
    toPicture: (x, y) => { const dx = (x - t.x) / t.scale, dy = (y - t.y) / t.scale; return {x: dx * cos + dy * sin, y: -dx * sin + dy * cos}; },
  };
}
/** The view that shows the whole picture in a box w×h, upright. */
export function fitView(pic, w, h) {
  const scale = Math.min((w - 24) / pic.width, (h - 24) / pic.height);
  return {scale, angle: 0, x: (w - pic.width * scale) / 2, y: (h - pic.height * scale) / 2};
}

/**
 * host: the element the canvas fills. tool(): {kind: 'brush'|'eraser'|'pick', brush, size, opacity, color}.
 * picked(color): the eyedropper found a colour. stroked(): a stroke went onto the picture. undo(), redo().
 */
export function createStage({doc, win, host, pic, tool, picked, stroked, undo, redo}) {
  const canvas = doc.createElement('canvas');
  canvas.className = 'paint-view';
  canvas.style.touchAction = 'none';
  host.append(canvas);
  const g = canvas.getContext('2d');
  const scratch = (() => { const c = doc.createElement('canvas'); c.width = pic.width; c.height = pic.height; return {canvas: c, g: c.getContext('2d')}; })();
  let w = 0, h = 0, ratio = 1, view = null, raf = 0, penSeen = false, spaceDown = false;
  const pointers = new Map();
  let drawing = null, gesture = null, panning = null, taps = null;

  function size() {
    const r = host.getBoundingClientRect();
    ratio = Math.min(3, win.devicePixelRatio || 1);
    w = Math.max(1, r.width); h = Math.max(1, r.height);
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    if (!view) view = fitView(pic, w, h);
    render();
  }
  function render() {
    win.cancelAnimationFrame(raf); raf = 0;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.translate(view.x, view.y); g.rotate(view.angle); g.scale(view.scale, view.scale);
    g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 18 / view.scale;
    g.fillStyle = '#fff'; g.fillRect(0, 0, pic.width, pic.height);
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    if (!pic.showBackground) checker();
    g.imageSmoothingEnabled = view.scale < 2;
    compose(pic, g, {scratch});
  }
  // Behind a picture without its background: a light chequer, so what is see-through shows.
  function checker() {
    const cell = 16 / view.scale;
    g.fillStyle = '#e6e6ea';
    for (let y = 0; y < pic.height; y += cell) for (let x = (Math.floor(y / cell) % 2) * cell; x < pic.width; x += cell * 2) g.fillRect(x, y, Math.min(cell, pic.width - x), Math.min(cell, pic.height - y));
  }
  const later = () => { if (!raf) raf = win.requestAnimationFrame(render); };
  const local = e => { const r = canvas.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; };
  // Pressure: a pen's own; a mouse or a finger (most report nothing useful) presses fully.
  const pressure = e => e.pointerType === 'pen' ? Math.max(.02, e.pressure || 0) : 1;
  function point(e) { const s = local(e), p = viewMath(view).toPicture(s.x, s.y); return {x: p.x, y: p.y, p: pressure(e), sx: s.x, sy: s.y}; }

  function startDrawing(e) {
    const t = tool(), at = point(e);
    if (t.kind === 'pick') { drawing = {id: e.pointerId, pick: true}; pick(at); return; }
    const brush = {...t.brush, opacity: t.brush.opacity * t.opacity};
    drawing = {id: e.pointerId, start: at, smooth: at, raw: at, moved: 0, at: Date.now(), streamline: brush.streamline};
    beginStroke(pic, {brush, size: t.size, color: t.color, erase: t.kind === 'eraser'}, at);
    // Held still: the eyedropper instead.
    drawing.hold = win.setTimeout(() => { if (drawing && !drawing.pick && drawing.moved < 6) { endStroke(pic, {cancel: true}); drawing.pick = true; pick(drawing.raw); later(); } }, HOLD);
    later();
  }
  function moveDrawing(e) {
    if (drawing.pick) { pick(point(e)); return; }
    const list = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    for (const ev of list) {
      const raw = point(ev);
      drawing.moved = Math.max(drawing.moved, Math.hypot(raw.sx - drawing.start.sx, raw.sy - drawing.start.sy));
      drawing.raw = raw;
      drawing.smooth = steady(drawing.smooth, raw, drawing.streamline);
      extendStroke(pic, drawing.smooth);
    }
    later();
  }
  function endDrawing(cancel = false) {
    const d = drawing;
    drawing = null;
    if (!d) return;
    win.clearTimeout(d.hold);
    if (d.pick) return;
    // The steadied line catches up with where the pen lifted.
    if (!cancel && d.raw && d.raw !== d.smooth) extendStroke(pic, d.raw);
    if (endStroke(pic, {cancel})) stroked();
    later();
  }
  function pick(at) { const c = colorAt(pic, at.x, at.y); if (c) picked(c); }

  // ---------- two fingers ----------
  const two = () => [...pointers.values()].filter(p => p.type === 'touch').slice(0, 2);
  function startGesture() {
    const [a, b] = two();
    gesture = {view: {...view}, mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, angle: Math.atan2(b.y - a.y, b.x - a.x)};
  }
  function moveGesture() {
    const [a, b] = two();
    if (!a || !b) return;
    const mid = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, scale = Math.min(40, Math.max(.05, gesture.view.scale * Math.hypot(b.x - a.x, b.y - a.y) / gesture.dist));
    let angle = gesture.view.angle + Math.atan2(b.y - a.y, b.x - a.x) - gesture.angle;
    // Close to upright, it snaps upright.
    const turns = angle / (Math.PI / 2), near = Math.round(turns);
    if (Math.abs(turns - near) < .04) angle = near * Math.PI / 2;
    const p = viewMath(gesture.view).toPicture(gesture.mid.x, gesture.mid.y), cos = Math.cos(angle), sin = Math.sin(angle);
    view = {scale, angle, x: mid.x - (p.x * cos - p.y * sin) * scale, y: mid.y - (p.x * sin + p.y * cos) * scale};
    later();
  }
  function zoomAt(x, y, factor) {
    const p = viewMath(view).toPicture(x, y), scale = Math.min(40, Math.max(.05, view.scale * factor)), cos = Math.cos(view.angle), sin = Math.sin(view.angle);
    view = {...view, scale, x: x - (p.x * cos - p.y * sin) * scale, y: y - (p.x * sin + p.y * cos) * scale};
    later();
  }

  canvas.addEventListener('pointerdown', e => {
    const s = local(e);
    pointers.set(e.pointerId, {x: s.x, y: s.y, type: e.pointerType});
    try { canvas.setPointerCapture(e.pointerId); } catch { /* a pointer no longer tracked */ }
    if (e.pointerType === 'pen') penSeen = true;
    if (e.pointerType === 'touch') {
      const touches = [...pointers.values()].filter(p => p.type === 'touch').length;
      taps = touches === 1 ? {at: Date.now(), most: 1, moved: 0} : taps && {...taps, most: Math.max(taps.most, touches)};
      if (touches >= 2) {
        // A second finger soon after the first: it was a gesture, not a stroke.
        if (drawing && pointers.get(drawing.id)?.type === 'touch') endDrawing(Date.now() - drawing.at < 260 || drawing.moved < 12);
        if (touches === 2) startGesture();
        return;
      }
      if (penSeen) return;
    }
    if (e.button === 1 || (e.button === 0 && spaceDown)) { panning = {x: s.x, y: s.y, view: {...view}}; e.preventDefault(); return; }
    if (e.button > 0 || drawing) return;
    startDrawing(e);
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const s = local(e);
    if (taps && p.type === 'touch') taps.moved = Math.max(taps.moved, Math.hypot(s.x - p.x, s.y - p.y));
    p.x = s.x; p.y = s.y;
    if (gesture && p.type === 'touch') { moveGesture(); return; }
    if (panning) { view = {...panning.view, x: panning.view.x + s.x - panning.x, y: panning.view.y + s.y - panning.y}; later(); return; }
    if (drawing?.id === e.pointerId) moveDrawing(e);
  });
  const up = e => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (drawing?.id === e.pointerId) endDrawing(e.type === 'pointercancel');
    if (panning && !pointers.size) panning = null;
    if (p?.type === 'touch') {
      const left = [...pointers.values()].filter(x => x.type === 'touch').length;
      if (left < 2) gesture = null;
      if (!left && taps) {
        // A quick tap with two fingers undoes, with three redoes.
        if (Date.now() - taps.at < TAP + 120 && taps.moved < 14) { if (taps.most === 2) undo(); if (taps.most === 3) redo(); }
        taps = null;
      }
    }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => { e.preventDefault(); const s = local(e); zoomAt(s.x, s.y, Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015))); }, {passive: false});
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  const resize = win.ResizeObserver ? new win.ResizeObserver(() => size()) : null;
  resize?.observe(host);
  size();

  return {
    render: later,
    fit() { view = fitView(pic, w, h); later(); },
    zoomBy(factor) { zoomAt(w / 2, h / 2, factor); },
    /** Space held: the picture is dragged instead of drawn on. */
    space(on) { spaceDown = on; canvas.style.cursor = on ? 'grab' : ''; },
    get view() { return {...view}; },
    get busy() { return !!drawing; },
    dispose() { resize?.disconnect(); win.cancelAnimationFrame(raf); if (drawing) endDrawing(true); canvas.remove(); },
  };
}
