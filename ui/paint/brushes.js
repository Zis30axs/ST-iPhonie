// 画画的笔刷. A brush is a tip stamped along the stroke: its size, how far apart the stamps are (spacing, a share of
// the size), how much each stamp leaves (flow) and how dark the whole stroke can get (opacity, as on Procreate), how
// soft the tip's edge is (hardness), how much pressure thins it (pressureSize) and lightens it (pressureOpacity), how
// much the line is steadied (streamline) and scattered (jitter), how much both ends narrow (taper).
// The tip is a round one made from the hardness, a grainy one (pencil, chalk), or a picture (an imported brush: dark
// is paint, or its own transparency).

export const BRUSHES = [
  {id: 'pencil', name: '铅笔', group: '素描', size: 6, opacity: .9, flow: .55, spacing: .08, hardness: .85, pressureSize: .55, pressureOpacity: .8, streamline: .2, jitter: .04, taper: 0, tip: 'grain'},
  {id: 'ink', name: '墨水笔', group: '描线', size: 10, opacity: 1, flow: 1, spacing: .03, hardness: 1, pressureSize: 1, pressureOpacity: 0, streamline: .55, jitter: 0, tip: 'round'},
  {id: 'mono', name: '单线笔', group: '描线', size: 6, opacity: 1, flow: 1, spacing: .03, hardness: 1, pressureSize: 0, pressureOpacity: 0, streamline: .5, jitter: 0, tip: 'round'},
  // 柳叶笔: hard and solid, both ends of every stroke narrowing to a point (with a finger too), for filling and erasing.
  {id: 'willow', name: '柳叶笔', group: '上色', size: 28, opacity: 1, flow: 1, spacing: .03, hardness: .98, pressureSize: .5, pressureOpacity: 0, streamline: .35, jitter: 0, taper: .55, tip: 'round'},
  {id: 'marker', name: '马克笔', group: '上色', size: 24, opacity: .7, flow: .3, spacing: .05, hardness: .8, pressureSize: .15, pressureOpacity: .4, streamline: .25, jitter: 0, tip: 'round'},
  {id: 'round', name: '圆头笔', group: '上色', size: 30, opacity: 1, flow: .9, spacing: .05, hardness: .95, pressureSize: .35, pressureOpacity: .2, streamline: .2, jitter: 0, tip: 'round'},
  {id: 'air', name: '软喷枪', group: '上色', size: 120, opacity: 1, flow: .07, spacing: .06, hardness: 0, pressureSize: .2, pressureOpacity: 1, streamline: .1, jitter: 0, tip: 'round'},
  {id: 'chalk', name: '粉笔', group: '素描', size: 22, opacity: .9, flow: .45, spacing: .12, hardness: .7, pressureSize: .35, pressureOpacity: .6, streamline: .15, jitter: .12, tip: 'grain'},
  {id: 'soft', name: '水彩晕染', group: '上色', size: 60, opacity: .5, flow: .12, spacing: .1, hardness: .2, pressureSize: .4, pressureOpacity: .6, streamline: .3, jitter: .08, tip: 'round'},
];
export const FIELDS = [
  ['size', '最大尺寸', 1, 400, 1], ['opacity', '不透明度', 0, 1, .01], ['flow', '流量', .01, 1, .01], ['spacing', '间距', .01, 1, .01],
  ['hardness', '硬度', 0, 1, .01], ['pressureSize', '压力 → 粗细', 0, 1, .01], ['pressureOpacity', '压力 → 浓淡', 0, 1, .01],
  ['streamline', '防抖', 0, 1, .01], ['jitter', '散布', 0, 1, .01], ['taper', '两头收尖', 0, 1, .01],
];
const KEY = 'st-iphonie-paint-brushes';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
/** A brush with every field in range; tip a known kind or a picture's data URL. */
export function cleanBrush(b) {
  const out = {id: String(b?.id || 'b' + Date.now().toString(36)), name: String(b?.name || '笔刷').slice(0, 30), group: String(b?.group || '导入').slice(0, 20)};
  for (const [k, , min, max] of FIELDS) { const base = BRUSHES[0][k]; const n = Number(b?.[k]); out[k] = clamp(Number.isFinite(n) ? n : base, min, max); }
  out.tip = ['round', 'grain'].includes(b?.tip) || /^data:image\/png;base64,/.test(String(b?.tip || '')) ? b.tip : 'round';
  if (b?.source) out.source = String(b.source).slice(0, 60);
  return out;
}
/** The user's brushes (made or imported), and changes to the built-in ones, in this browser. */
export function userBrushes(win) { try { return (JSON.parse(win.localStorage.getItem(KEY) || '[]') || []).map(cleanBrush); } catch { return []; } }
export function saveUserBrushes(win, list) { try { win.localStorage.setItem(KEY, JSON.stringify(list.map(cleanBrush))); return true; } catch { return false; } }
/** Every brush: the built-in ones (as the user changed them) and theirs after. */
export function allBrushes(win) {
  const mine = userBrushes(win), byId = new Map(mine.map(b => [b.id, b]));
  return [...BRUSHES.map(b => byId.get(b.id) || b), ...mine.filter(b => !BRUSHES.some(x => x.id === b.id))];
}

// ---------- tips ----------
const RES = 128;
const tips = new Map();
/** The tip's shape, white with the paint in its alpha, RES px (drawn scaled). Kept per kind and hardness. */
export function tipMask(doc, brush) {
  const key = brush.tip.startsWith('data:') ? brush.tip : `${brush.tip}|${brush.hardness.toFixed(2)}`;
  if (tips.has(key)) return tips.get(key);
  const c = doc.createElement('canvas'); c.width = c.height = RES;
  const g = c.getContext('2d');
  const entry = {canvas: c, ready: true};
  tips.set(key, entry);
  if (!g) return entry;
  if (brush.tip.startsWith('data:')) {
    entry.ready = false;
    const img = new (doc.defaultView.Image)();
    img.onload = () => { g.clearRect(0, 0, RES, RES); const s = Math.min(RES / img.width, RES / img.height); g.drawImage(img, (RES - img.width * s) / 2, (RES - img.height * s) / 2, img.width * s, img.height * s); entry.ready = true; entry.onready?.(); };
    img.src = brush.tip;
    return entry;
  }
  const r = RES / 2, grad = g.createRadialGradient(r, r, 0, r, r, r);
  const h = Math.min(.98, brush.hardness);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(h, 'rgba(255,255,255,1)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, RES, RES);
  if (brush.tip === 'grain') {
    // Paper grain: holes punched at random, so the stroke breaks up like graphite.
    const data = g.getImageData(0, 0, RES, RES);
    for (let i = 3; i < data.data.length; i += 4) data.data[i] *= Math.random() < .35 ? Math.random() * .4 : .7 + Math.random() * .3;
    g.putImageData(data, 0, 0);
  }
  return entry;
}
/** The tip in a colour, ready to stamp. */
export function coloredTip(doc, brush, color) {
  const mask = tipMask(doc, brush), c = doc.createElement('canvas'); c.width = c.height = RES;
  const g = c.getContext('2d');
  if (!g) return c;
  g.fillStyle = color; g.fillRect(0, 0, RES, RES);
  g.globalCompositeOperation = 'destination-in'; g.drawImage(mask.canvas, 0, 0);
  return c;
}

/**
 * A picture as a tip: its own transparency when it has some, else its darkness (black paints, white is empty), as
 * Photoshop and Procreate tips are. Returns a data URL of the mask (white with alpha), at most RES*2 px.
 */
export function maskFromImage(doc, img) {
  const size = RES * 2, s = Math.min(1, size / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const c = doc.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h), px = data.data;
  let clear = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { clear = true; break; }
  for (let i = 0; i < px.length; i += 4) {
    const lum = (px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114) / 255;
    px[i + 3] = clear ? px[i + 3] : Math.round((1 - lum) * 255);
    px[i] = px[i + 1] = px[i + 2] = 255;
  }
  g.putImageData(data, 0, 0);
  return c.toDataURL('image/png');
}
