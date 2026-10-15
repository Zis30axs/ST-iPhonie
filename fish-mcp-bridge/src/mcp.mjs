import {BridgeError} from './util.mjs';
import {readLimited} from './net.mjs';

const MAX_RPC = 48 * 1024 * 1024;
export async function readRPC(response, id) {
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    let obj;
    try { obj = JSON.parse((await readLimited(response, MAX_RPC)).toString('utf8')); }
    catch (e) { if (e instanceof BridgeError || e.name === 'AbortError' || e.name === 'TimeoutError') throw e; throw new BridgeError('MCP 返回了非 JSON 响应。', 502, 'invalid_mcp_response'); }
    return matching(obj, id);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError('MCP 的 SSE 响应为空。', 502, 'invalid_mcp_response');
  const decoder = new TextDecoder(); let buffer = '', total = 0;
  const take = () => {
    // Normalize CRLF only after complete delimiters arrive; split buffers may end in CR.
    let found;
    while ((found = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, found.index); buffer = buffer.slice(found.index + found[0].length);
      const data = event.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      let obj; try { obj = JSON.parse(data); } catch { throw new BridgeError('MCP SSE 事件不是有效 JSON。', 502, 'invalid_mcp_response'); }
      const result = matching(obj, id, true); if (result) return result;
    }
  };
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) { buffer += decoder.decode() + '\n\n'; const result = take(); if (result) return result; break; }
      total += value.byteLength;
      if (total > MAX_RPC) throw new BridgeError('MCP 响应过大。', 502, 'response_too_large');
      buffer += decoder.decode(value, {stream: true}); const result = take(); if (result) return result;
    }
  } finally { await reader.cancel().catch(() => {}); }
  throw new BridgeError('MCP 流在收到结果前结束；不会自动重发生成请求。', 502, 'incomplete_mcp_response');
}
function matching(obj, id, ignoreUnmatched = false) {
  const result = (Array.isArray(obj) ? obj : [obj]).find(x => x?.jsonrpc === '2.0' && x.id === id && ('result' in x || 'error' in x));
  if (!result && !ignoreUnmatched) throw new BridgeError('MCP 响应 ID 与请求不匹配。', 502, 'mcp_id_mismatch');
  return result;
}
export class McpClient {
  constructor(oauth, {fetcher = fetch, timeout = 180000} = {}) {
    this.oauth = oauth; this.fetcher = fetcher; this.timeout = timeout; this.id = 0; this.session = '';
    this.protocol = '2025-06-18'; this.ready = false; this.initializing = null; this.catalog = null;
  }
  reset() { this.ready = false; this.session = ''; this.catalog = null; }
  async raw(method, params, {notification = false, signal} = {}) {
    const id = notification ? undefined : ++this.id;
    const body = JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, ...(params === undefined ? {} : {params})});
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]) : AbortSignal.timeout(this.timeout);
    const send = async token => this.fetcher(this.oauth.endpoint, {method: 'POST', redirect: 'follow', signal: deadline,
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        ...(method !== 'initialize' ? {'MCP-Protocol-Version': this.protocol} : {}), ...(this.session ? {'Mcp-Session-Id': this.session} : {})}, body});
    let response = await send(await this.oauth.accessToken());
    // Retry only explicit unauthorized rejection, never network errors, 429, 5xx or tool failures.
    if (response.status === 401) {
      await response.body?.cancel(); response = await send(await this.oauth.accessToken(true));
    }
    if (!response.ok) {
      const status = response.status; await response.body?.cancel();
      if (status === 404) this.reset();
      throw new BridgeError(`Fish MCP 返回 HTTP ${status}${status === 404 ? '，会话已清除，请重新连接' : ''}。生成不会自动重发。`,
        status === 401 || status === 403 || status === 429 ? status : 502, `mcp_http_${status}`);
    }
    const session = response.headers.get('mcp-session-id'); if (session) this.session = session;
    if (notification) { await response.body?.cancel(); return; }
    const envelope = await readRPC(response, id);
    if (envelope.error) {
      // Do not leak upstream data/headers/tokens; display only the numeric protocol error code.
      throw new BridgeError(`MCP 协议错误（${Number(envelope.error.code) || 'unknown'}）。请检查所选工具与参数映射。`, 502, 'mcp_protocol_error');
    }
    return envelope.result;
  }
  async initialize(signal) {
    if (this.ready) return;
    if (!this.initializing) this.initializing = (async () => {
      const result = await this.raw('initialize', {protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: {name: 'st-iphonie-fish-mcp-bridge', version: '0.1.1'}}, {signal});
      if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(result?.protocolVersion))
        throw new BridgeError('服务端协商的 MCP 版本不在本实验版支持范围内。', 502, 'mcp_version_unsupported');
      this.protocol = result.protocolVersion;
      if (!result.capabilities?.tools) throw new BridgeError('此 MCP 服务未声明 tools 能力。', 502, 'mcp_tools_unavailable');
      await this.raw('notifications/initialized', undefined, {notification: true, signal});
      this.ready = true;
    })().catch(error => { this.reset(); throw error; }).finally(() => { this.initializing = null; });
    return this.initializing;
  }
  async tools(refresh = false, signal) {
    await this.initialize(signal);
    if (!refresh && this.catalog) return this.catalog;
    const tools = []; let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await this.raw('tools/list', cursor ? {cursor} : {}, {signal});
      if (!Array.isArray(result?.tools)) throw new BridgeError('MCP 工具列表格式不正确。', 502, 'invalid_tool_catalog');
      tools.push(...result.tools); cursor = result.nextCursor;
      if (!cursor) { this.catalog = tools; return tools; }
    }
    throw new BridgeError('工具列表分页过多。', 502, 'tool_pagination_limit');
  }
  async call(name, args, signal) {
    await this.initialize(signal);
    const result = await this.raw('tools/call', {name, arguments: args}, {signal});
    if (result?.isError) throw new BridgeError(`Fish 的工具「${name}」报告执行失败。未返回音频，也不会自动重复扣费。`, 502, 'mcp_tool_failed');
    return result;
  }
}
