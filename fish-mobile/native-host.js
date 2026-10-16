/** TauriTavern exposes MCP on its frontend host, not the generic Tauri plugin API. */
const METHODS = ['create', 'setState', 'refresh', 'remove'];
export class NativeMcpError extends Error {
  constructor(code, message, operation = '') { super(message); this.code = code; this.operation = operation; }
}
const missing = host => METHODS.filter(name => typeof host?.api?.mcp?.servers?.[name] !== 'function');
function context(view) {
  const seen = new Set(), candidates = []; let runtime = false;
  // Only inspect accessible ancestors; never cross an origin boundary or use opener frames.
  for (let current = view, depth = 0; current && depth < 16 && !seen.has(current); depth++) {
    seen.add(current);
    try {
      const host = current.__TAURITAVERN__;
      runtime ||= current.__TAURI_RUNNING__ === true || current.__TAURI_INTERNALS__ !== undefined || typeof current.__TAURI__?.core?.invoke === 'function';
      const ready = host?.ready ?? current.__TAURITAVERN_MAIN_READY__;
      if (host || ready != null) candidates.push({host, ready, location: depth === 0 ? 'current' : 'ancestor'});
      const parent = current.parent;
      if (!parent || parent === current) break;
      current = parent;
    } catch { break; }
  }
  return {candidate: candidates.find(c => c.host && !missing(c.host).length) || candidates.find(c => c.host) || candidates[0], runtime};
}
export function inspectNativeHost(view = globalThis) {
  const {candidate, runtime} = context(view), host = candidate?.host;
  return {tauriHost: !!host, tauriRuntime: runtime, hostLocation: candidate?.location || 'none',
    nativeMcpAvailable: !!host && !missing(host).length, hostReadySignal: candidate?.ready != null,
    missingMethods: host ? missing(host).map(name => 'servers.' + name) : []};
}
export async function resolveNativeHost(view = globalThis, {timeoutMs = 5000} = {}) {
  const deadline = Date.now() + timeoutMs;
  let found = context(view);
  // Tauri's IPC marker can precede the frontend bootstrap and its ready promise.
  while (found.runtime && !found.candidate && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    found = context(view);
  }
  const ready = found.candidate?.ready;
  if (ready != null) {
    let timer;
    try {
      await Promise.race([Promise.resolve(ready), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NativeMcpError('native_ready_timeout', 'TauriTavern 宿主初始化超时，请完整重启 App 后重试。')), Math.max(0, deadline - Date.now()));
      })]);
    } catch (error) {
      if (error instanceof NativeMcpError) throw error;
      throw new NativeMcpError('native_ready_failed', 'TauriTavern 宿主初始化失败，请检查 App 版本并完整重启。');
    } finally { clearTimeout(timer); }
  }
  const {candidate, runtime} = context(view), host = candidate?.host;
  if (!host) throw new NativeMcpError(runtime ? 'native_host_missing' : 'native_browser', runtime
    ? '检测到 Tauri 运行环境，但没有 TauriTavern 前端宿主 API。请检查 App 版本与宿主初始化。'
    : '当前页面没有 TauriTavern 宿主。Windows 普通浏览器或 Safari 不能使用原生 MCP API；请在支持 MCP 的 TauriTavern App 内打开。WebView 直连工具读取仍可单独测试。');
  if (missing(host).length) throw new NativeMcpError('native_mcp_unavailable', '当前 TauriTavern 没有完整的原生 MCP API（缺少 ' + missing(host).map(name => 'servers.' + name).join('、') + '）。请更新支持 MCP Manager 的 App 版本。');
  return host;
}
/** Keep only known error categories; host/network messages can contain Bearer headers. */
export function nativeMcpFailure(error, operation = '') {
  if (error instanceof NativeMcpError) return error;
  const texts = (value, depth = 0) => {
    if (depth > 3 || value == null) return '';
    if (typeof value === 'string') return value.slice(0, 4096);
    if (typeof value !== 'object') return '';
    return ['message', 'InternalServerError', 'BadRequest', 'ServiceUnavailable', 'cause'].map(key => texts(value[key], depth + 1)).join(' ');
  };
  const raw = texts(error);
  const reported = Number(error?.status ?? error?.statusCode);
  let status = [401,403,404,429].includes(reported) || reported >= 500 && reported <= 599 ? reported
    : Number(raw.match(/\b(?:HTTP|status(?:\s+code)?)[^\r\n]{0,70}?\b(401|403|404|429|5\d\d)\b/i)?.[1]);
  // RMCP converts WWW-Authenticate challenges into named errors without HTTP digits.
  if (!status && /\binsufficient[\s_-]*scope\b/i.test(raw)) status = 403;
  if (!status && /\bauth[\s_-]*required\b/i.test(raw)) status = 401;
  const at = {create: '注册', activate: '启用', refresh: '初始化与工具发现'}[operation] || '读取';
  const detail = status === 403 ? '原生 MCP 也返回 HTTP 403。请核对令牌 Scope、团队权限和服务端策略；此结果不能归因于浏览器 Origin。'
    : status === 401 ? '原生 MCP 返回 HTTP 401，服务端未认可当前 Access Token，请重新授权。'
    : status ? '原生 MCP 返回 HTTP ' + status + '，请检查服务状态与 MCP 地址。'
    : '原生 MCP ' + at + '失败，请检查 MCP Manager、网络和 App 兼容性。未输出宿主原始错误或登录凭据。';
  return new NativeMcpError(status ? 'http_' + status : 'native_' + (operation || 'read') + '_failed', detail, operation);
}
