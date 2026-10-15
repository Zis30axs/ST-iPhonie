// Function-level source fixtures read from hey8v0/ST-iPhonie, commit 5be4cd1.
// The mixed-content guards and playable declaration below match the checked upstream.
export const upstream = {
  'core/novelai.js': String.raw`const NAI_PATHS = /\/(ai\/generate-image(-stream)?|user\/subscription)$/i;
export const FISH_PATHS = /\/(compat\/v1\/audio\/speech|v1\/audio\/speech|audio\/speech|v1\/tts|v1\/models|model|wallet\/self\/api-credit)$/i;
export function relayUrl(value, pageProtocol = globalThis.location?.protocol, strip = NAI_PATHS) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url; try { url = new URL(raw); } catch { throw Error('中转地址格式不对，要以 https:// 开头'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('中转地址格式不对：以 https:// 开头，不带 ? 和 #');
  if (url.protocol === 'http:' && pageProtocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('酒馆是用 HTTPS 打开的，浏览器不允许连 http:// 的中转，请给中转配上 HTTPS');
  return (url.origin + url.pathname).replace(/\/+$/, '').replace(strip, '');
}
`,
  'core/image-engines.js': String.raw`export function gptBase(value, pageProtocol = globalThis.location?.protocol) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url; try { url = new URL(raw); } catch { throw Error('接口地址格式不对，要以 https:// 开头'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('接口地址格式不对：以 https:// 开头，不带 ? 和 #');
  if (url.protocol === 'http:' && pageProtocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('酒馆是用 HTTPS 打开的，浏览器不允许连 http:// 的接口，请换成 HTTPS 地址');
  let path = url.pathname.replace(/\/+$/, '').replace(/\/images\/(generations|edits)$/i, '');
  if (!/\/v\d+$/i.test(path)) path += '/v1';
  return url.origin + path;
}
`,
  'core/music.js': String.raw`export const nearby = link => { try { return /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[::1\]$|[^.]+$)/i.test(new URL(link).hostname); } catch { return false; } };
/** An http link on a page opened over https would be blocked: upgraded, unless it is the user's own nearby server. */
export const playable = (link, pageProtocol = 'http:') => pageProtocol === 'https:' && /^http:\/\//i.test(link) && !nearby(link) ? link.replace(/^http:\/\//i, 'https://') : link;
`,
  'core/cloud-queue.js': String.raw`export const validRoom = room => /^[A-Za-z0-9_-]{16,64}$/.test(String(room || ''));
export class CloudQueue {
  constructor({url, room}, {fetcher = fetch} = {}) { this.url = url; this.room = room; this.fetcher = fetcher; }
  async call(body, signal) {
    if (!/^https:\/\//.test(this.url)) throw Error('云端队列地址需要以 https:// 开头');
    if (!validRoom(this.room)) throw Error('房间码需要 16–64 个字母或数字');
    let response;
    try { response = await this.fetcher(this.url + '/q/' + encodeURIComponent(this.room), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal}); }
    catch { throw Error('连不上云端队列，请检查地址和网络'); }
    if (!response.ok) throw Error('云端队列出错');
    return response.json();
  }
}
export class KeyHashQueue {
  constructor({url}, {fetcher = fetch} = {}) { this.url = url; this.fetcher = fetcher; }
  async request(path, body, signal) {
    if (!/^https:\/\//.test(this.url)) throw Error('云端队列地址需要以 https:// 开头');
    return (await this.fetcher(this.url + path, {signal})).json();
  }
}
`
};
