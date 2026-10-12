// Saving pictures and audio to the device. Used both in the tavern page and in the phone's frame.
// 下载 is always a real download, from the topmost page the phone sits in (a frame's own rules about downloads do not
// apply there). A phone browser only lets a page start a download soon after a tap: when the file took longer than that
// to make (a voice line generated first), a small 「点这里保存」 bar asks for one more tap instead of losing it.
// 分享 (shareFile) is a separate, explicit action: the system's share sheet with the file (保存到文件 / 发给别人).
const EXTENSIONS = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg',
  'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/webm': 'webm',
  'text/plain': 'txt', 'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif'
};
const KNOWN = /\.(png|jpe?g|webp|avif|gif|mp3|wav|ogg|opus|flac|aac|m4a|webm|txt|json)$/i;

/** A file name every system accepts, ending in the extension that matches the file's type. */
export function fileName(base, type = '', fallback = 'ST-iPhonie') {
  let name = String(base ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  const ext = EXTENSIONS[String(type).split(';')[0].trim().toLowerCase()];
  if (ext) name = name.replace(KNOWN, '');
  name = [...(name || fallback)].slice(0, 80).join('').trim() || fallback;
  return ext ? `${name}.${ext}` : name;
}

async function blobOf(win, source) {
  let blob = source;
  if (typeof source === 'string') {
    const response = await win.fetch(source);
    if (!response.ok) throw Error(`文件读取失败（HTTP ${response.status}）`);
    blob = await response.blob();
  }
  if (!blob || typeof blob.arrayBuffer !== 'function' || !blob.size) throw Error('没有可以下载的文件');
  return blob;
}
/** The page the phone sits in (same site), else this one. */
function topDocument(doc) {
  const win = doc.defaultView;
  try { if (win.top && win.top !== win && win.top.document?.body) return win.top.document; } catch { /* another site: stay here */ }
  return doc;
}
function download(doc, blob, name) {
  const top = topDocument(doc), win = top.defaultView || doc.defaultView;
  const url = win.URL.createObjectURL(blob), link = top.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.hidden = true;
  top.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the file after click() returns.
  (doc.defaultView || win).setTimeout(() => win.URL.revokeObjectURL(url), 60000);
}
const touch = win => !!win.matchMedia?.('(pointer:coarse)').matches;
// The tap that started this has expired (only browsers that say so: navigator.userActivation).
const tapExpired = win => { try { return touch(win) && win.navigator?.userActivation?.isActive === false; } catch { return false; } };
/** 「文件准备好了 · 点这里保存」: resolves on the tap (the download starts inside it), rejects after a while or on ✕. */
function askTap(doc, name, download) {
  const win = doc.defaultView;
  doc.querySelector('[data-save-tap]')?.remove();
  const bar = doc.createElement('div');
  bar.dataset.saveTap = '';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:6px;max-width:calc(100% - 32px);padding:6px;border-radius:999px;background:rgba(30,34,44,.92);color:#fff;font:600 14px/1.2 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.28)';
  const go = doc.createElement('button'), close = doc.createElement('button');
  go.type = close.type = 'button';
  go.textContent = '文件准备好了 · 点这里保存';
  go.title = name;
  go.style.cssText = 'border:0;border-radius:999px;padding:9px 14px;background:#3d8ff0;color:#fff;font:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  close.textContent = '✕';
  close.setAttribute('aria-label', '不保存');
  close.style.cssText = 'border:0;border-radius:999px;width:32px;height:32px;background:transparent;color:inherit;font:inherit;cursor:pointer';
  bar.append(go, close);
  doc.body.append(bar);
  return new Promise((resolve, reject) => {
    const done = ok => { win.clearTimeout(timer); bar.remove(); if (ok) resolve(); else reject(Error('已取消保存')); };
    const timer = win.setTimeout(() => done(false), 20000);
    go.addEventListener('click', () => { try { download(); done(true); } catch (error) { win.clearTimeout(timer); bar.remove(); reject(error); } });
    close.addEventListener('click', () => done(false));
    go.focus?.({preventScroll: true});
  });
}

/** Saves a Blob, or the file at a URL (blob:, data: or a path on the tavern), under the given name. Returns the name. */
export async function saveFile(doc, source, base) {
  const blob = await blobOf(doc.defaultView, source), name = fileName(base, blob.type);
  if (tapExpired(doc.defaultView)) await askTap(doc, name, () => download(doc, blob, name));
  else download(doc, blob, name);
  return name;
}
/** Whether this device can hand a file to the system's share sheet (phones and tablets). */
export function canShareFiles(win) {
  try { return touch(win) && typeof win.navigator?.share === 'function' && typeof win.navigator.canShare === 'function' && !!win.File; } catch { return false; }
}
/**
 * The share sheet with the file (保存到文件, 存储, 发给别人). Turned down by the user: an error saying so. Where the sheet
 * cannot take this file: an error saying to use 下载 instead. Returns the name.
 */
export async function shareFile(doc, source, base) {
  const win = doc.defaultView, blob = await blobOf(win, source), name = fileName(base, blob.type), nav = win.navigator;
  if (!canShareFiles(win)) throw Error('这个浏览器不能分享文件，请用「下载」');
  let file;
  try { file = new win.File([blob], name, {type: blob.type || 'application/octet-stream'}); } catch { throw Error('这个文件不能分享，请用「下载」'); }
  if (!nav.canShare({files: [file]})) throw Error('这个浏览器不能分享这种文件，请用「下载」');
  try { await nav.share({files: [file], title: name}); }
  catch (error) {
    if (error?.name === 'AbortError') throw Error('已取消分享');
    throw Error('分享没有打开（点得太久以前了？）再点一次「分享」试试');
  }
  return name;
}

/** A 下载 button for the image viewer: keeps the viewer open and reports how it went. */
export function downloadAction(doc, pick, notify = () => {}) {
  return {label: '下载', run: async index => {
    try {
      const {source, name} = await pick(index);
      notify(`已下载 ${await saveFile(doc, source, name)}`);
    } catch (error) { notify(error.message === '已取消保存' ? error.message : `下载失败：${error.message}`, {error: !/已取消/.test(error.message)}); }
    return false;
  }};
}
/** A 分享 button for the image viewer, on devices with a share sheet (null elsewhere). */
export function shareAction(doc, pick, notify = () => {}) {
  if (!canShareFiles(doc.defaultView)) return null;
  return {label: '分享', run: async index => {
    try {
      const {source, name} = await pick(index);
      await shareFile(doc, source, name);
    } catch (error) { notify(error.message, {error: !/已取消/.test(error.message)}); }
    return false;
  }};
}
