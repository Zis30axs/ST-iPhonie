import http from 'node:http';
import https from 'node:https';
import {BridgeError} from './util.mjs';

export const MAX_AUDIO = 32 * 1024 * 1024;
export async function readLimited(response, limit = 4 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit)
    { await response.body?.cancel(); throw new BridgeError('远端响应超过大小限制。', 502, 'response_too_large'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); let total = 0; const chunks = [];
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) throw new BridgeError('远端响应超过大小限制。', 502, 'response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
export async function fetchJSON(url, options = {}, {fetcher = fetch, timeout = 30000, limit = 4 * 1024 * 1024} = {}) {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const response = await fetcher(url, {...options, signal, redirect: options.redirect || 'follow'});
  let value;
  try { value = JSON.parse((await readLimited(response, limit)).toString('utf8')); }
  catch (e) {
    if (e instanceof BridgeError || e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
    throw new BridgeError(`远端返回非 JSON 响应（HTTP ${response.status}）。`, 502, 'non_json_response');
  }
  return {response, value};
}
export function audioMime(bytes) {
  const tag = (n, count) => bytes.subarray(n, n + count).toString('ascii');
  if (bytes.length >= 12 && ['RIFF', 'RF64'].includes(tag(0, 4)) && tag(8, 4) === 'WAVE') return 'audio/wav';
  if (tag(0, 4) === 'OggS') return 'audio/ogg';
  if (tag(0, 4) === 'fLaC') return 'audio/flac';
  if (tag(0, 3) === 'ID3' || (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (bytes.length >= 12 && tag(4, 4) === 'ftyp') return 'audio/mp4';
  throw new BridgeError('返回内容不是可识别的音频。未把 HTML、JSON 或无音频头的 PCM 当作成功。', 502, 'invalid_audio');
}
/** HTTP(S) transport, without protocol upgrades, port/domain allowlists or IP classification.
 * The old export name is retained for callers. OAuth/bridge tokens are never attached.
 * Only HTTP(S) is implemented; response size, timeouts and actual audio checks remain.
 */
export async function safeDownloadAudio(rawURL, {signal, maxBytes = MAX_AUDIO, resolver} = {}) {
  let url;
  try { url = new URL(rawURL); } catch { throw new BridgeError('MCP 返回的音频链接格式无效。', 502, 'invalid_audio_url'); }
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  for (let redirects = 0; redirects <= 10; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol))
      throw new BridgeError('音频下载仅实现 HTTP 和 HTTPS 传输。', 502, 'unsupported_audio_protocol');
    // Optional resolver is an injection point for tests, not a DNS preflight or IP filter.
    const lookup = resolver ? (hostname, options, callback) => {
      Promise.resolve().then(() => resolver(hostname, {all: true})).then(addresses => {
        if (!addresses.length) return callback(Object.assign(new Error('No DNS addresses'), {code: 'ENOTFOUND'}));
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }, callback);
    } : undefined;
    const result = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'http:' ? http : https;
      const req = transport.get(url, {signal: deadline,
        headers: {Accept: 'audio/*, application/octet-stream', 'User-Agent': 'ST-iPhonie-Fish-MCP/0.1.1'},
        ...(lookup ? {lookup} : {})
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location; res.resume(); resolve({location}); return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new BridgeError(`音频下载失败（HTTP ${res.statusCode}）。`, 502, 'audio_download_failed')); return; }
        if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); reject(new BridgeError('音频超过大小限制。', 502, 'audio_too_large')); return; }
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(); reject(new BridgeError('音频超过大小限制。', 502, 'audio_too_large')); }
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new BridgeError('音频下载被远端中断。', 502, 'audio_download_interrupted')));
        res.on('end', () => resolve({bytes: Buffer.concat(chunks)}));
      });
      req.on('error', reject);
    });
    if (result.bytes) return {bytes: result.bytes, mime: audioMime(result.bytes)};
    if (!result.location) throw new BridgeError('音频跳转缺少目标地址。', 502, 'invalid_redirect');
    try { url = new URL(result.location, url); }
    catch { throw new BridgeError('音频跳转地址格式无效。', 502, 'invalid_redirect'); }
  }
  throw new BridgeError('音频链接重定向次数过多。', 502, 'redirect_limit');
}
