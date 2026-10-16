/** Explicit read-only native MCP comparison: no tools/call or billable generation. */
export async function probeNativeMcp(host, endpoint, accessToken) {
  const m = host?.api?.mcp;
  if (!m?.servers?.create || !m?.servers?.setState || !m?.servers?.refresh || !m?.servers?.remove)
    throw new Error('当前 TauriTavern 没有可用的原生 MCP API。请检查 App 版本或 MCP Manager。');
  if (typeof accessToken !== 'string' || !accessToken)
    throw new Error('尚未获得 Fish Access Token，请先完成 OAuth 登录。');
  const parsed = new URL(endpoint);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('MCP 地址需要 HTTP/HTTPS。');
  let registrationId = '';
  try {
    // The native MCP Manager temporarily stores this registration AND its Bearer header on device.
    const created = await m.servers.create({
      displayName: 'Fish iOS 临时 MCP 诊断（完成后自动删除）',
      endpoint: parsed.href,
      headers: {Authorization: 'Bearer ' + accessToken},
      protocolVersion: 'auto'
    });
    registrationId = created.id;
    if (!registrationId) throw new Error('原生 MCP 注册未返回 ID，请在 MCP Manager 检查是否有临时连接。');
    await m.servers.setState({registrationId, state: 'active'});
    const discovered = await m.servers.refresh({registrationId});
    if (!Array.isArray(discovered?.tools)) throw new Error('原生 MCP 未返回有效工具列表。');
    return {
      connection: 'native',
      serverName: typeof discovered.serverName === 'string' ? discovered.serverName : '',
      protocolVersion: typeof discovered.protocolVersion === 'string' ? discovered.protocolVersion : '',
      count: discovered.tools.length,
      toolNames: discovered.tools.map(t => t.nativeName).filter(t => typeof t === 'string'),
      diagnostics: (discovered.diagnostics || []).map(d => ({code: d.code, nativeName: d.nativeName || ''}))
    };
  } finally {
    if (registrationId) {
      try { await m.servers.remove({registrationId}); }
      catch {
        throw new Error('严重：删除临时 Fish MCP 注册失败。请立即到 TauriTavern MCP Manager 删除「Fish iOS 临时 MCP 诊断」（注册 ID：' + registrationId + '）。其 Bearer Token 可能保存在本机。');
      }
    }
  }
}
