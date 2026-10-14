// 画画的画布: a picture of layers, strokes stamped with a brush tip, undo and redo.
// A stroke is stamped into a buffer as big as the picture (each stamp leaves `flow`); when it ends, the buffer goes
// onto the layer at the brush's opacity (or, erasing, takes that much away). So one stroke never gets darker than its
// opacity however often it crosses itself, as on Procreate. Undo keeps the pixels a change touched, before and after.
// Layers, as on Procreate: a blend mode (正片叠底…), 剪辑蒙版 (shown only where the layer below it has paint),
// 阿尔法锁定 (paint only where there is paint already), 锁定 (no changes), 参考 (what 油漆桶 looks at).
import {coloredTip} from './brushes.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
let ids = 0;
const newId = () => 'L' + Date.now().toString(36) + (ids++).toString(36);
function canvasOf(doc, w, h) { const c = doc.createElement('canvas'); c.width = w; c.height = h; return {canvas: c, g: c.getContext('2d')}; }

/** Blend modes: [canvas operation, name, the letter the layer list shows]. */
export const BLENDS = [
  ['source-over', '正常', 'N'], ['multiply', '正片叠底', 'M'], ['screen', '滤色', 'S'], ['overlay', '叠加', 'O'],
  ['darken', '变暗', 'Da'], ['lighten', '变亮', 'Li'], ['color-dodge', '颜色减淡', 'CD'], ['color-burn', '颜色加深', 'CB'],
  ['lighter', '添加', 'A'], ['hard-light', '强光', 'HL'], ['soft-light', '柔光', 'SL'], ['difference', '差值', 'Di'],
  ['exclusion', '排除', 'E'], ['hue', '色相', 'H'], ['saturation', '饱和度', 'Sa'], ['color', '颜色', 'C'], ['luminosity', '明度', 'L'],
];
const BLEND_IDS = BLENDS.map(b => b[0]);
const PROPS = ['name', 'opacity', 'visible', 'blend', 'clip', 'alphaLock', 'locked', 'reference'];

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

/** A layer's settings, checked (from a saved work or a change). */
function layerProps(l, i = 0) {
  return {name: String(l.name || `图层 ${i + 1}`).slice(0, 40), opacity: Number.isFinite(l.opacity) ? clamp(l.opacity, 0, 1) : 1, visible: l.visible !== false,
    blend: BLEND_IDS.includes(l.blend) ? l.blend : 'source-over', clip: l.clip === true, alphaLock: l.alphaLock === true, locked: l.locked === true, reference: l.reference === true};
}
/**
 * A picture: {width, height, background, showBackground, layers: [{id, canvas, g, name, opacity, visible, blend, clip,
 * alphaLock, locked, reference}] (bottom first), active (a layer id)}. From saved layers (with an image) when given.
 */
export function createPicture(doc, {width, height, background = '#ffffff', showBackground = true, layers = null, active = ''}) {
  const pic = {doc, width, height, background, showBackground, layers: [], active: '', history: [], future: [], stroke: null, changed: 0, temps: []};
  pic.buffer = canvasOf(doc, width, height);
  for (const [i, l] of (layers || [{name: '图层 1'}]).entries()) {
    const {canvas, g} = canvasOf(doc, width, height);
    if (l.image && g) g.drawImage(l.image, 0, 0);
    pic.layers.push({id: l.id || newId(), canvas, g, ...layerProps(l, i)});
  }
  pic.active = pic.layers.some(l => l.id === active) ? active : pic.layers.at(-1).id;
  return pic;
}
export const activeLayer = pic => pic.layers.find(l => l.id === pic.active) || pic.layers.at(-1);
/** The settings of a layer, to keep. */
export const layerInfo = l => Object.fromEntries(['id', ...PROPS].map(k => [k, l[k]]));
const MAX_PIXELS = 30e6;
function remember(pic, step) {
  pic.history.push(step); pic.future = []; pic.changed++;
  // Not more than so many pixels kept for undo (a few strokes over the whole picture take a lot).
  let total = pic.history.reduce((n, s) => n + (s.pixels || 0), 0);
  while (pic.history.length > 1 && (pic.history.length > 60 || total > MAX_PIXELS)) total -= pic.history.shift().pixels || 0;
}
/** A canvas the size of the picture to work in (n: which one), made once. */
function temp(pic, n) { return pic.temps[n] ||= canvasOf(pic.doc, pic.width, pic.height); }
const pixelsOf = (pic, layer, box = [0, 0, pic.width, pic.height]) => layer.g.getImageData(...box);
function pixelStep(pic, layer, box, before) { return {kind: 'pixels', layer: layer.id, x: box[0], y: box[1], before, after: layer.g.getImageData(...box), pixels: box[2] * box[3] * 2}; }

// ---------- strokes ----------
/** Starts a stroke: brush, size (px), color ('#rrggbb'), erase. The first point stamps at once. False on a locked layer. */
export function beginStroke(pic, {brush, size, color, erase = false}, point) {
  const layer = activeLayer(pic);
  if (layer.locked) return false;
  pic.buffer.g?.clearRect(0, 0, pic.width, pic.height);
  pic.stroke = {brush, size, erase, layer, tip: coloredTip(pic.doc, brush, erase ? '#000000' : color), last: point, carry: 0, box: null};
  stamp(pic, point);
  return true;
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
// How a stroke goes onto its layer: taking away, painting only over paint (阿尔法锁定), or painting.
const strokeMode = s => s.erase ? 'destination-out' : s.layer.alphaLock ? 'source-atop' : 'source-over';
/** The stroke goes onto its layer (undoable). cancel: it is dropped instead. */
export function endStroke(pic, {cancel = false} = {}) {
  const s = pic.stroke;
  pic.stroke = null;
  if (!s || cancel || !s.box) { pic.buffer.g?.clearRect(0, 0, pic.width, pic.height); return false; }
  const box = boxIn(pic, s.box), g = s.layer.g;
  if (!box[2] || !box[3] || !g) return false;
  const before = pixelsOf(pic, s.layer, box);
  g.save(); g.globalAlpha = s.brush.opacity; g.globalCompositeOperation = strokeMode(s);
  g.drawImage(pic.buffer.canvas, box[0], box[1], box[2], box[3], box[0], box[1], box[2], box[3]); g.restore();
  remember(pic, pixelStep(pic, s.layer, box, before));
  pic.buffer.g.clearRect(box[0], box[1], box[2], box[3]);
  return true;
}

// ---------- undo ----------
function restore(pic, step, which) {
  if (step.kind === 'group') { for (const s of which === 'before' ? [...step.steps].reverse() : step.steps) restore(pic, s, which); return; }
  if (step.kind === 'pixels') { pic.layers.find(l => l.id === step.layer)?.g?.putImageData(step[which], step.x, step.y); return; }
  if (step.kind === 'props') { const l = pic.layers.find(x => x.id === step.layer); if (l) Object.assign(l, step[which]); return; }
  if (step.kind === 'layer') {
    // A layer added (there 'after') or taken away (there 'before').
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
function insertLayer(pic, at, props = {}) {
  const {canvas, g} = canvasOf(pic.doc, pic.width, pic.height);
  const layer = {id: newId(), canvas, g, ...layerProps({name: `图层 ${pic.layers.length + 1}`, ...props})};
  pic.layers.splice(at, 0, layer); pic.active = layer.id;
  return layer;
}
/** A new empty layer above the one in use. */
export function addLayer(pic) {
  const at = pic.layers.findIndex(l => l.id === pic.active) + 1, layer = insertLayer(pic, at);
  remember(pic, {kind: 'layer', layer, index: at, added: true});
  return layer;
}
/** A copy of a layer, above it. */
export function duplicateLayer(pic, id) {
  const from = pic.layers.find(l => l.id === id);
  if (!from) return null;
  const at = pic.layers.indexOf(from) + 1, layer = insertLayer(pic, at, {...layerInfo(from), name: `${from.name} 拷贝`, locked: false});
  layer.g?.drawImage(from.canvas, 0, 0);
  remember(pic, {kind: 'layer', layer, index: at, added: true, pixels: pic.width * pic.height});
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
export function moveLayer(pic, id, by) { const at = pic.layers.findIndex(l => l.id === id); return moveLayerTo(pic, id, at + by); }
/** Moves a layer to place `to` (0 = bottom). */
export function moveLayerTo(pic, id, to) {
  const at = pic.layers.findIndex(l => l.id === id);
  if (at < 0 || to < 0 || to >= pic.layers.length || to === at) return false;
  const before = pic.layers.map(l => l.id), [layer] = pic.layers.splice(at, 1);
  pic.layers.splice(to, 0, layer);
  remember(pic, {kind: 'order', before, after: pic.layers.map(l => l.id)});
  return true;
}
/** Changes a layer's settings (name, opacity, blend, clip, alphaLock, locked, reference, visible), undoable. */
export function setLayer(pic, id, patch) {
  const l = pic.layers.find(x => x.id === id);
  if (!l) return false;
  const next = layerProps({...layerInfo(l), ...patch}), keys = PROPS.filter(k => k in patch && next[k] !== l[k]);
  if (!keys.length) return false;
  const before = Object.fromEntries(keys.map(k => [k, l[k]])), after = Object.fromEntries(keys.map(k => [k, next[k]]));
  Object.assign(l, after);
  remember(pic, {kind: 'props', layer: id, before, after});
  return true;
}
/** Empties a layer (undoable). */
export function clearLayer(pic, id) {
  const layer = pic.layers.find(l => l.id === id);
  if (!layer?.g || layer.locked) return false;
  const before = pixelsOf(pic, layer);
  layer.g.clearRect(0, 0, pic.width, pic.height);
  remember(pic, pixelStep(pic, layer, [0, 0, pic.width, pic.height], before));
  return true;
}
/** Fills a layer with a colour (with 阿尔法锁定, only what is painted takes it), undoable. */
export function fillLayer(pic, id, color) {
  const layer = pic.layers.find(l => l.id === id);
  if (!layer?.g || layer.locked) return false;
  const before = pixelsOf(pic, layer), g = layer.g;
  g.save(); g.globalCompositeOperation = layer.alphaLock ? 'source-atop' : 'source-over'; g.fillStyle = color; g.fillRect(0, 0, pic.width, pic.height); g.restore();
  remember(pic, pixelStep(pic, layer, [0, 0, pic.width, pic.height], before));
  return true;
}
/** Puts a layer onto the one under it (as it is seen: its blend, opacity and 剪辑蒙版), and takes it away. */
export function mergeDown(pic, id) {
  const at = pic.layers.findIndex(l => l.id === id), top = pic.layers[at], below = pic.layers[at - 1];
  if (!top || !below?.g || below.locked) return false;
  const before = pixelsOf(pic, below), g = below.g;
  g.save(); g.globalAlpha = top.opacity; g.globalCompositeOperation = top.blend;
  g.drawImage(top.clip ? clipped(pic, top.canvas, below.canvas, 1) : top.canvas, 0, 0); g.restore();
  const paint = pixelStep(pic, below, [0, 0, pic.width, pic.height], before);
  pic.layers.splice(at, 1); pic.active = below.id;
  remember(pic, {kind: 'group', steps: [paint, {kind: 'layer', layer: top, index: at, added: false}], pixels: paint.pixels + pic.width * pic.height});
  return true;
}

// ---------- seeing it ----------
/** What a layer shows now: itself, or itself with the stroke being drawn on it. */
function content(pic, l, n) {
  const s = pic.stroke;
  if (!s || s.layer !== l) return l.canvas;
  const t = temp(pic, n);
  if (!t.g) return l.canvas;
  t.g.globalCompositeOperation = 'copy'; t.g.globalAlpha = 1; t.g.drawImage(l.canvas, 0, 0);
  t.g.globalCompositeOperation = strokeMode(s); t.g.globalAlpha = s.brush.opacity; t.g.drawImage(pic.buffer.canvas, 0, 0);
  t.g.globalCompositeOperation = 'source-over'; t.g.globalAlpha = 1;
  return t.canvas;
}
/** `source` kept only where `base` has paint, in work canvas n. */
function clipped(pic, source, base, n) {
  const t = temp(pic, n);
  if (!t.g) return source;
  t.g.globalCompositeOperation = 'copy'; t.g.globalAlpha = 1; t.g.drawImage(source, 0, 0);
  t.g.globalCompositeOperation = 'destination-in'; t.g.drawImage(base, 0, 0);
  t.g.globalCompositeOperation = 'source-over';
  return t.canvas;
}
/**
 * Draws the picture into g (already set to picture space): the background, then each layer with its blend mode and
 * opacity; a 剪辑蒙版 layer shows only over the paint of the layer it sits on (they make one group).
 */
export function compose(pic, g) {
  if (pic.showBackground) { g.fillStyle = pic.background; g.fillRect(0, 0, pic.width, pic.height); }
  const list = pic.layers;
  for (let i = 0; i < list.length; i++) {
    const base = list[i];
    const group = [];
    for (let j = i + 1; j < list.length && list[j].clip; j++) group.push(list[j]);
    i += group.length;
    if (!base.visible) continue;
    const shown = group.filter(l => l.visible);
    let picture = content(pic, base, 0);
    if (shown.length) {
      // The group: the base, then each clipped layer (only where the base has paint) with its blend and opacity.
      const groupCanvas = temp(pic, 1), gg = groupCanvas.g, baseNow = picture;
      if (gg) {
        gg.globalCompositeOperation = 'copy'; gg.globalAlpha = 1; gg.drawImage(baseNow, 0, 0);
        for (const l of shown) {
          const piece = clipped(pic, content(pic, l, 2), baseNow, 3);
          gg.globalCompositeOperation = l.blend; gg.globalAlpha = l.opacity; gg.drawImage(piece, 0, 0);
        }
        gg.globalCompositeOperation = 'source-over'; gg.globalAlpha = 1;
        picture = groupCanvas.canvas;
      }
    }
    g.globalAlpha = base.opacity; g.globalCompositeOperation = base.blend;
    g.drawImage(picture, 0, 0);
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
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
  // The picture drawn into one pixel, moved so that pixel is (x, y).
  const one = canvasOf(pic.doc, 1, 1), g = one.g;
  if (!g) return '';
  g.translate(-Math.floor(x), -Math.floor(y));
  compose({...pic, stroke: null}, g);
  const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
  if (!a) return '';
  return '#' + [r, gg, b].map(n => n.toString(16).padStart(2, '0')).join('');
}
