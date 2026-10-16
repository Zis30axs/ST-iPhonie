/** Sanitize MCP 401/403 responses: report categories, never raw body or tokens. */
export async function mcpHttpError(response) {
  const status = Number(response?.status) || 0;
  let hint = '';
  try { hint = String(response.headers?.get('www-authenticate') || '').slice(0, 1500); } catch {}
  try { hint += ' ' + (await response.clone().text()).slice(0, 4096); } catch {}
  if (status === 403) {
    if (/invalid[\s_-]*origin|origin[^.\n]{0,100}(not\s+allowed|forbidden|denied|reject|mismatch|invalid)|dns\s*rebind/i.test(hint))
      return 'HTTP 403：MCP 拒绝了浏览器 Origin。可用下面的「原生 MCP 对照检查」确认；删掉 ST-iPhonie 的校验不会更改服务器 Origin 策略。';
    if (/insufficient[_\s-]*scope|scope[^.\n]{0,100}(insufficient|missing|required|invalid|denied)/i.test(hint))
      return 'HTTP 403：令牌的 OAuth Scope 不足或未获授权。请核对 Fish 团队权限及授权请求的 Scope。';
    if (/invalid[_\s-]*token|expired[_\s-]*token|token[_\s-]*expired/i.test(hint))
      return 'HTTP 403：MCP 不认可当前令牌或令牌已失效，请重新授权；不要发送 Token 给别人。';
    if (/team|organi[sz]ation|account|permission|forbidden/i.test(hint))
      return 'HTTP 403：服务端拒绝访问，可能涉及团队、账户或令牌权限。请用原生 MCP 检查以区分浏览器限制。';
    return 'HTTP 403：Fish MCP 拒绝初始化；可能是 WebView Origin 或 Token/团队权限。可执行「原生 MCP 对照检查」，不需要再次生成语音。';
  }
  if (status === 401) return 'HTTP 401：Fish MCP 尚未认可当前 Bearer Token；检查授权状态或重新登录。';
  return 'HTTP ' + status + '：Fish MCP 没有接受请求。';
}
