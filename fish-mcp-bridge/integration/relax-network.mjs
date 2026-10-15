import {readFile, copyFile, writeFile, rename} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Targeted edits for ST-iPhonie 0.7.80. No model/config/chat/key files are reset.
// Normal URL parsing stays; HTTP transport decisions are not made from page.protocol.
export const TARGETS = ['core/novelai.js', 'core/image-engines.js', 'core/music.js', 'core/cloud-queue.js'];
const MARKER = 'network-unlocked:';
export function relaxSource(path, source) {
  if (!TARGETS.includes(path)) throw new Error('Unsupported patch target: ' + path);
  const crlf = source.includes('\r\n');
  const original = source;
  source = source.replace(/\r\n/g, '\n');
  let content = source;
  if (path === 'core/novelai.js' || path === 'core/image-engines.js') {
    const guard = /^[ \t]*if \(url\.protocol === 'http:' && pageProtocol === 'https:'[^\r\n]*throw Error\([^\r\n]*\);[ \t]*$/gm;
    if (!guard.test(source) && !source.includes(MARKER)) throw new Error(path + ': expected HTTP guard not found; original file left unchanged.');
    content = source.replace(guard, '  // network-unlocked: retain the chosen protocol; attempt the actual request.');
    content = content.replaceAll('要以 https:// 开头', '要以 http:// 或 https:// 开头')
      .replaceAll('以 https:// 开头，不带 ? 和 #', '以 http:// 或 https:// 开头，不带 ? 和 #')
      .replace('A page opened over HTTPS cannot reach an http:// relay (except on this computer).', 'HTTP and HTTPS relays retain the protocol chosen by the user.');
  } else if (path === 'core/music.js') {
    const declaration = /^export const playable = [^\r\n]+;[^\r\n]*$/gm;
    if (!declaration.test(source)) throw new Error(path + ': playable declaration not found; original file left unchanged.');
    content = source.replace(declaration, "export const playable = (link, _pageProtocol = 'http:') => link; // network-unlocked: no automatic HTTPS rewrite.")
      .replace('An http link on a page opened over https would be blocked: upgraded, unless it is the user\'s own nearby server.', 'Keep the supplied media URL unchanged, regardless of the page protocol.');
  } else {
    const guard = "if (!/^https:\\/\\//.test(this.url)) throw Error('云端队列地址需要以 https:// 开头');";
    if (!source.includes(guard) && !source.includes(MARKER)) throw new Error(path + ': expected queue guard not found; original file left unchanged.');
    content = source.replaceAll(guard, '// network-unlocked: HTTP(S) queue URLs are passed to the actual transport.');
  }
  if (crlf) content = content.replace(/\n/g, '\r\n');
  return {content, changed: content !== original};
}
export async function relaxNetwork(extensionDir, {backup = true} = {}) {
  const root = resolve(extensionDir), plan = [];
  // Read and validate all targets before any writes, including optional older-version files.
  for (const path of TARGETS) {
    const file = join(root, path);
    let source;
    try { source = await readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT' && ['core/music.js', 'core/cloud-queue.js'].includes(path)) continue; throw e; }
    plan.push({file, path, ...relaxSource(path, source)});
  }
  for (const entry of plan.filter(e => e.changed)) {
    if (backup) { try { await copyFile(entry.file, entry.file + '.before-network-unlock.bak', 1); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    const temp = entry.file + '.network-unlock.tmp';
    await writeFile(temp, entry.content, 'utf8'); await rename(temp, entry.file);
  }
  return plan.map(({path, changed}) => ({path, changed}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('用法：node relax-network.mjs "ST-iPhonie 扩展目录"');
    for (const row of await relaxNetwork(process.argv[2])) console.log((row.changed ? '已修改 ' : '无需修改 ') + row.path);
    console.log('完成。刷新酒馆页面。原文件备份为 *.before-network-unlock.bak；服务端鉴权与浏览器策略未改变。');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
