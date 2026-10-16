import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';
import {BridgeError, isObject, safeEqual, publicError} from './util.mjs';
import {defaultConfig} from './state.mjs';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
async function bodyJSON(req) {
  if (Number(req.headers['content-length']) > 65536) { req.resume(); throw new BridgeError('请求体不能超过 64 KiB。', 413, 'body_too_large'); }
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw new BridgeError('请求的 Content-Type 必须是 application/json。', 415, 'invalid_content_type');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; if (size > 65536) throw new BridgeError('请求体不能超过 64 KiB。', 413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('请求体不是有效 JSON。', 400, 'invalid_json'); }
}
function configValue(value) {
  if (!isObject(value) || !isObject(value.speech) || !isObject(value.speech.fields || {}) || !isObject(value.speech.extra || {}))
    throw new BridgeError('配置必须包含 speech 对象；fields、extra 必须是对象。', 400, 'invalid_config');
  const base = defaultConfig();
  const config = {...base, ...value, speech: {...base.speech, ...value.speech}};
  for (const [key, val] of Object.entries(config.speech.fields)) if (!['text', 'voice', 'language', 'model', 'emotion', 'format', 'speed'].includes(key) || typeof val !== 'string')
    throw new BridgeError('speech.fields 只支持 text/voice/language/model/emotion/format/speed 的字符串映射。', 400, 'invalid_config');
  for (const key of ['tool', 'resultPath', 'pollTool', 'pollIdField', 'pollIdPath', 'pollResultPath'])
    if (typeof config.speech[key] !== 'string' || config.speech[key].length > 1024) throw new BridgeError(`speech.${key} 必须是字符串。`, 400, 'invalid_config');
  if (!isObject(config.speech.pollExtra) || !isObject(config.voiceFields) || !isObject(config.voiceExtra))
    throw new BridgeError('pollExtra、voiceFields、voiceExtra 必须是对象。', 400, 'invalid_config');
  if (typeof config.voiceTool !== 'string' || typeof config.voiceResultPath !== 'string')
    throw new BridgeError('voiceTool 和 voiceResultPath 必须是字符串。', 400, 'invalid_config');
  if (!Array.isArray(config.voices) || config.voices.length > 500 || config.voices.some(v => !isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || v.id.length > 4096 || v.name.length > 1024))
    throw new BridgeError('voices 必须是最多 500 项的 {id, name} 列表；音色名称支持中文。', 400, 'invalid_config');
  return config;
}
export function createBridgeServer({oauth, mcp, speech, store}) {
  // No application-level Origin/Host/IP allowlist. The bridge key still protects APIs.
  function json(res, status, value) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req, res) => {
    const start = Date.now(); const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    req.on('aborted', () => controller.abort());
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = String(req.headers.host || 'localhost');
      let incoming;
      try { incoming = new URL('http://' + host); } catch { throw new BridgeError('Host 不合法。', 400, 'invalid_host'); }
      const url = new URL(req.url, incoming.origin);
      const origin = req.headers.origin;
      if (origin && url.pathname !== '/oauth/callback') {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'X-Bridge-Cache, X-Bridge-Elapsed-Ms');
        if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, {service: 'st-iphonie-fish-mcp-bridge', version: '0.1.2', ready: oauth.status().authorized}); return;
      }
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'app.css': 'text/css'}[name];
        res.writeHead(200, {'Content-Type': type + '; charset=utf-8'}); res.end(await readFile(join(PUBLIC, name))); return;
      }
      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        await oauth.finish(url.searchParams.get('code'), url.searchParams.get('state'), url.searchParams.get('error'));
        mcp.reset(); speech.reset();
        res.writeHead(303, {Location: '/'});
        res.end(); return;
      }
      const authorization = String(req.headers.authorization || '');
      if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7), store.data.bridgeKey))
        throw new BridgeError('缺少或错误的桥接密钥。这里填适配器控制台的密钥，不是 Fish API Key。', 401, 'invalid_bridge_key');
      if (req.method === 'GET' && url.pathname === '/admin/status') {
        json(res, 200, {...oauth.status(), endpoint: oauth.endpoint, connected: mcp.ready,
          queued: speech.waiting, cached: speech.cache.size, pendingJobs: speech.jobs.size, config: store.data.config}); return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/login') {
        if (speech.waiting) throw new BridgeError('请先让配音队列完成，再切换授权。', 409, 'generation_active');
        await bodyJSON(req); json(res, 200, {url: await oauth.start()}); return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/logout') {
        if (speech.waiting) throw new BridgeError('配音队列仍在执行，暂不能清除授权。', 409, 'generation_active');
        await bodyJSON(req); await oauth.clear(); mcp.reset(); speech.reset(); json(res, 200, {clearedLocalAuthorization: true}); return;
      }
      if (req.method === 'GET' && url.pathname === '/admin/tools') {
        const tools = await mcp.tools(url.searchParams.get('refresh') === '1');
        let detected = null;
        try { const plan = await speech.plan(); detected = {tool: plan.tool.name, fields: plan.fields}; } catch (error) { detected = {error: publicError(error).message}; }
        json(res, 200, {tools, detected}); return;
      }
      if (req.method === 'POST' && url.pathname === '/admin/config') {
        if (speech.waiting) throw new BridgeError('请先让配音队列完成，再修改参数映射。', 409, 'generation_active');
        const config = configValue(await bodyJSON(req));
        await store.update(s => { s.config = config; });
        // Preserve accepted jobs: adjusting a polling/result mapping must not resubmit synthesis.
        json(res, 200, {saved: true}); return;
      }
      if (req.method === 'GET' && ['/voices', '/v1/voices'].includes(url.pathname)) {
        json(res, 200, await speech.voices((url.searchParams.get('search') || '').slice(0, 200))); return;
      }
      if (req.method === 'POST' && ['/v1/audio/speech', '/tts'].includes(url.pathname)) {
        const input = await bodyJSON(req);
        const audio = await speech.synthesize(input, AbortSignal.any([controller.signal, AbortSignal.timeout(240000)]));
        if (!res.destroyed) {
          res.writeHead(200, {'Content-Type': audio.mime, 'Content-Length': audio.bytes.length,
            'X-Bridge-Cache': audio.cached ? 'hit' : 'miss', 'X-Bridge-Elapsed-Ms': String(Date.now() - start)});
          res.end(audio.bytes);
        }
        return;
      }
      throw new BridgeError('没有这个路由或请求方式。', 404, 'not_found');
    } catch (error) {
      const clean = publicError(error);
      if (!res.headersSent && !res.destroyed) json(res, clean.status, {error: {code: clean.code, message: clean.message}});
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 300000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  return server;
}
