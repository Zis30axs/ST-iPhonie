import {mcpHttpError} from './mcp-errors.js';
/** Phone-only Fish OAuth + MCP experiment. No Node, cookies, popup callbacks or intermediary server. */
export const DEFAULTS = Object.freeze({endpoint: 'https://api.fish.audio/mcp', redirectURI: 'http://127.0.0.1:3789/oauth/callback', clientId: '', scope: ''});
export class MobileError extends Error {
  constructor(stage, message, code = 'failed') { super(message); this.stage = stage; this.code = code; }
}
const fail = (stage, message, code) => { throw new MobileError(stage, message, code); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));
const url = (value, stage = '配置') => {
  let u; try { u = new URL(value); } catch { fail(stage, '地址格式无效。'); }
  if (!['http:', 'https:'].includes(u.protocol)) fail(stage, '仅支持 HTTP/HTTPS 网络地址。');
  if (u.username || u.password || u.hash) fail(stage, '网络地址不能包含内嵌凭据或 #。');
  return u;
};
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function pkce(cryptoAPI = globalThis.crypto) {
  if (!cryptoAPI?.getRandomValues || !cryptoAPI?.subtle) fail('PKCE', '当前 WebView 没有可用的 Web Crypto；没有降级成弱随机数。');
  const verifier = b64url(cryptoAPI.getRandomValues(new Uint8Array(32)));
  const state = b64url(cryptoAPI.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await cryptoAPI.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return {verifier, state, challenge};
}
export function parseCallback(raw, pending, now = Date.now()) {
  if (!pending || pending.expiresAt < now || pending.attempted) fail('回调', '这次登录已过期或已尝试交换。请重新生成登录链接。', 'invalid_state');
  let callback; try { callback = new URL(String(raw).trim()); } catch { fail('回调', '请粘贴完整的回调 URL，不是登录网址或单独的 code。'); }
  const expected = new URL(pending.redirectURI);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash)
    fail('回调', '回调地址与本次注册的 redirect_uri 不一致。');
  for (const [key, value] of expected.searchParams) if (callback.searchParams.get(key) !== value) fail('回调', '回调地址的固定参数已改变。');
  if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== pending.state)
    fail('回调', 'state 不匹配，请使用本次登录产生的回调。', 'invalid_state');
  if (callback.searchParams.has('error')) fail('回调', '授权服务拒绝或取消了登录。', 'authorization_denied');
  if (callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code')) fail('回调', '没有收到有效的授权 code。');
  return callback.searchParams.get('code');
}

/** Inspect generated OAuth URL locally; never reveal IDs or authorization state in diagnostics. */
export function inspectAuthorizationLink(raw, {clientId = '', redirectURI = ''} = {}) {
  const u = url(raw, 'OAuth 登录链接');
  for (const name of ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method']) {
    if (u.searchParams.getAll(name).length !== 1 || !u.searchParams.get(name)?.trim())
      fail('OAuth 登录链接', name + ' 缺失或重复。请重新生成并复制完整链接，而不是 Fish 登录首页。', 'invalid_authorization_url');
  }
  if (u.searchParams.get('response_type') !== 'code' || u.searchParams.get('code_challenge_method') !== 'S256')
    fail('OAuth 登录链接', 'PKCE 或授权码参数不正确。', 'invalid_authorization_url');
  if (clientId && u.searchParams.get('client_id') !== clientId)
    fail('OAuth 登录链接', 'client_id 与注册客户端不一致。', 'invalid_authorization_url');
  if (redirectURI && u.searchParams.get('redirect_uri') !== redirectURI)
    fail('OAuth 登录链接', 'redirect_uri 与注册回调不一致。', 'invalid_authorization_url');
  const redirect = url(u.searchParams.get('redirect_uri'), 'OAuth 回调地址');
  return {authorizationOrigin: u.origin, authorizationPath: u.pathname, clientIdPresent: true, redirectUriPresent: true,
    pkceS256Present: true, redirectOrigin: redirect.origin, redirectPath: redirect.pathname};
}
function makeAuthorizationLink(discovery, clientId, redirectURI, state, challenge, scope = '') {
  if (!discovery?.metadata?.authorization_endpoint) fail('OAuth 登录链接', '尚未发现合法的授权端点。');
  const u = url(discovery.metadata.authorization_endpoint, 'OAuth 授权端点');
  const params = {response_type: 'code', client_id: clientId, redirect_uri: redirectURI, state, code_challenge: challenge,
    code_challenge_method: 'S256', resource: discovery.resource};
  if (scope) params.scope = scope;
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  inspectAuthorizationLink(u.href, {clientId, redirectURI});
  return u.href;
}

/** Await the response with the matching RPC id; stop reading SSE as soon as it arrives. */
export async function readRpc(response, id) {
  let total = 0; const limit = 4 * 1024 * 1024;
  const reader = response.body?.getReader(); if (!reader) fail('MCP', '响应没有正文。');
  const decoder = new TextDecoder(); let buffer = '', data = [];
  const sse = (response.headers.get('content-type') || '').includes('text/event-stream');
  const parse = text => { try { return JSON.parse(text); } catch { fail('MCP', '服务器返回了无效 JSON。'); } };
  const accept = value => value && value.jsonrpc === '2.0' && value.id === id && !value.method;
  const line = text => {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (!text) {
      if (!data.length) return null;
      const text = data.join('\n'); data = [];
      if (text === '[DONE]') return null;
      const value = parse(text); return accept(value) ? value : null;
    }
    if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    return null;
  };
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength; if (total > limit) fail('MCP', '响应超过 4 MiB，已停止读取。');
      buffer += decoder.decode(value, {stream: true});
      if (sse) {
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const result = line(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          if (result) return result;
        }
      }
    }
    buffer += decoder.decode();
    if (sse) {
      if (buffer) { const result = line(buffer); if (result) return result; }
      const result = line(''); if (result) return result;
    } else { const result = parse(buffer); if (accept(result)) return result; }
    fail('MCP', '没有收到与请求 ID 对应的最终响应。');
  } finally { await reader.cancel().catch(() => {}); }
}
export function findAudio(result) {
  for (const block of result?.content || []) {
    if (block.type === 'audio' && block.data) return {base64: block.data, mime: block.mimeType || 'audio/mpeg'};
    if (block.type === 'resource_link' && /^audio\//.test(block.mimeType || '') && block.uri) return {url: block.uri};
  }
  const walk = (v, depth = 0) => {
    if (depth > 7 || !v) return null;
    if (Array.isArray(v)) { for (const item of v) { const a = walk(item, depth + 1); if (a) return a; } return null; }
    if (!object(v)) return null;
    for (const key of ['audio_url', 'audioUrl', 'download_url', 'downloadUrl', 'url']) if (typeof v[key] === 'string' && /^https?:\/\//i.test(v[key])) return {url: v[key]};
    if (typeof v.audio_base64 === 'string') return {base64: v.audio_base64, mime: v.mime_type || 'audio/mpeg'};
    for (const key of ['audio', 'output', 'outputs', 'data', 'result', 'results', 'file', 'files']) {
      const a = walk(v[key], depth + 1); if (a) return a;
    }
    return null;
  };
  let found = walk(result.structuredContent); if (found) return found;
  for (const block of result?.content || []) if (block.type === 'text') {
    try { found = walk(JSON.parse(block.text)); if (found) return found; } catch {}
    const links = String(block.text || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
    const audio = links.filter(u => /\.(mp3|wav|ogg|opus|flac|m4a|aac)([?#]|$)/i.test(u));
    if (audio.length === 1) return {url: audio[0]};
  }
  return null;
}
const ALIASES = {text: ['text', 'input', 'script'], voice: ['voice_id', 'reference_id', 'voice'], language: ['language', 'language_code', 'lang'], model: ['model', 'model_id', 'model_name'], emotion: ['emotion', 'style', 'instructions']};
const clean = s => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
function fields(schema, prefix = '', depth = 0) {
  if (depth > 5) return [];
  return Object.entries(schema?.properties || {}).flatMap(([key, s]) => {
    const path = prefix ? prefix + '.' + key : key;
    return s?.properties ? fields(s, path, depth + 1) : [{key: clean(key), path}];
  });
}
export function mapFields(tool) {
  const available = fields(tool.inputSchema), out = {};
  for (const [name, aliases] of Object.entries(ALIASES)) for (const alias of aliases) {
    const match = available.filter(f => f.key === alias); if (match.length === 1) { out[name] = match[0].path; break; }
  }
  return out;
}
export function buildArguments(input, mapping, extra = {}) {
  if (!object(mapping) || !object(extra) || typeof mapping.text !== 'string' || !mapping.text) fail('配音参数', '需要文本字段映射；请参考真实工具的 inputSchema。');
  if (typeof input.text !== 'string' || !input.text.trim()) fail('配音参数', '请填写试听文字。');
  const args = clone(extra);
  const values = {...input, voice: input.voice === 'default' ? '' : input.voice};
  if (values.emotion && !mapping.emotion) values.text = `[${String(values.emotion).replace(/[\[\]\r\n]/g, ' ')}] ${values.text}`;
  for (const [name, path] of Object.entries(mapping)) {
    if (!Object.hasOwn(ALIASES, name) || typeof path !== 'string') fail('配音参数', '字段映射无效。');
    const value = values[name]; if (value === undefined || value === '' || !path) continue;
    const parts = path.split('.'); if (parts.some(p => !p || ['__proto__', 'constructor', 'prototype'].includes(p))) fail('配音参数', '字段路径无效。');
    let at = args;
    for (const p of parts.slice(0, -1)) { if (at[p] === undefined) at[p] = {}; if (!object(at[p])) fail('配音参数', '字段映射与固定参数冲突。'); at = at[p]; }
    at[parts.at(-1)] = value;
  }
  return args; // No ASCII model filters or guessed server-side enum checks.
}
export class MobileFishClient {
  constructor({storage = globalThis.localStorage, storageKey = 'st-iphonie.fish-mobile.v1', fetcher = (...a) => globalThis.fetch(...a), cryptoAPI = globalThis.crypto, now = () => Date.now()} = {}) {
    Object.assign(this, {storage, storageKey, fetcher, cryptoAPI, now});
    let saved;
    try { const raw = storage.getItem(storageKey); if (raw) saved = JSON.parse(raw); } catch { fail('本机存储', '无法读取登录记录；没有覆盖旧记录。'); }
    if (saved && saved.version !== 1) fail('本机存储', '登录记录版本不兼容；没有覆盖旧记录。');
    this.state = saved || {version: 1, config: {...DEFAULTS}};
    this.config = {...DEFAULTS, ...this.state.config}; this.resetMcp(); this.sequence = 0;
  }
  persist() {
    try { this.storage.setItem(this.storageKey, JSON.stringify(this.state)); }
    catch { fail('本机存储', '无法保存登录状态，请检查 App 网站存储。'); }
  }
  resetMcp() { this.sessionId = ''; this.protocol = ''; this.ready = false; this.catalog = null; this.lastAudio = null; }
  configure(value) {
    if (this.busy || this.refreshing) fail('配置', '请求仍在执行。');
    const next = {...DEFAULTS, ...value};
    next.endpoint = url(next.endpoint).href; next.redirectURI = url(next.redirectURI).href;
    for (const key of ['clientId', 'scope']) if (typeof next[key] !== 'string') fail('配置', 'clientId/scope 必须是文本。');
    const changed = JSON.stringify(next) !== JSON.stringify(this.config);
    if (changed) { this.state = {version: 1, config: next}; this.config = next; this.persist(); this.resetMcp(); }
  }
  status() {
    const t = this.state.tokens, p = this.state.pending;
    return {authorized: !!t?.access_token, expiresAt: t?.expiresAt || null,
      pending: !!p && p.expiresAt > this.now() && !p.attempted, connected: this.ready,
      lastGeneration: this.state.generation?.status || ''};
  }
  pendingAuthorizationUrl() {
    const p = this.state.pending;
    if (!p || p.attempted || p.expiresAt <= this.now()) return '';
    try { return makeAuthorizationLink(p.discovery, p.client.client_id, p.redirectURI, p.state, p.challenge, p.scope || ''); }
    catch { return ''; }
  }
  async exclusive(work) {
    if (this.busy) fail('操作', '已有请求正在执行，请勿重复提交。');
    this.busy = true; try { return await work(); } finally { this.busy = false; }
  }
  async request(target, init = {}, stage = '网络', timeout = 30000) {
    url(target, stage);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    if (init.signal?.aborted) { clearTimeout(timer); fail(stage, '操作已取消。', 'cancelled'); }
    init.signal?.addEventListener('abort', abort, {once: true});
    try {
      const response = await this.fetcher(target, {...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal});
      // A streamed body needs the same deadline until consumption is complete.
      return {response, done: () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }};
    } catch {
      clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
      fail(stage, controller.signal.aborted ? '请求超时或被取消；未自动重发。' : '网络请求失败。可能是 WebView CORS、DNS、TLS 或连接故障，无法仅凭此错误区分；未自动重发。', 'network_error');
    }
  }
  async json(target, init, stage) {
    const {response: r, done} = await this.request(target, init, stage);
    try {
      if (!r.ok) fail(stage, `服务返回 HTTP ${r.status}。`, `http_${r.status}`);
      const text = await r.text(); if (text.length > 4 * 1024 * 1024) fail(stage, 'JSON 响应过大。');
      try { return JSON.parse(text); } catch { fail(stage, '服务没有返回有效 JSON。'); }
    } catch (e) { if (e instanceof MobileError) throw e; fail(stage, '读取响应失败或超时；未自动重发。', 'network_error'); }
    finally { done(); }
  }
  async discover() {
    const root = url(this.config.endpoint), candidates = [];
    try {
      const {response, done} = await this.request(root.href, {headers: {Accept: 'application/json, text/event-stream'}}, '授权发现', 12000);
      try { const m = (response.headers.get('www-authenticate') || '').match(/resource_metadata\s*=\s*"([^"]+)"/i); if (m) candidates.push(url(m[1]).href); await response.body?.cancel(); } finally { done(); }
    } catch {} // A CORS-hidden challenge does not imply that well-known metadata is unavailable.
    candidates.push(root.origin + '/.well-known/oauth-protected-resource' + root.pathname.replace(/\/$/, ''), root.origin + '/.well-known/oauth-protected-resource');
    let resource, last;
    for (const candidate of new Set(candidates)) {
      try { const value = await this.json(candidate, {}, '资源元数据'); if (value.authorization_servers?.length) { resource = value; break; } }
      catch (e) { last = e; }
    }
    if (!resource) throw last || new MobileError('资源元数据', '没有找到授权服务器。');
    const resourceId = url(resource.resource || this.config.endpoint).href.replace(/\/$/, '');
    if (this.config.endpoint !== resourceId && !this.config.endpoint.startsWith(resourceId + '/')) fail('资源元数据', 'OAuth resource 与 MCP endpoint 不匹配。');
    const issuer = url(resource.authorization_servers[0]).href.replace(/\/$/, ''), i = new URL(issuer);
    const paths = [i.origin + '/.well-known/oauth-authorization-server' + i.pathname.replace(/\/$/, ''), issuer + '/.well-known/openid-configuration'];
    let metadata;
    for (const p of new Set(paths)) {
      try { const m = await this.json(p, {}, '授权服务器元数据'); if (m.authorization_endpoint && m.token_endpoint) { metadata = m; break; } } catch (e) { last = e; }
    }
    if (!metadata) throw last || new MobileError('授权服务器元数据', '缺少授权或令牌端点。');
    if (String(metadata.issuer || '').replace(/\/$/, '') !== issuer) fail('授权服务器元数据', 'issuer 不匹配。');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) if (metadata[key]) url(metadata[key]);
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) fail('PKCE', '服务未支持 S256 PKCE。');
    return {endpoint: this.config.endpoint, resource: resourceId, issuer, metadata};
  }
  async startLogin() {
    return this.exclusive(async () => {
      const discovery = await this.discover(); let client = this.state.client;
      if (!client || client.issuer !== discovery.issuer || client.redirectURI !== this.config.redirectURI || (this.config.clientId && this.config.clientId !== client.client_id)) {
        if (this.config.clientId) client = {client_id: this.config.clientId};
        else {
          if (!discovery.metadata.registration_endpoint) fail('客户端注册', '服务未提供动态注册，需要为此应用申请的 client_id。', 'registration_unavailable');
          client = await this.json(discovery.metadata.registration_endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({client_name: 'ST-iPhonie iPhone Manual OAuth', redirect_uris: [this.config.redirectURI], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'})}, '客户端注册');
        }
        if (!client.client_id || (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none')) fail('客户端注册', '服务没有接受 PKCE 公共客户端。');
        client = {client_id: client.client_id, issuer: discovery.issuer, redirectURI: this.config.redirectURI};
      }
      const p = await pkce(this.cryptoAPI);
      const loginUrl = makeAuthorizationLink(discovery, client.client_id, this.config.redirectURI, p.state, p.challenge, this.config.scope);
      this.state.client = client;
      this.state.pending = {...p, discovery, client, redirectURI: this.config.redirectURI, scope: this.config.scope, expiresAt: this.now() + 10 * 60 * 1000, attempted: false};
      this.persist(); return loginUrl; // Persist verifier/state BEFORE Safari opens or the WebView suspends.
    });
  }
  async tokenRequest(discovery, fields) {
    const t = await this.json(discovery.metadata.token_endpoint, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(fields).toString()}, '令牌交换');
    if (typeof t.access_token !== 'string' || !t.access_token || (t.token_type && t.token_type.toLowerCase() !== 'bearer')) fail('令牌交换', '未收到有效 Bearer access_token。');
    return {access_token: t.access_token, refresh_token: t.refresh_token || '', expiresAt: Number(t.expires_in) > 0 ? this.now() + Number(t.expires_in) * 1000 : null, discovery, clientId: fields.client_id};
  }
  async finishLogin(raw) {
    return this.exclusive(async () => {
      const p = this.state.pending, code = parseCallback(raw, p, this.now());
      p.attempted = true; this.persist(); // Never replay a consumed/uncertain authorization code.
      const tokens = await this.tokenRequest(p.discovery, {grant_type: 'authorization_code', client_id: p.client.client_id, code, redirect_uri: p.redirectURI, code_verifier: p.verifier, resource: p.discovery.resource});
      this.state.tokens = tokens; delete this.state.pending; delete this.state.generation;
      this.persist(); this.resetMcp(); return this.status();
    });
  }
  async accessToken() {
    const t = this.state.tokens;
    if (!t || t.discovery.endpoint !== this.config.endpoint) fail('MCP 授权', '尚未登录当前 MCP 服务。', 'login_required');
    if (!t.expiresAt || t.expiresAt > this.now() + 30000) return t.access_token;
    if (!t.refresh_token) fail('MCP 授权', '授权过期且没有刷新令牌，请重新登录。', 'login_required');
    if (!this.refreshing) this.refreshing = (async () => {
      const fresh = await this.tokenRequest(t.discovery, {grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId, resource: t.discovery.resource});
      if (!fresh.refresh_token) fresh.refresh_token = t.refresh_token;
      this.state.tokens = fresh; this.persist(); return fresh.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async rpc(method, params = {}, notification = false) {
    const token = await this.accessToken(), id = ++this.sequence;
    const headers = {Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token};
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocol) headers['MCP-Protocol-Version'] = this.protocol;
    const {response: r, done} = await this.request(this.config.endpoint, {method: 'POST', headers, body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, params})}, 'MCP ' + method, 120000);
    try {
      if (!r.ok) fail('MCP ' + method, (r.status === 401 || r.status === 403) ? await mcpHttpError(r) : `服务返回 HTTP ${r.status}；未自动重发。`, `http_${r.status}`);
      if (r.headers.get('Mcp-Session-Id')) this.sessionId = r.headers.get('Mcp-Session-Id');
      if (notification) { await r.body?.cancel(); return null; }
      const answer = await readRpc(r, id);
      if (answer.error) fail('MCP ' + method, `服务器返回 JSON-RPC 错误 ${answer.error.code}。`, 'rpc_error');
      if (!Object.hasOwn(answer, 'result')) fail('MCP', '响应缺少 result。');
      return answer.result;
    } catch (e) { if (e instanceof MobileError) throw e; fail('MCP ' + method, '读取结果失败或超时，执行结果可能未知；没有自动重发。', 'outcome_unknown'); }
    finally { done(); }
  }
  async connect() {
    if (this.ready) return;
    const r = await this.rpc('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'st-iphonie-fish-mobile', version: '0.1.0'}});
    if (typeof r.protocolVersion !== 'string') fail('MCP 握手', '缺少协议版本。');
    this.protocol = r.protocolVersion; await this.rpc('notifications/initialized', {}, true); this.ready = true;
  }
  async listTools() {
    return this.exclusive(async () => {
      await this.connect(); const all = [], seen = new Set(); let cursor;
      do {
        const r = await this.rpc('tools/list', cursor ? {cursor} : {});
        if (!Array.isArray(r.tools)) fail('工具列表', 'tools 不是数组。');
        all.push(...r.tools); cursor = r.nextCursor;
        if (cursor && seen.has(cursor)) fail('工具列表', '分页 cursor 循环。');
        if (cursor) seen.add(cursor);
        if (all.length > 10000) fail('工具列表', '工具数超过上限。');
      } while (cursor);
      this.catalog = all; return all;
    });
  }
  async generate(toolName, args) {
    return this.exclusive(async () => {
      if (!object(args)) fail('配音参数', '工具参数必须是 JSON 对象。');
      if (!this.catalog?.some(t => t.name === toolName)) fail('配音', '先读取真实工具并选择语音合成工具。');
      if (this.state.generation?.status === 'pending') fail('配音', '上一笔生成的结果未知或尚无音频，请先核对 Fish 历史记录。没有再次提交。', 'pending_generation');
      const signature = JSON.stringify({toolName, args});
      if (this.lastAudio?.signature === signature) return this.lastAudio.audio;
      await this.connect(); await this.accessToken();
      this.state.generation = {status: 'pending', at: this.now(), toolName}; this.persist();
      const result = await this.rpc('tools/call', {name: toolName, arguments: args});
      if (result.isError) { this.state.generation.status = 'error'; this.persist(); fail('配音', '语音工具报告执行失败，请查看 Fish 生成记录。', 'tool_error'); }
      const audio = findAudio(result);
      if (!audio) fail('配音', '服务器已响应但尚无音频链接（可能是异步任务）。未把提交成功当作配音成功，也未重发。', 'no_audio');
      if (audio.url) url(audio.url, '音频链接');
      this.state.generation.status = 'received'; this.persist();
      this.lastAudio = {signature, audio}; return audio;
    });
  }
  forgetPendingGeneration() { if (this.busy) fail('配音', '请求仍在执行。'); delete this.state.generation; this.persist(); }
  logout() { if (this.busy || this.refreshing) fail('退出', '请求仍在执行。'); this.state = {version: 1, config: this.config}; this.persist(); this.lastAudio = null; this.resetMcp(); }
}
export function errorText(error) { return error instanceof MobileError ? `${error.stage}：${error.message}` : '本机处理失败；请检查 App 版本和网络。未输出登录凭据。'; }
