// 画画的画布: a picture of layers, strokes stamped with a brush tip, undo and redo.
// A stroke is stamped into a buffer as big as the picture (each stamp leaves `flow`); when it ends, the buffer goes
// onto the layer at the brush's opacity (or, erasing, takes that much away). So one stroke never gets darker than its
// opacity however often it crosses itself, as on Procreate. Undo keeps the pixels a change touched, before and after.
import {coloredTip} from './brushes.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
let ids = 0;
const newId = () => 'L' + Date.now().toString(36) + (ids++).toString(36);
function canvasOf(doc, w, h) { const c = doc.createElement('canvas'); c.width = w; c.height = h; return {canvas: c, g: c.getContext('2d', {willReadFrequently: false})}; }

/** Where stamps go from `from` to `to` (each {x, y, p}), `spacing` px apart, `carry` px already gone since the last one. */
export function stampsBetween(from, to, spacing, carry = 0) {
  const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy), out = [];
  let at = spacing - carry;
  while (at <= dist) { const t = dist ? at / dist : 0; out.push({x: from.x + dx * t, y: from.y + dy * t, p: from.p + (to.p - from.p) * t}); at += spacing; }
  return {stamps: out, carry: dist - (at - spacing)};
}
/** A stamp's size and how much it leaves, at pressure p (0–1). */
export function stampOf(brush, size, p) {
  const curve = Math.pow(clamp(p, 0, 1), 1.4);
  return {size: Math.max(.5, size * (1 - brush.pressureSize * (1 - curve))), alpha: brush.flow * (1 - brush.pressureOpacity * (1 - curve))};
}
/** The line steadied: the pen point is followed only part of the way (streamline 0–1). */
export const steady = (last, point, streamline) => !last ? point : {x: last.x + (point.x - last.x) * (1 - streamline * .88), y: last.y + (point.y - last.y) * (1 - streamline * .88), p: point.p};

/**
 * A picture: {width, height, background, showBackground, layers: [{id, name, canvas, g, opacity, visible}] (bottom
 * first), active (a layer id)}. From saved layers ({id, name, opacity, visible, image}) when there are some.
 */
export function createPicture(doc, {width, height, background = '#ffffff', showBackground = true, layers = null, active = ''}) {
  const pic = {doc, width, height, background, showBackground, layers: [], active: '', history: [], future: [], stroke: null, changed: 0};
  const buffer = canvasOf(doc, width, height);
  pic.buffer = buffer;
  for (const l of layers || [{name: '图层 1'}]) {
    const {canvas, g} = canvasOf(doc, width, height);
    if (l.image && g) g.drawImage(l.image, 0, 0);
    pic.layers.push({id: l.id || newId(), name: l.name || `图层 ${pic.layers.length + 1}`, canvas, g, opacity: Number.isFinite(l.opacity) ? l.opacity : 1, visible: l.visible !== false});
  }
  pic.active = pic.layers.some(l => l.id === active) ? active : pic.layers.at(-1).id;
  return pic;
}
export const activeLayer = pic => pic.layers.find(l => l.id === pic.active) || pic.layers.at(-1);
const MAX_PIXELS = 30e6;
function remember(pic, step) {
  pic.history.push(step); pic.future = []; pic.changed++;
  // Not more than so many pixels kept for undo (a few strokes over the whole picture take a lot).
  let total = pic.history.reduce((n, s) => n + (s.pixels || 0), 0);
  while (pic.history.length > 1 && (pic.history.length > 60 || total > MAX_PIXELS)) total -= pic.history.shift().pixels || 0;
}

// ---------- strokes ----------
/** Starts a stroke: brush, size (px), color ('#rrggbb'), erase. The first point stamps at once. */
export function beginStroke(pic, {brush, size, color, erase = false}, point) {
  const layer = activeLayer(pic);
  pic.buffer.g?.clearRect(0, 0, pic.width, pic.height);
  pic.stroke = {brush, size, erase, layer, tip: coloredTip(pic.doc, brush, erase ? '#000000' : color), last: point, carry: 0, box: null};
  stamp(pic, point);
}
function stamp(pic, {x, y, p}) {
  const s = pic.stroke, {size, alpha} = stampOf(s.brush, s.size, p), g = pic.buffer.g;
  const jitter = s.brush.jitter * size;
  const cx = x + (jitter ? (Math.random() - .5) * 2 * jitter : 0), cy = y + (jitter ? (Math.random() - .5) * 2 * jitter : 0);
  if (g) { g.globalAlpha = clamp(alpha, 0, 1); g.drawImage(s.tip, cx - size / 2, cy - size / 2, size, size); }
  const r = size / 2 + 2, box = [Math.floor(cx - r), Math.floor(cy - r), Math.ceil(cx + r), Math.ceil(cy + r)];
  s.box = s.box ? [Math.min(s.box[0], box[0]), Math.min(s.box[1], box[1]), Math.max(s.box[2], box[2]), Math.max(s.box[3], box[3])] : box;
}
/** The stroke goes on to `point`: stamps along the way. */
export function extendStroke(pic, point) {
  const s = pic.stroke;
  if (!s) return;
  const spacing = Math.max(.5, s.size * s.brush.spacing * Math.max(.2, stampOf(s.brush, 1, (s.last.p + point.p) / 2).size));
  const {stamps, carry} = stampsBetween(s.last, point, spacing, s.carry);
  for (const st of stamps) stamp(pic, st);
  s.carry = carry; s.last = point;
}
const boxIn = (pic, b) => { const x = clamp(b[0], 0, pic.width), y = clamp(b[1], 0, pic.height); return [x, y, clamp(b[2], 0, pic.width) - x, clamp(b[3], 0, pic.height) - y]; };
/** The stroke goes onto its layer (undoable). cancel: it is dropped instead. */
export function endStroke(pic, {cancel = false} = {}) {
  const s = pic.stroke;
  pic.stroke = null;
  if (!s || cancel || !s.box) { pic.buffer.g?.clearRect(0, 0, pic.width, pic.height); return false; }
  const [x, y, w, h] = boxIn(pic, s.box), g = s.layer.g;
  if (!w || !h || !g) return false;
  const before = g.getImageData(x, y, w, h);
  g.save(); g.globalAlpha = s.brush.opacity; g.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  g.drawImage(pic.buffer.canvas, x, y, w, h, x, y, w, h); g.restore();
  remember(pic, {kind: 'pixels', layer: s.layer.id, x, y, before, after: g.getImageData(x, y, w, h), pixels: w * h * 2});
  pic.buffer.g.clearRect(x, y, w, h);
  return true;
}

// ---------- undo ----------
function restore(pic, step, which) {
  if (step.kind === 'pixels') { pic.layers.find(l => l.id === step.layer)?.g?.putImageData(step[which], step.x, step.y); return; }
  if (step.kind === 'layer') {
    // A layer added (which 'after') or taken away (which 'before' has it).
    const there = which === 'after' ? step.added : !step.added;
    const at = pic.layers.findIndex(l => l.id === step.layer.id);
    if (there && at < 0) pic.layers.splice(Math.min(step.index, pic.layers.length), 0, step.layer);
    if (!there && at >= 0 && pic.layers.length > 1) pic.layers.splice(at, 1);
    if (!pic.layers.some(l => l.id === pic.active)) pic.active = pic.layers[Math.min(step.index, pic.layers.length - 1)].id;
    else if (there) pic.active = step.layer.id;
    return;
  }
  if (step.kind === 'order') { const order = step[which]; pic.layers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); }
}
export function undo(pic) { const step = pic.history.pop(); if (!step) return false; restore(pic, step, 'before'); pic.future.push(step); pic.changed++; return true; }
export function redo(pic) { const step = pic.future.pop(); if (!step) return false; restore(pic, step, 'after'); pic.history.push(step); pic.changed++; return true; }

// ---------- layers ----------
export function addLayer(pic) {
  const {canvas, g} = canvasOf(pic.doc, pic.width, pic.height), at = pic.layers.findIndex(l => l.id === pic.active) + 1;
  const layer = {id: newId(), name: `图层 ${pic.layers.length + 1}`, canvas, g, opacity: 1, visible: true};
  pic.layers.splice(at, 0, layer); pic.active = layer.id;
  remember(pic, {kind: 'layer', layer, index: at, added: true});
  return layer;
}
export function removeLayer(pic, id) {
  if (pic.layers.length < 2) return false;
  const at = pic.layers.findIndex(l => l.id === id);
  if (at < 0) return false;
  const [layer] = pic.layers.splice(at, 1);
  if (pic.active === id) pic.active = pic.layers[Math.max(0, at - 1)].id;
  remember(pic, {kind: 'layer', layer, index: at, added: false, pixels: pic.width * pic.height});
  return true;
}
/** Moves a layer up (1) or down (-1) the stack. */
export function moveLayer(pic, id, by) {
  const at = pic.layers.findIndex(l => l.id === id), to = at + by;
  if (at < 0 || to < 0 || to >= pic.layers.length) return false;
  const before = pic.layers.map(l => l.id);
  [pic.layers[at], pic.layers[to]] = [pic.layers[to], pic.layers[at]];
  remember(pic, {kind: 'order', before, after: pic.layers.map(l => l.id)});
  return true;
}
/** Empties a layer (undoable). */
export function clearLayer(pic, id) {
  const layer = pic.layers.find(l => l.id === id);
  if (!layer?.g) return false;
  const before = layer.g.getImageData(0, 0, pic.width, pic.height);
  layer.g.clearRect(0, 0, pic.width, pic.height);
  remember(pic, {kind: 'pixels', layer: id, x: 0, y: 0, before, after: layer.g.getImageData(0, 0, pic.width, pic.height), pixels: pic.width * pic.height * 2});
  return true;
}

// ---------- seeing it ----------
/** Draws the picture into g (already set to picture space): background, then the layers, the stroke on its layer. */
export function compose(pic, g, {scratch = null} = {}) {
  if (pic.showBackground) { g.fillStyle = pic.background; g.fillRect(0, 0, pic.width, pic.height); }
  for (const l of pic.layers) {
    if (!l.visible) continue;
    g.globalAlpha = l.opacity;
    const s = pic.stroke;
    if (s && s.layer === l && scratch?.g) {
      // The layer as it will be with the stroke on it.
      const sg = scratch.g;
      sg.globalCompositeOperation = 'copy'; sg.globalAlpha = 1; sg.drawImage(l.canvas, 0, 0);
      sg.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'; sg.globalAlpha = s.brush.opacity; sg.drawImage(pic.buffer.canvas, 0, 0);
      sg.globalCompositeOperation = 'source-over'; sg.globalAlpha = 1;
      g.drawImage(scratch.canvas, 0, 0);
    } else g.drawImage(l.canvas, 0, 0);
  }
  g.globalAlpha = 1;
}
/** The whole picture flattened, as a canvas of its size. */
export function flatten(pic) {
  const out = canvasOf(pic.doc, pic.width, pic.height);
  if (out.g) compose({...pic, stroke: null}, out.g);
  return out.canvas;
}
/** The colour at (x, y) as it is seen: '#rrggbb', or '' outside or where nothing is. */
export function colorAt(pic, x, y) {
  if (x < 0 || y < 0 || x >= pic.width || y >= pic.height) return '';
  const one = canvasOf(pic.doc, 1, 1);
  if (!one.g) return '';
  if (pic.showBackground) { one.g.fillStyle = pic.background; one.g.fillRect(0, 0, 1, 1); }
  for (const l of pic.layers) if (l.visible) { one.g.globalAlpha = l.opacity; one.g.drawImage(l.canvas, Math.floor(x), Math.floor(y), 1, 1, 0, 0, 1, 1); }
  const [r, gg, b, a] = one.g.getImageData(0, 0, 1, 1).data;
  if (!a) return '';
  return '#' + [r, gg, b].map(n => n.toString(16).padStart(2, '0')).join('');
}
