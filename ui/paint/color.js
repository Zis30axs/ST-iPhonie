// Colours for 画画: HSV (what the wheel shows) to and from RGB and #hex, and the wheel itself — a hue ring around a
// square of saturation (across) and brightness (up), as on Procreate's 圆盘.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/** {h: 0–360, s: 0–1, v: 0–1} → [r, g, b] 0–255. */
export function hsvToRgb({h, s, v}) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map(x => Math.round(clamp(x) * 255));
}
/** [r, g, b] 0–255 → {h, s, v}. A grey keeps the hue it is given (hue), so the wheel does not jump. */
export function rgbToHsv([r, g, b], hue = 0) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = hue;
  if (d) h = 60 * (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return {h: (h + 360) % 360, s: max ? d / max : 0, v: max};
}
export const rgbToHex = rgb => '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
/** '#abc' or '#aabbcc' (with or without #) → [r, g, b], or null. */
export function hexToRgb(text) {
  let t = String(text || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.replace(/./g, c => c + c);
  if (!/^[0-9a-f]{6}$/i.test(t)) return null;
  return [0, 2, 4].map(i => parseInt(t.slice(i, i + 2), 16));
}

/**
 * The wheel on a canvas `size` px: draw(hsv) paints it; pick(x, y, from) says what a touch at (x, y) means — the ring
 * changes the hue, the square saturation and brightness; `from` ('ring' | 'square') keeps a drag on the part it began.
 */
export function colorWheel(canvasEl, size) {
  const g = canvasEl.getContext('2d'), c = size / 2, outer = c - 2, inner = outer - Math.max(18, size * .11), half = inner * .68;
  function draw({h, s, v}) {
    if (!g) return;
    g.clearRect(0, 0, size, size);
    for (let a = 0; a < 360; a += 1) {
      g.beginPath(); g.strokeStyle = `hsl(${a},100%,50%)`; g.lineWidth = outer - inner;
      g.arc(c, c, (outer + inner) / 2, (a - 90.6) * Math.PI / 180, (a - 89) * Math.PI / 180); g.stroke();
    }
    // The square: white to the hue across, black from below.
    const x0 = c - half, y0 = c - half, w = half * 2;
    const across = g.createLinearGradient(x0, 0, x0 + w, 0);
    across.addColorStop(0, '#fff'); across.addColorStop(1, `hsl(${h},100%,50%)`);
    g.fillStyle = across; g.fillRect(x0, y0, w, w);
    const down = g.createLinearGradient(0, y0, 0, y0 + w);
    down.addColorStop(0, 'rgba(0,0,0,0)'); down.addColorStop(1, '#000');
    g.fillStyle = down; g.fillRect(x0, y0, w, w);
    // Where the colour is, on both.
    const ring = (h - 90) * Math.PI / 180, rr = (outer + inner) / 2;
    knob(c + Math.cos(ring) * rr, c + Math.sin(ring) * rr, (outer - inner) / 2 - 1);
    knob(x0 + s * w, y0 + (1 - v) * w, 8);
  }
  function knob(x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.45)'; g.stroke(); }
  function pick(x, y, from = '') {
    const dx = x - c, dy = y - c, dist = Math.hypot(dx, dy);
    const part = from || (dist >= inner - 4 && dist <= outer + 6 ? 'ring' : Math.abs(dx) <= half + 6 && Math.abs(dy) <= half + 6 ? 'square' : '');
    if (part === 'ring') return {part, h: ((Math.atan2(dy, dx) * 180 / Math.PI) + 90 + 360) % 360};
    if (part === 'square') return {part, s: clamp((dx + half) / (half * 2)), v: clamp(1 - (dy + half) / (half * 2))};
    return null;
  }
  return {draw, pick};
}
