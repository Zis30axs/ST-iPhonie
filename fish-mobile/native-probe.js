import {resolveNativeHost, NativeMcpError, nativeMcpFailure} from './native-host.js';
/** Explicit read-only native MCP comparison: no tools/call or billable generation. */
export async function probeNativeMcp(host, endpoint, accessToken) {
  host = await resolveNativeHost({__TAURITAVERN__: host});
  const m = host.api.mcp;
  if (typeof accessToken !== 'string' || !accessToken)
    throw new NativeMcpError('native_unauthorized', '尚未获得 Fish Access Token，请先完成 OAuth 登录。');
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new NativeMcpError('native_endpoint', 'MCP 地址无效。'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
    throw new NativeMcpError('native_endpoint', 'MCP 地址需要 HTTP/HTTPS，不能包含内嵌凭据或 #。');
  let registrationId = '', operation = 'create';
  try {
    // The native MCP Manager temporarily stores this registration AND its Bearer header on device.
    const created = await m.servers.create({
      displayName: 'Fish 临时 MCP 诊断（完成后自动删除）',
      endpoint: parsed.href,
      headers: {Authorization: 'Bearer ' + accessToken},
      protocolVersion: 'auto'
    });
    registrationId = typeof created?.id === 'string' ? created.id : '';
    if (!registrationId) throw new NativeMcpError('native_registration_invalid', '原生 MCP 注册未返回 ID，请在 MCP Manager 检查并删除临时连接。');
    operation = 'activate';
    await m.servers.setState({registrationId, state: 'active'});
    operation = 'refresh';
    const discovered = await m.servers.refresh({registrationId});
    if (!Array.isArray(discovered?.tools)) throw new NativeMcpError('native_tools_invalid', '原生 MCP 未返回有效工具列表。', operation);
    return {
      connection: 'native',
      serverName: typeof discovered.serverName === 'string' ? discovered.serverName : '',
      protocolVersion: typeof discovered.protocolVersion === 'string' ? discovered.protocolVersion : '',
      count: discovered.tools.length,
      toolNames: discovered.tools.map(t => t.nativeName).filter(t => typeof t === 'string'),
    };
  } catch (error) {
    throw nativeMcpFailure(error, operation);
  } finally {
    if (registrationId) {
      try { await m.servers.remove({registrationId}); }
      catch {
        throw new NativeMcpError('cleanup_failed', '严重：删除临时 Fish MCP 注册失败。请立即到 TauriTavern MCP Manager 删除「Fish 临时 MCP 诊断」。其 Bearer Token 可能保存在本机。', 'remove');
      }
    }
  }
}
