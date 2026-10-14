// 画画: drawing with a finger on a phone and a pen on a tablet or drawing pad, on the model of Procreate's phone app.
// 作品 (the works, kept in this browser) open into the canvas: tools at the top (画笔, 橡皮, 吸管, 图层, 颜色), size and
// opacity on the side with undo and redo, the picture in the middle (ui/paint/stage.js does the touching).
// Works are kept as they change (ui/paint/store.js); 存到相册 puts a flat copy in the album.
import {createView, esc, btn, help, menu, empty} from './common.js';
import {saveFile} from '../download.js';
import {allBrushes, userBrushes, saveUserBrushes, cleanBrush, BRUSHES, FIELDS, tipMask, coloredTip, maskFromImage} from './paint/brushes.js';
import {createPicture, activeLayer, undo, redo, addLayer, removeLayer, moveLayer, clearLayer, flatten, stampOf} from './paint/engine.js';
import {createStage} from './paint/stage.js';
import {paintStore} from './paint/store.js';
import {hsvToRgb, rgbToHsv, rgbToHex, hexToRgb, colorWheel} from './paint/color.js';

const SIZES = [['portrait', '竖向', 1200, 1600], ['square', '方形', 1500, 1500], ['landscape', '横向', 1600, 1200], ['phone', '手机壁纸', 1080, 1920]];
const TOOLS_KEY = 'st-iphonie-paint-tools';
const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  brush: svg('<path d="M14.5 3.5l6 6-9 9c-1.2 1.2-3.3 1.4-5 .6L3 21l1.9-3.5c-.8-1.7-.6-3.8.6-5z" fill="currentColor"/>'),
  eraser: svg('<path d="M3.5 15.5 13 6l5 5-9.5 9.5H6z" fill="currentColor"/><path d="M11 21h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  pick: svg('<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L17 9l1 1-1.5 1.5-1-1L8 18H5v-3l7.5-7.5-1-1L13 5l1 1z" fill="currentColor"/>'),
  layers: svg('<path d="M12 3 2 8l10 5 10-5z" fill="currentColor"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  undo: svg('<path d="M9 7H4V2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 7A8 8 0 1 1 6 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  redo: svg('<path d="M15 7h5V2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.5 7A8 8 0 1 0 18 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  more: svg('<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  eyeOff: svg('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
};
const stamp = at => new Date(at).toLocaleString('zh-CN', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
// The size slider runs on a curve: fine control for thin brushes, still up to 400 px.
const toSlider = px => Math.round(Math.sqrt((px - 1) / 399) * 1000);
const fromSlider = v => Math.max(1, Math.round(1 + 399 * (v / 1000) ** 2));

export function paintApp(ctx) {
  const v = createView(ctx, 'paint'), store = paintStore(ctx.win), keys = new ctx.win.AbortController();
  let mode = 'gallery', pic = null, work = null, stage = null, saving = null, saveTimer = 0, savedAt = 0;
  // The tools: which brush each of 画画 and 橡皮 uses, at what size and opacity; the colour and the ones used before.
  const tools = (() => { try { return JSON.parse(ctx.win.localStorage.getItem(TOOLS_KEY) || 'null') || {}; } catch { return {}; } })();
  tools.kind ||= 'brush'; tools.color ||= '#2b2b3a'; tools.recent ||= [];
  tools.brush ||= {id: 'ink', size: 10, opacity: 1}; tools.eraser ||= {id: 'round', size: 40, opacity: 1};
  let hsv = rgbToHsv(hexToRgb(tools.color) || [0, 0, 0]);
  const keepTools = () => { try { ctx.win.localStorage.setItem(TOOLS_KEY, JSON.stringify(tools)); } catch { /* this visit only */ } };
  const brushOf = id => allBrushes(ctx.win).find(b => b.id === id) || BRUSHES[1];
  const current = () => tools.kind === 'eraser' ? tools.eraser : tools.brush;

  // ---------- 作品 ----------
  async function renderGallery() {
    mode = 'gallery'; v.root.dataset.mode = 'gallery';
    let works = [];
    try { works = await store.list(); } catch (error) { ctx.notify(error.message, {error: true}); }
    if (mode !== 'gallery' || v.disposed) return;
    v.draw(`<header class="page-heading"><div><span class="eyebrow">Paint</span><h1><span>画画</span></h1></div><div class="heading-actions">${btn('paint-new', '＋ 新画布', 'chip-button')}</div></header>`
      + (works.length ? `<div class="paint-works">${works.map(w => `<div class="paint-work"><button type="button" class="paint-thumb" data-work="${esc(w.id)}" aria-label="打开 ${esc(w.name)}"><img data-thumb="${esc(w.id)}" alt=""></button><span class="paint-work-name"><strong>${esc(w.name)}</strong><small>${w.width}×${w.height} · ${esc(stamp(w.updatedAt))}</small></span>${btn('work-more', I.more, 'icon-button', `data-id="${esc(w.id)}" aria-label="${esc(w.name)} 的选项"`)}</div>`).join('')}</div>`
        : empty('还没有作品', '点右上角「新画布」开始画。手机上用手指画，电脑上可以接数位板，笔的压力会让线条有粗细。', 'draw'))
      + '<p class="hint">作品存在这个浏览器里。两指捏合缩放、旋转，两指点一下撤销、三指点一下重做；按住不动取色。</p>');
    for (const img of v.root.querySelectorAll('[data-thumb]')) { const w = works.find(x => x.id === img.dataset.thumb); if (w?.thumb) img.src = ctx.win.URL.createObjectURL(w.thumb); }
  }
  function newSheet() {
    const d = ctx.dialog('新画布', `<div class="pick-list">${SIZES.map(([k, l, wd, ht]) => `<button type="button" class="list-row" data-size="${k}"><span class="paint-size-shape" style="aspect-ratio:${wd}/${ht}"></span><span><strong>${l}</strong><small>${wd} × ${ht}</small></span></button>`).join('')}</div>`);
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-size]');
      if (!b) return;
      const [, , width, height] = SIZES.find(s => s[0] === b.dataset.size);
      d.close();
      work = {id: 'w' + Date.now().toString(36), name: '作品 ' + stamp(Date.now()), createdAt: Date.now()};
      openEditor(createPicture(ctx.doc, {width, height}));
      savedAt = -1;
      save();
    });
  }
  async function openWork(id) {
    const w = await store.get(id);
    if (!w) { ctx.notify('这幅作品已经不在了'); return renderGallery(); }
    const layers = await Promise.all((w.layers || []).map(async l => ({...l, image: l.blob ? await ctx.win.createImageBitmap(l.blob).catch(() => null) : null})));
    work = {id: w.id, name: w.name, createdAt: w.createdAt || w.updatedAt};
    openEditor(createPicture(ctx.doc, {width: w.width, height: w.height, background: w.background, showBackground: w.showBackground !== false, layers: layers.length ? layers : null, active: w.active}));
    savedAt = pic.changed;
  }
  async function workMenu(id) {
    const works = await store.list(), w = works.find(x => x.id === id);
    if (!w) return;
    const pickd = await menu(ctx, w.name, [{key: 'rename', icon: 'edit', label: '重命名'}, {key: 'album', icon: 'image', label: '存到相册'}, {key: 'delete', icon: 'trash', label: '删除', danger: true}]);
    if (pickd === 'rename') {
      const d = ctx.dialog('作品名字', `<div class="field"><input data-field="work-name" maxlength="40" value="${esc(w.name)}"></div><div class="actions">${btn('work-name-save', '保存', 'primary')}</div>`);
      d.body.addEventListener('click', async e => { if (!e.target.closest('[data-action=work-name-save]')) return; const name = d.body.querySelector('[data-field=work-name]').value.trim() || w.name; d.close(); await store.rename(id, name); renderGallery(); });
    }
    if (pickd === 'album') { const full = await store.get(id); const layers = await Promise.all(full.layers.map(async l => ({...l, image: l.blob ? await ctx.win.createImageBitmap(l.blob) : null}))); await toAlbum(createPicture(ctx.doc, {...full, layers}), full.name); }
    if (pickd === 'delete' && await ctx.confirm('删除这幅作品？', '删掉就找不回来了（存到相册的那份还在）。')) { await store.remove(id); renderGallery(); }
  }

  // ---------- 保存 ----------
  const blobOf = canvas => new Promise(resolve => canvas.toBlob ? canvas.toBlob(b => resolve(b), 'image/png') : resolve(null));
  /** Keeps the work as it is (layers and a small picture for the list); once at a time, only when it changed. */
  function save() {
    if (!pic || !work || savedAt === pic.changed) return saving || Promise.resolve();
    const p = pic, at = p.changed, w = work;
    saving = (saving || Promise.resolve()).then(async () => {
      const layers = await Promise.all(p.layers.map(async l => ({id: l.id, name: l.name, opacity: l.opacity, visible: l.visible, blob: await blobOf(l.canvas)})));
      const flat = flatten(p), s = Math.min(1, 360 / Math.max(p.width, p.height)), t = ctx.doc.createElement('canvas');
      t.width = Math.round(p.width * s); t.height = Math.round(p.height * s);
      t.getContext('2d')?.drawImage(flat, 0, 0, t.width, t.height);
      await store.put({id: w.id, name: w.name, width: p.width, height: p.height, background: p.background, showBackground: p.showBackground, active: p.active, createdAt: w.createdAt, updatedAt: Date.now(), thumb: await blobOf(t), layers});
      if (pic === p) savedAt = at;
    }).catch(error => ctx.notify('作品没存上：' + error.message, {error: true})).finally(() => { saving = null; });
    return saving;
  }
  const saveSoon = () => { ctx.win.clearTimeout(saveTimer); saveTimer = ctx.win.setTimeout(save, 1500); };
  async function toAlbum(p, name) {
    const blob = await blobOf(flatten(p));
    if (!blob) throw Error('这个浏览器做不出图片');
    await ctx.api.addPhoto({name: `${name}.png`, blob});
    ctx.notify('已存到相册');
  }

  // ---------- 画布 ----------
  function openEditor(p) {
    closeEditor();
    pic = p; mode = 'edit'; v.root.dataset.mode = 'edit';
    v.draw(`<div class="paint-edit">
      <div class="paint-top">
        ${btn('paint-gallery', '作品', 'paint-text')}${btn('paint-actions', I.more, 'paint-tool', 'aria-label="更多"')}
        <span class="grow"></span>
        ${btn('tool-brush', I.brush, 'paint-tool', 'aria-label="画笔（再点一下选笔刷）"')}${btn('tool-eraser', I.eraser, 'paint-tool', 'aria-label="橡皮（再点一下选笔刷）"')}${btn('tool-pick', I.pick, 'paint-tool', 'aria-label="吸管"')}${btn('paint-layers', I.layers, 'paint-tool', 'aria-label="图层"')}
        <button type="button" class="paint-swatch" data-action="paint-color" aria-label="颜色"></button>
      </div>
      <div class="paint-stage" data-paint-stage>
        <div class="paint-side">
          <input type="range" class="paint-slider" data-paint="size" min="0" max="1000" aria-label="大小">
          <span class="paint-side-value" data-paint-size-value></span>
          <input type="range" class="paint-slider" data-paint="opacity" min="1" max="100" aria-label="不透明度">
          ${btn('paint-undo', I.undo, 'paint-side-btn', 'aria-label="撤销"')}${btn('paint-redo', I.redo, 'paint-side-btn', 'aria-label="重做"')}
        </div>
      </div>
    </div>`);
    stage = createStage({doc: ctx.doc, win: ctx.win, host: v.root.querySelector('[data-paint-stage]'), pic,
      tool: () => ({kind: tools.kind, brush: brushOf(current().id), size: current().size, opacity: current().opacity, color: tools.color}),
      picked: color => setColor(color, {keep: false}),
      stroked: () => { saveSoon(); syncSide(); },
      undo: () => doUndo(), redo: () => doRedo()});
    tipMask(ctx.doc, brushOf(tools.brush.id)).onready = () => stage?.render();
    syncTools();
  }
  function closeEditor() { if (stage) { stage.dispose(); stage = null; } }
  function syncTools() {
    for (const k of ['brush', 'eraser', 'pick']) v.root.querySelector(`[data-action=tool-${k}]`)?.setAttribute('aria-pressed', String(tools.kind === k));
    const sw = v.root.querySelector('.paint-swatch');
    if (sw) sw.style.background = tools.color;
    syncSide();
  }
  function syncSide() {
    const t = current(), size = v.root.querySelector('[data-paint=size]'), op = v.root.querySelector('[data-paint=opacity]');
    if (size) { size.value = toSlider(t.size); size.disabled = tools.kind === 'pick'; }
    if (op) { op.value = Math.round(t.opacity * 100); op.disabled = tools.kind === 'pick'; }
    const val = v.root.querySelector('[data-paint-size-value]');
    if (val) val.textContent = tools.kind === 'pick' ? '' : String(t.size);
    for (const [a, can] of [['paint-undo', pic?.history.length], ['paint-redo', pic?.future.length]]) { const b = v.root.querySelector(`[data-action=${a}]`); if (b) b.disabled = !can; }
  }
  function setColor(color, {keep = true} = {}) {
    tools.color = color; hsv = rgbToHsv(hexToRgb(color), hsv.h);
    if (keep) { tools.recent = [color, ...tools.recent.filter(c => c !== color)].slice(0, 12); }
    keepTools(); syncTools();
  }
  function doUndo() { if (pic && !stage?.busy && undo(pic)) { stage.render(); syncSide(); saveSoon(); } }
  function doRedo() { if (pic && !stage?.busy && redo(pic)) { stage.render(); syncSide(); saveSoon(); } }
  async function leaveEditor() { closeEditor(); await save(); pic = null; work = null; renderGallery(); }

  // ---------- 颜色 ----------
  function colorSheet() {
    const was = tools.color;
    const d = ctx.dialog('颜色', `<div class="paint-color">
      <canvas class="paint-wheel" width="240" height="240" data-wheel></canvas>
      <div class="paint-color-row"><span class="paint-chip" data-was style="background:${esc(was)}" title="原来的"></span><span class="paint-chip" data-now title="现在的"></span><input class="paint-hex" data-field="hex" maxlength="7" spellcheck="false" aria-label="颜色代码"></div>
      <div class="paint-recent" data-recent></div></div>`);
    const c = d.body.querySelector('[data-wheel]'), ratio = Math.min(2, ctx.win.devicePixelRatio || 1);
    c.width = c.height = 240 * ratio; c.style.width = c.style.height = '240px';
    c.getContext('2d')?.scale(ratio, ratio);
    const wheel = colorWheel(c, 240);
    const paint = () => {
      const hex = rgbToHex(hsvToRgb(hsv));
      wheel.draw(hsv);
      d.body.querySelector('[data-now]').style.background = hex;
      const box = d.body.querySelector('[data-field=hex]'); if (ctx.doc.activeElement !== box) box.value = hex;
      d.body.querySelector('[data-recent]').innerHTML = tools.recent.map(x => `<button type="button" class="paint-chip" data-recent-color="${esc(x)}" style="background:${esc(x)}" aria-label="${esc(x)}"></button>`).join('');
    };
    const apply = () => { tools.color = rgbToHex(hsvToRgb(hsv)); keepTools(); syncTools(); paint(); };
    let from = '';
    const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * 240 / r.width, (e.clientY - r.top) * 240 / r.height]; };
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', e => { const got = wheel.pick(...at(e)); if (!got) return; from = got.part; try { c.setPointerCapture(e.pointerId); } catch { /* fine */ } hsv = {...hsv, ...got}; delete hsv.part; apply(); });
    c.addEventListener('pointermove', e => { if (!from) return; const got = wheel.pick(...at(e), from); if (got) { hsv = {...hsv, ...got}; delete hsv.part; apply(); } });
    c.addEventListener('pointerup', () => { from = ''; });
    d.body.addEventListener('change', e => { if (e.target.dataset.field === 'hex') { const rgb = hexToRgb(e.target.value); if (rgb) { hsv = rgbToHsv(rgb, hsv.h); apply(); } else e.target.value = tools.color; } });
    d.body.addEventListener('click', e => {
      const r = e.target.closest('[data-recent-color]'); if (r) { hsv = rgbToHsv(hexToRgb(r.dataset.recentColor), hsv.h); apply(); }
      if (e.target.closest('[data-was]')) { hsv = rgbToHsv(hexToRgb(was), hsv.h); apply(); }
    });
    d.onClose(() => { if (tools.color !== was) setColor(tools.color); });
    paint();
  }

  // ---------- 笔刷 ----------
  function preview(canvasEl, brush) {
    const g = canvasEl.getContext('2d'), w = canvasEl.width, h = canvasEl.height;
    if (!g) return;
    const draw = () => {
      g.clearRect(0, 0, w, h);
      const tip = coloredTip(ctx.doc, brush, getComputedStyle(v.root).getPropertyValue('--ink').trim() || '#222'), size = Math.min(h * .7, Math.max(4, brush.size * .5));
      for (let i = 0; i <= 120; i++) {
        const t = i / 120, x = 12 + t * (w - 24), y = h / 2 + Math.sin(t * Math.PI * 2) * h * .22, p = Math.sin(t * Math.PI);
        const st = stampOf(brush, size, p);
        g.globalAlpha = Math.min(1, st.alpha * 2.2) * brush.opacity; g.drawImage(tip, x - st.size / 2, y - st.size / 2, st.size, st.size);
      }
      g.globalAlpha = 1;
    };
    const mask = tipMask(ctx.doc, brush);
    if (mask.ready) draw(); else mask.onready = draw;
  }
  function brushSheet(kind) {
    const d = ctx.dialog(kind === 'eraser' ? '橡皮用的笔刷' : '笔刷库', '');
    const paint = () => {
      const list = allBrushes(ctx.win), mine = current().id, groups = [...new Set(list.map(b => b.group))];
      d.body.innerHTML = `<div class="actions paint-brush-tools"><label class="chip-button file-button">导入笔刷图片<input type="file" accept="image/png,image/jpeg,image/webp" data-brush-file></label>${help('用一张图片做笔尖：透明的 PNG 用它自己的形状，没有透明的图片里越黑的地方颜料越多（和 Photoshop、Procreate 的笔尖一样）。导入后可以在「调整」里改间距、硬度、压力这些。\n\nPhotoshop（.abr）和 Procreate（.brushset）笔刷文件的导入正在做。')}</div>`
        + groups.map(gname => `<p class="group-title"><span>${esc(gname)}</span></p><div class="pick-list">${list.filter(b => b.group === gname).map(b => `<div class="list-row paint-brush-row${b.id === mine ? ' on' : ''}"><button type="button" class="paint-brush-pick" data-brush="${esc(b.id)}"><strong>${esc(b.name)}</strong><canvas width="220" height="44" data-brush-preview="${esc(b.id)}"></canvas></button>${btn('brush-edit', '调整', 'chip-button', `data-id="${esc(b.id)}"`)}</div>`).join('')}</div>`).join('');
      for (const c of d.body.querySelectorAll('[data-brush-preview]')) preview(c, list.find(b => b.id === c.dataset.brushPreview));
    };
    paint();
    d.body.addEventListener('click', e => {
      const b = e.target.closest('[data-brush]');
      if (b) { const brush = brushOf(b.dataset.brush), t = kind === 'eraser' ? tools.eraser : tools.brush; t.id = brush.id; t.size = Math.round(brush.size); t.opacity = 1; tools.kind = kind; keepTools(); tipMask(ctx.doc, brush).onready = () => stage?.render(); d.close(); syncTools(); return; }
      const edit = e.target.closest('[data-action=brush-edit]');
      if (edit) { d.close(); studio(edit.dataset.id, kind); }
    });
    d.body.addEventListener('change', async e => {
      const file = e.target.closest('[data-brush-file]')?.files?.[0];
      if (!file) return;
      try {
        const img = await ctx.win.createImageBitmap(file), tip = maskFromImage(ctx.doc, img);
        const brush = cleanBrush({id: 'u' + Date.now().toString(36), name: file.name.replace(/\.[^.]+$/, '').slice(0, 20) || '导入的笔刷', group: '导入', size: 60, opacity: 1, flow: .8, spacing: .15, hardness: 1, pressureSize: .5, pressureOpacity: .3, streamline: .2, jitter: 0, tip, source: file.name});
        if (!saveUserBrushes(ctx.win, [...userBrushes(ctx.win), brush])) throw Error('这个浏览器存不下更多笔刷了');
        ctx.notify(`导入了笔刷「${brush.name}」`);
        paint();
      } catch (error) { ctx.notify('这张图片做不了笔刷：' + error.message, {error: true}); }
    });
  }
  /** 笔刷工作室: every setting of a brush, with a stroke to try it on; built-in ones can go back to how they were. */
  function studio(id, kind) {
    const base = brushOf(id), built = BRUSHES.find(b => b.id === id);
    let b = {...base};
    const d = ctx.dialog(`调整「${base.name}」`, `<canvas class="paint-studio-preview" width="300" height="70" data-studio-preview></canvas>
      <div class="field"><span>名字</span><input data-studio="name" maxlength="30" value="${esc(b.name)}"></div>
      ${FIELDS.map(([k, label, min, max, step]) => `<div class="field"><div class="meter-label"><span>${label}</span><output data-out="${k}">${k === 'size' ? Math.round(b[k]) : Math.round(b[k] * 100) + '%'}</output></div><input class="slider" type="range" data-studio="${k}" min="${min}" max="${max}" step="${step}" value="${b[k]}"></div>`).join('')}
      <div class="actions">${built ? btn('studio-reset', '恢复默认', 'secondary') : btn('studio-delete', '删除这个笔刷', 'danger')}${btn('studio-save', '保存', 'primary')}</div>`);
    const show = () => preview(d.body.querySelector('[data-studio-preview]'), b);
    show();
    d.body.addEventListener('input', e => {
      const k = e.target.dataset.studio;
      if (!k) return;
      if (k === 'name') { b.name = e.target.value; return; }
      b[k] = Number(e.target.value);
      d.body.querySelector(`[data-out="${k}"]`).textContent = k === 'size' ? String(Math.round(b[k])) : Math.round(b[k] * 100) + '%';
      show();
    });
    d.body.addEventListener('click', async e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      const others = userBrushes(ctx.win).filter(x => x.id !== id);
      if (a === 'studio-save') { saveUserBrushes(ctx.win, [...others, cleanBrush(b)]); d.close(); ctx.notify('笔刷已保存'); brushSheet(kind); }
      if (a === 'studio-reset') { saveUserBrushes(ctx.win, others); d.close(); ctx.notify('已恢复默认'); brushSheet(kind); }
      if (a === 'studio-delete' && await ctx.confirm('删除这个笔刷？', '画好的画不受影响。')) { saveUserBrushes(ctx.win, others); for (const t of [tools.brush, tools.eraser]) if (t.id === id) t.id = 'round'; keepTools(); brushSheet(kind); }
    });
  }

  // ---------- 图层 ----------
  function layerSheet() {
    const d = ctx.dialog('图层', '');
    const paint = () => {
      const on = activeLayer(pic);
      d.body.innerHTML = `<div class="actions paint-layer-tools">${btn('layer-add', '＋ 新图层', 'chip-button')}</div><div class="pick-list paint-layers">${[...pic.layers].reverse().map(l => `<div class="list-row paint-layer${l.id === on.id ? ' on' : ''}" data-layer="${esc(l.id)}">
          <canvas class="paint-layer-thumb" width="60" height="60" data-layer-thumb="${esc(l.id)}"></canvas><span class="grow"><strong>${esc(l.name)}</strong><small>${Math.round(l.opacity * 100)}%</small></span>
          <button type="button" class="icon-button" data-layer-eye="${esc(l.id)}" aria-label="${l.visible ? '隐藏' : '显示'}">${l.visible ? I.eye : I.eyeOff}</button></div>
          ${l.id === on.id ? `<div class="paint-layer-more"><div class="field"><div class="meter-label"><span>不透明度</span><output>${Math.round(l.opacity * 100)}%</output></div><input class="slider" type="range" min="0" max="100" value="${Math.round(l.opacity * 100)}" data-layer-opacity></div>
            <div class="actions">${btn('layer-up', '上移', 'chip-button')}${btn('layer-down', '下移', 'chip-button')}${btn('layer-clear', '清空', 'chip-button')}${btn('layer-delete', '删除', 'chip-button danger', pic.layers.length < 2 ? 'disabled' : '')}</div></div>` : ''}`).join('')}
          <div class="list-row paint-layer paint-bg"><input type="color" value="${esc(pic.background)}" data-bg-color aria-label="背景颜色"><span class="grow"><strong>背景颜色</strong><small>${pic.showBackground ? esc(pic.background) : '透明'}</small></span><button type="button" class="icon-button" data-bg-eye aria-label="${pic.showBackground ? '隐藏' : '显示'}背景">${pic.showBackground ? I.eye : I.eyeOff}</button></div></div>`;
      for (const c of d.body.querySelectorAll('[data-layer-thumb]')) {
        const l = pic.layers.find(x => x.id === c.dataset.layerThumb), g = c.getContext('2d'), s = Math.min(60 / pic.width, 60 / pic.height);
        g?.drawImage(l.canvas, (60 - pic.width * s) / 2, (60 - pic.height * s) / 2, pic.width * s, pic.height * s);
      }
    };
    const changed = () => { stage.render(); syncSide(); saveSoon(); paint(); };
    paint();
    d.body.addEventListener('click', async e => {
      const eye = e.target.closest('[data-layer-eye]');
      if (eye) { const l = pic.layers.find(x => x.id === eye.dataset.layerEye); l.visible = !l.visible; pic.changed++; return changed(); }
      if (e.target.closest('[data-bg-eye]')) { pic.showBackground = !pic.showBackground; pic.changed++; return changed(); }
      const a = e.target.closest('[data-action]')?.dataset.action, on = activeLayer(pic);
      if (a === 'layer-add') { addLayer(pic); return changed(); }
      if (a === 'layer-up') { moveLayer(pic, on.id, 1); return changed(); }
      if (a === 'layer-down') { moveLayer(pic, on.id, -1); return changed(); }
      if (a === 'layer-clear') { clearLayer(pic, on.id); return changed(); }
      if (a === 'layer-delete') { removeLayer(pic, on.id); return changed(); }
      const row = e.target.closest('[data-layer]');
      if (row && !e.target.closest('input')) { pic.active = row.dataset.layer; pic.changed++; paint(); }
    });
    d.body.addEventListener('input', e => {
      if (e.target.matches('[data-layer-opacity]')) { activeLayer(pic).opacity = Number(e.target.value) / 100; e.target.previousElementSibling.querySelector('output').textContent = e.target.value + '%'; pic.changed++; stage.render(); }
      if (e.target.matches('[data-bg-color]')) { pic.background = e.target.value; pic.showBackground = true; pic.changed++; stage.render(); }
    });
    d.body.addEventListener('change', e => { if (e.target.matches('[data-layer-opacity], [data-bg-color]')) { saveSoon(); paint(); } });
  }

  async function actions() {
    const a = await menu(ctx, work?.name || '作品', [
      {key: 'album', icon: 'image', label: '存到相册', note: '把所有图层合成一张放进相册'},
      {key: 'download', icon: 'download', label: '下载 PNG'},
      {key: 'fit', icon: 'next', label: '适应屏幕', note: '回到整张画都看得见的样子'},
      {key: 'rename', icon: 'edit', label: '重命名'}]);
    try {
      if (a === 'album') await toAlbum(pic, work.name);
      if (a === 'download') { const blob = await blobOf(flatten(pic)); if (blob) ctx.notify('已下载 ' + await saveFile(ctx.doc, blob, work.name)); }
      if (a === 'fit') stage.fit();
      if (a === 'rename') {
        const d = ctx.dialog('作品名字', `<div class="field"><input data-field="work-name" maxlength="40" value="${esc(work.name)}"></div><div class="actions">${btn('work-name-save', '保存', 'primary')}</div>`);
        d.body.addEventListener('click', e => { if (!e.target.closest('[data-action=work-name-save]')) return; work.name = d.body.querySelector('[data-field=work-name]').value.trim() || work.name; d.close(); pic.changed++; save(); });
      }
    } catch (error) { ctx.notify(error.message, {error: true}); }
  }

  // ---------- 点按 ----------
  v.on('click', '[data-action]', async el => {
    switch (el.dataset.action) {
      case 'paint-new': newSheet(); break;
      case 'work-more': await workMenu(el.dataset.id); break;
      case 'paint-gallery': await leaveEditor(); break;
      case 'paint-actions': await actions(); break;
      case 'tool-brush': if (tools.kind === 'brush') brushSheet('brush'); else { tools.kind = 'brush'; keepTools(); syncTools(); } break;
      case 'tool-eraser': if (tools.kind === 'eraser') brushSheet('eraser'); else { tools.kind = 'eraser'; keepTools(); syncTools(); } break;
      case 'tool-pick': tools.kind = tools.kind === 'pick' ? 'brush' : 'pick'; keepTools(); syncTools(); break;
      case 'paint-layers': layerSheet(); break;
      case 'paint-color': colorSheet(); break;
      case 'paint-undo': doUndo(); break;
      case 'paint-redo': doRedo(); break;
    }
  });
  v.on('click', '[data-work]', el => openWork(el.dataset.work));
  v.on('input', '[data-paint]', el => {
    const t = current();
    if (el.dataset.paint === 'size') { t.size = fromSlider(Number(el.value)); v.root.querySelector('[data-paint-size-value]').textContent = String(t.size); }
    else t.opacity = Number(el.value) / 100;
  });
  v.on('change', '[data-paint]', () => keepTools());
  // Keys while drawing on a computer: undo and redo, the tools, the size, space to move the picture.
  ctx.doc.addEventListener('keydown', e => {
    if (mode !== 'edit' || !stage || ctx.visible?.('paint') === false || e.target.closest?.('input, textarea, select, [contenteditable], .sheet')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
    if (mod) return;
    if (k === ' ') { e.preventDefault(); stage.space(true); return; }
    const t = current();
    if (k === '[' || k === ']') { t.size = Math.max(1, Math.min(400, Math.round(t.size * (k === ']' ? 1.15 : 1 / 1.15)) + (k === ']' ? 1 : 0))); keepTools(); syncSide(); return; }
    const kind = {b: 'brush', e: 'eraser', i: 'pick'}[k];
    if (kind) { tools.kind = kind; keepTools(); syncTools(); }
  }, {signal: keys.signal});
  ctx.doc.addEventListener('keyup', e => { if (e.key === ' ') stage?.space(false); }, {signal: keys.signal});

  v.back = () => { if (mode !== 'edit') return false; leaveEditor(); return true; };
  v.leave = () => { if (mode === 'edit') save(); };
  v.refresh = () => { if (mode === 'gallery') renderGallery(); };
  const dispose = v.dispose;
  v.dispose = () => { keys.abort(); ctx.win.clearTimeout(saveTimer); save(); closeEditor(); store.close(); dispose(); };
  renderGallery();
  return v;
}
