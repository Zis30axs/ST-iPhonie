import {readFile, writeFile, copyFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

export const TEMPLATE = `  // Fish MCP bridge: OAuth lives in the local adapter, NOT in this browser extension.
  {id: 'fish-mcp', name: 'Fish MCP（网页套餐积分）', example: 'http://127.0.0.1:3789',
    note: '先启动 fish-mcp-bridge 并在本机控制台登录 Fish、选择 Plus 团队。上面的密钥填桥接密钥，不是 Fish API Key。音色可先填 default。手机访问电脑需使用电脑 IP；默认不再限制酒馆来源。',
    fill: rawBase => { const base = rawBase.replace(/\\/+$/, ''); return {url: base + '/v1/audio/speech', method: 'POST', answer: 'audio', path: '', headers: '', before: '',
      listUrl: base + '/voices', listPath: 'voices',
      body: JSON.stringify({model: 'fish-mcp', input: '{{text}}', voice: '{{voice}}', language: '{{lang}}', emotion: '{{emotion}}'}, null, 2)}; }},
`;
export function applyTemplate(source) {
  if (/id:\s*['"]fish-mcp['"]/.test(source)) return {content: source, changed: false};
  const anchor = 'export const CUSTOM_TEMPLATES = Object.freeze([';
  if (source.split(anchor).length !== 2) throw new Error('Upstream CUSTOM_TEMPLATES structure changed. Refusing a blind rewrite.');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  if (!source.includes(anchor + eol)) throw new Error('Upstream template formatting changed. Refusing a blind rewrite.');
  return {content: source.replace(anchor + eol, anchor + eol + TEMPLATE.replace(/\n/g, eol)), changed: true};
}
export async function installTemplate(extensionDir, {backup = true} = {}) {
  const file = join(resolve(extensionDir), 'core', 'custom-voice.js');
  const source = await readFile(file, 'utf8'); const result = applyTemplate(source);
  if (!result.changed) return {changed: false, file};
  if (backup) await copyFile(file, file + '.before-fish-mcp.bak', 1); // COPYFILE_EXCL: never replace a previous backup
  await writeFile(file, result.content, 'utf8');
  return {changed: true, file};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node integration/install-template.mjs "path/to/ST-iPhonie"');
    const result = await installTemplate(process.argv[2]);
    console.log(result.changed ? 'Fish MCP template added. Refresh SillyTavern; original file backed up alongside it.' : 'Fish MCP template already present; nothing changed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
