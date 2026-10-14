// 图层 panel, worked as on Procreate:
// - tap a layer to use it; tap the one in use for its options (重命名, 拷贝, 填充, 清除, 阿尔法锁定, 剪辑蒙版, 参考, 向下合并);
// - double-tap a name to rename it;
// - swipe a layer left for 锁定 / 复制 / 删除;
// - tap the letter (N, M…) for its opacity and blend mode;
// - hold a layer, then drag it up or down to move it;
// - the tick shows or hides it. The last row is the background colour.
import {esc} from '../common.js';
import {BLENDS, activeLayer, addLayer, duplicateLayer, removeLayer, moveLayerTo, setLayer, clearLayer, fillLayer, mergeDown} from './engine.js';

const HOLD = 380, DOUBLE = 260, SWIPE = 168;
const letter = blend => BLENDS.find(b => b[0] === blend)?.[2] || 'N';

/** Opens the panel. changed(): the picture changed (redraw, save). color(): the colour in use, for 填充. */
export function layersPanel({ctx, pic, changed, color}) {
  const d = ctx.dialog('图层', '');
  let panel = null, swiped = '', renaming = '';
  const done = () => { changed(); draw(); };

  function row(l) {
    const on = l.id === pic.active, flags = [l.locked && '锁定', l.alphaLock && '阿尔法锁定', l.reference && '参考', l.clip && '剪辑蒙版', l.opacity < 1 && Math.round(l.opacity * 100) + '%'].filter(Boolean).join(' · ');
    const open = panel?.id === l.id ? panel.kind : '';
    return `<div class="pl-row${on ? ' on' : ''}${l.clip ? ' clip' : ''}${swiped === l.id ? ' swiped' : ''}" data-layer="${esc(l.id)}">
      <div class="pl-under"><button type="button" data-pl="lock">${l.locked ? '解锁' : '锁定'}</button><button type="button" data-pl="dup">复制</button><button type="button" class="pl-del" data-pl="del"${pic.layers.length < 2 ? ' disabled' : ''}>删除</button></div>
      <div class="pl-main">
        ${l.clip ? '<span class="pl-clip" aria-label="剪辑蒙版">↳</span>' : ''}
        <canvas class="paint-layer-thumb" width="60" height="60" data-thumb="${esc(l.id)}"></canvas>
        <span class="pl-name">${renaming === l.id ? `<input class="pl-rename" data-pl-name value="${esc(l.name)}" maxlength="40" aria-label="图层名字">` : `<strong>${esc(l.name)}</strong>`}<small>${esc(flags || '　')}</small></span>
        <button type="button" class="pl-mode" data-pl="mode" aria-label="混合模式和不透明度：${esc(BLENDS.find(b => b[0] === l.blend)?.[1] || '正常')}">${letter(l.blend)}</button>
        <input type="checkbox" class="pl-eye" data-pl="eye" ${l.visible ? 'checked' : ''} aria-label="${l.visible ? '隐藏' : '显示'} ${esc(l.name)}">
      </div></div>
      ${open === 'mode' ? `<div class="pl-panel" data-panel="${esc(l.id)}"><div class="field"><div class="meter-label"><span>不透明度</span><output data-pl-out>${Math.round(l.opacity * 100)}%</output></div><input class="slider" type="range" min="0" max="100" value="${Math.round(l.opacity * 100)}" data-pl-opacity></div>
        <div class="pl-blends">${BLENDS.map(([id, name]) => `<button type="button" class="chip-button${l.blend === id ? ' on' : ''}" data-blend="${id}">${name}</button>`).join('')}</div></div>` : ''}
      ${open === 'options' ? `<div class="pl-panel pl-options" data-panel="${esc(l.id)}">
        <button type="button" data-pl="rename">重命名</button><button type="button" data-pl="dup">拷贝</button><button type="button" data-pl="fill">填充图层</button><button type="button" data-pl="clear">清除</button>
        <button type="button" data-pl="alphaLock" aria-pressed="${l.alphaLock}">阿尔法锁定</button><button type="button" data-pl="clip" aria-pressed="${l.clip}"${pic.layers.indexOf(l) === 0 ? ' disabled' : ''}>剪辑蒙版</button>
        <button type="button" data-pl="reference" aria-pressed="${l.reference}">参考</button><button type="button" data-pl="merge"${pic.layers.indexOf(l) === 0 ? ' disabled' : ''}>向下合并</button></div>` : ''}`;
  }
  function draw() {
    if (!d.live) return;
    d.body.innerHTML = `<div class="pl-head"><span class="hint">点选图层，再点一下有更多；左滑锁定、复制、删除；按住拖动换位置</span><button type="button" class="chip-button" data-pl="add" aria-label="新图层">＋</button></div>
      <div class="pl-list" data-pl-list>${[...pic.layers].reverse().map(row).join('')}
      <div class="pl-row pl-bg"><div class="pl-main"><input type="color" value="${esc(pic.background)}" data-bg-color aria-label="背景颜色"><span class="pl-name"><strong>背景颜色</strong><small>${pic.showBackground ? esc(pic.background) : '透明'}</small></span><input type="checkbox" class="pl-eye" data-bg-eye ${pic.showBackground ? 'checked' : ''} aria-label="背景"></div></div></div>`;
    for (const c of d.body.querySelectorAll('[data-thumb]')) {
      const l = pic.layers.find(x => x.id === c.dataset.thumb), g = c.getContext('2d'), s = Math.min(60 / pic.width, 60 / pic.height);
      g?.drawImage(l.canvas, (60 - pic.width * s) / 2, (60 - pic.height * s) / 2, pic.width * s, pic.height * s);
    }
    const input = d.body.querySelector('[data-pl-name]');
    if (input) { input.focus(); input.select(); }
  }
  // A button's layer: its row, or the panel open under that row.
  const layerOf = el => { const id = el.closest('[data-layer]')?.dataset.layer || el.closest('[data-panel]')?.dataset.panel; return pic.layers.find(l => l.id === id); };
  function act(what, l) {
    if (what === 'lock') { setLayer(pic, l.id, {locked: !l.locked}); swiped = ''; return done(); }
    if (what === 'dup') { duplicateLayer(pic, l.id); swiped = ''; panel = null; return done(); }
    if (what === 'del') { removeLayer(pic, l.id); swiped = ''; panel = null; return done(); }
    if (what === 'rename') { renaming = l.id; panel = null; return draw(); }
    if (what === 'fill') { if (!fillLayer(pic, l.id, color())) ctx.notify('这个图层锁定了'); return done(); }
    if (what === 'clear') { if (!clearLayer(pic, l.id)) ctx.notify('这个图层锁定了'); return done(); }
    if (['alphaLock', 'clip', 'reference'].includes(what)) { setLayer(pic, l.id, {[what]: !l[what]}); return done(); }
    if (what === 'merge') { if (!mergeDown(pic, l.id)) ctx.notify('下面的图层锁定了'); panel = null; return done(); }
  }

  // ---------- touching a row: tap, double tap, swipe, hold and drag ----------
  let press = null, lastTap = null, tapTimer = 0;
  d.body.addEventListener('pointerdown', e => {
    const main = e.target.closest('.pl-main');
    if (!main || e.target.closest('input, button') || main.closest('.pl-bg')) return;
    const rowEl = main.closest('[data-layer]');
    press = {id: e.pointerId, x: e.clientX, y: e.clientY, row: rowEl, main, dx: 0, mode: '', start: swiped === rowEl.dataset.layer ? -SWIPE : 0};
    press.timer = ctx.win.setTimeout(() => { if (press && !press.mode) { press.mode = 'drag'; rowEl.classList.add('dragging'); } }, HOLD);
  });
  d.body.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.mode && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { press.mode = 'swipe'; ctx.win.clearTimeout(press.timer); try { press.main.setPointerCapture(e.pointerId); } catch { /* fine */ } }
    if (!press.mode && Math.abs(dy) > 10) { ctx.win.clearTimeout(press.timer); press = null; return; }
    if (press.mode === 'swipe') { press.dx = Math.max(-SWIPE, Math.min(0, press.start + dx)); press.main.style.transform = `translateX(${press.dx}px)`; }
    if (press.mode === 'drag') { e.preventDefault(); press.row.style.transform = `translateY(${dy}px)`; press.dy = dy; }
  });
  const release = e => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    press = null;
    ctx.win.clearTimeout(p.timer);
    const l = pic.layers.find(x => x.id === p.row.dataset.layer);
    if (p.mode === 'swipe') { swiped = p.dx < -SWIPE / 2 ? l.id : ''; return draw(); }
    if (p.mode === 'drag') {
      // Where it was let go: the row it is over, in the list as shown (top layer first).
      const rows = [...d.body.querySelectorAll('[data-layer]')], height = p.row.getBoundingClientRect().height || 56;
      const shownAt = rows.indexOf(p.row), to = Math.max(0, Math.min(rows.length - 1, shownAt + Math.round((p.dy || 0) / height)));
      moveLayerTo(pic, l.id, pic.layers.length - 1 - to);
      return done();
    }
    if (e.type === 'pointercancel') return;
    // A tap: a layer not in use is chosen; the one in use opens its options, unless a second tap renames it.
    if (swiped) { swiped = ''; return draw(); }
    const now = Date.now(), twice = lastTap && lastTap.id === l.id && now - lastTap.at < DOUBLE;
    lastTap = {id: l.id, at: now};
    ctx.win.clearTimeout(tapTimer);
    if (twice) { renaming = l.id; panel = null; return draw(); }
    if (l.id !== pic.active) { pic.active = l.id; pic.changed++; panel = null; changed(); return draw(); }
    tapTimer = ctx.win.setTimeout(() => { panel = panel?.id === l.id && panel.kind === 'options' ? null : {id: l.id, kind: 'options'}; draw(); }, DOUBLE);
  };
  d.body.addEventListener('pointerup', release);
  d.body.addEventListener('pointercancel', release);

  d.body.addEventListener('click', e => {
    const b = e.target.closest('[data-pl], [data-blend], [data-bg-eye]');
    if (!b) return;
    if (b.dataset.pl === 'add') { addLayer(pic); panel = null; return done(); }
    if (b.matches('[data-bg-eye]')) { pic.showBackground = b.checked; pic.changed++; return done(); }
    const l = layerOf(b);
    if (!l) return;
    if (b.dataset.blend) { setLayer(pic, l.id, {blend: b.dataset.blend}); return done(); }
    if (b.dataset.pl === 'eye') { setLayer(pic, l.id, {visible: b.checked}); return done(); }
    if (b.dataset.pl === 'mode') { panel = panel?.id === l.id && panel.kind === 'mode' ? null : {id: l.id, kind: 'mode'}; return draw(); }
    act(b.dataset.pl, l);
  });
  // Opacity follows the slider at once; the change is kept (undoable) when it is let go.
  let sliding = null;
  d.body.addEventListener('input', e => {
    if (e.target.matches('[data-pl-opacity]')) {
      const l = pic.layers.find(x => x.id === e.target.closest('[data-panel]').dataset.panel);
      sliding ||= {id: l.id, from: l.opacity};
      l.opacity = Number(e.target.value) / 100;
      d.body.querySelector('[data-pl-out]').textContent = e.target.value + '%';
      changed({quiet: true});
    }
    if (e.target.matches('[data-bg-color]')) { pic.background = e.target.value; pic.showBackground = true; pic.changed++; changed({quiet: true}); }
  });
  d.body.addEventListener('change', e => {
    if (e.target.matches('[data-pl-opacity]') && sliding) {
      const l = pic.layers.find(x => x.id === sliding.id), now = l.opacity;
      l.opacity = sliding.from; sliding = null;
      setLayer(pic, l.id, {opacity: now});
      return done();
    }
    if (e.target.matches('[data-bg-color]')) done();
  });
  const rename = input => { const l = pic.layers.find(x => x.id === renaming); renaming = ''; if (l && input.value.trim()) setLayer(pic, l.id, {name: input.value.trim()}); done(); };
  d.body.addEventListener('keydown', e => { if (e.target.matches('[data-pl-name]') && e.key === 'Enter') { e.preventDefault(); rename(e.target); } });
  d.body.addEventListener('focusout', e => { if (e.target.matches('[data-pl-name]') && renaming) rename(e.target); });
  d.onClose(() => ctx.win.clearTimeout(tapTimer));
  draw();
  return d;
}
