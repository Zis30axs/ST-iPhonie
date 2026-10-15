import {createHash} from 'node:crypto';
import {BridgeError, randomSecret, safeEqual} from './util.mjs';
import {fetchJSON} from './net.mjs';

export const FISH_MCP = 'https://api.fish.audio/mcp';
export class FishOAuth {
  constructor(store, {redirectURI = 'http://127.0.0.1:3789/oauth/callback', fetcher = fetch,
    endpoint = FISH_MCP, clientID = '', scope = ''} = {}) {
    this.store = store; this.redirectURI = redirectURI; this.fetcher = fetcher;
    this.endpoint = endpoint; this.clientID = clientID; this.scope = scope;
    this.pending = new Map(); this.refreshing = null;
    this.trustedURL(endpoint);
  }
  trustedURL(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new BridgeError('授权服务返回了无效地址。', 502, 'invalid_oauth_metadata'); }
    if (!['http:', 'https:'].includes(u.protocol))
      throw new BridgeError('授权地址需要 HTTP 或 HTTPS 传输。', 502, 'unsupported_oauth_protocol');
    return u;
  }
  async json(url, options = {}) {
    this.trustedURL(url);
    return fetchJSON(url, options, {fetcher: this.fetcher});
  }
  async discover() {
    const root = new URL(this.endpoint); const paths = [];
    // RFC 9728 discovery: prefer the challenge-provided location, then well-known URLs.
    try {
      const r = await this.fetcher(this.endpoint, {method: 'GET', headers: {Accept: 'application/json, text/event-stream'},
        redirect: 'follow', signal: AbortSignal.timeout(15000)});
      const challenge = r.headers.get('www-authenticate') || '';
      const found = challenge.match(/\bresource_metadata\s*=\s*"([^"]+)"/i);
      if (found) paths.push(this.trustedURL(found[1]).href);
      await r.body?.cancel();
    } catch (error) { if (error instanceof BridgeError) throw error; }
    paths.push(root.origin + '/.well-known/oauth-protected-resource' + root.pathname.replace(/\/$/, ''),
      root.origin + '/.well-known/oauth-protected-resource');
    let resourceMetadata;
    for (const path of new Set(paths)) {
      try { const {response, value} = await this.json(path); if (response.ok && Array.isArray(value.authorization_servers) && value.authorization_servers.length) { resourceMetadata = value; break; } }
      catch (error) { if (error instanceof BridgeError && error.code === 'unsupported_oauth_protocol') throw error; }
    }
    if (!resourceMetadata) throw new BridgeError('无法读取 Fish OAuth 资源元数据。检查 DNS/网络；没有把登录失败当作 API Key 问题。', 502, 'oauth_discovery_failed');
    const resource = this.trustedURL(resourceMetadata.resource || this.endpoint).href.replace(/\/$/, '');
    if (this.endpoint !== resource && !this.endpoint.startsWith(resource + '/'))
      throw new BridgeError('OAuth 资源标识与 Fish MCP 地址不匹配。', 502, 'resource_mismatch');
    const issuer = this.trustedURL(resourceMetadata.authorization_servers[0]).href.replace(/\/$/, '');
    const i = new URL(issuer); const suffix = i.pathname.replace(/\/$/, '');
    const candidates = [i.origin + '/.well-known/oauth-authorization-server' + suffix,
      issuer + '/.well-known/openid-configuration', i.origin + '/.well-known/openid-configuration' + suffix];
    let metadata;
    for (const path of new Set(candidates)) {
      try {
        const {response, value} = await this.json(path);
        if (response.ok && value.authorization_endpoint && value.token_endpoint) { metadata = value; break; }
      } catch (error) { if (error instanceof BridgeError && error.code === 'unsupported_oauth_protocol') throw error; }
    }
    if (!metadata) throw new BridgeError('Fish 授权服务器没有返回可用的元数据。', 502, 'oauth_discovery_failed');
    if (String(metadata.issuer || '').replace(/\/$/, '') !== issuer)
      throw new BridgeError('授权服务器 issuer 不匹配，已停止登录。', 502, 'issuer_mismatch');
    this.trustedURL(metadata.authorization_endpoint); this.trustedURL(metadata.token_endpoint);
    if (metadata.registration_endpoint) this.trustedURL(metadata.registration_endpoint);
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256'))
      throw new BridgeError('授权服务器没有声明支持 S256 PKCE；不会降级为不安全登录。', 502, 'pkce_unsupported');
    const discovered = {endpoint: this.endpoint, resource, issuer, metadata};
    await this.store.update(s => { s.oauth.discovery = discovered; });
    return discovered;
  }
  async client(discovery) {
    const saved = this.store.data.oauth.client;
    if (saved?.issuer === discovery.issuer && saved.redirectURI === this.redirectURI &&
      (!this.clientID || saved.client_id === this.clientID)) return saved;
    let client;
    if (this.clientID) client = {client_id: this.clientID, token_endpoint_auth_method: 'none'};
    else {
      if (!discovery.metadata.registration_endpoint)
        throw new BridgeError('授权服务器未提供动态客户端注册。需要为此适配器注册的 FISH_OAUTH_CLIENT_ID，不能借用其他应用的身份。', 503, 'client_registration_unavailable');
      const {response, value} = await this.json(discovery.metadata.registration_endpoint, {
        method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({client_name: 'ST-iPhonie Fish MCP Bridge', redirect_uris: [this.redirectURI],
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none'})
      });
      if (!response.ok || typeof value.client_id !== 'string')
        throw new BridgeError(`OAuth 客户端注册失败（HTTP ${response.status}）。未使用任何内置或他人客户端密钥。`, 502, 'client_registration_failed');
      if (value.token_endpoint_auth_method && value.token_endpoint_auth_method !== 'none')
        throw new BridgeError('此实验版只支持 PKCE 公共客户端；授权服务器要求了其他客户端认证方式。', 503, 'client_auth_unsupported');
      client = {client_id: value.client_id, token_endpoint_auth_method: 'none'};
    }
    client.issuer = discovery.issuer; client.redirectURI = this.redirectURI;
    await this.store.update(s => { s.oauth.client = client; });
    return client;
  }
  async start() {
    const discovery = await this.discover(); const client = await this.client(discovery);
    for (const [state, pending] of this.pending) if (pending.expires < Date.now()) this.pending.delete(state);
    if (this.pending.size >= 5) throw new BridgeError('已有多个授权窗口，请完成其中一个或重启适配器。', 429, 'too_many_logins');
    const state = randomSecret(), verifier = randomSecret();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, {state, verifier, client, discovery, expires: Date.now() + 10 * 60 * 1000});
    const url = this.trustedURL(discovery.metadata.authorization_endpoint);
    const args = {response_type: 'code', client_id: client.client_id, redirect_uri: this.redirectURI,
      state, code_challenge: challenge, code_challenge_method: 'S256', resource: discovery.resource};
    if (this.scope) args.scope = this.scope;
    for (const [k, v] of Object.entries(args)) url.searchParams.set(k, v);
    return url.href;
  }
  async finish(code, state, remoteError = '') {
    const pending = this.pending.get(state);
    if (!pending || !safeEqual(pending.state, state) || pending.expires < Date.now())
      throw new BridgeError('授权 state 无效、已使用或已过期，请在控制台重新开始登录。', 400, 'invalid_oauth_state');
    this.pending.delete(state); // consume before exchanging: authorization callbacks cannot be replayed
    if (remoteError) throw new BridgeError('Fish 授权被取消或拒绝。', 401, 'oauth_denied');
    if (typeof code !== 'string' || !code || code.length > 8192)
      throw new BridgeError('授权回调没有有效的 code。', 400, 'missing_oauth_code');
    const tokens = await this.tokenRequest(pending.discovery, {
      grant_type: 'authorization_code', client_id: pending.client.client_id,
      code, code_verifier: pending.verifier, redirect_uri: this.redirectURI, resource: pending.discovery.resource
    });
    await this.store.update(s => { s.oauth.tokens = tokens; });
  }
  async tokenRequest(discovery, fields) {
    const {response, value} = await this.json(discovery.metadata.token_endpoint, {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body: new URLSearchParams(fields).toString()
    });
    if (!response.ok || typeof value.access_token !== 'string' || !value.access_token) {
      const expired = value?.error === 'invalid_grant';
      if (expired) await this.store.update(s => { delete s.oauth.tokens; });
      throw new BridgeError(expired ? '授权已过期或被撤销，请重新登录 Fish。' : `获取 OAuth 令牌失败（HTTP ${response.status}）。`,
        expired ? 401 : 502, expired ? 'login_required' : 'token_exchange_failed');
    }
    if (value.token_type && value.token_type.toLowerCase() !== 'bearer')
      throw new BridgeError('授权服务器返回了不支持的令牌类型。', 502, 'token_type_unsupported');
    return {access_token: value.access_token, refresh_token: value.refresh_token || '',
      expires_at: Number(value.expires_in) > 0 ? Date.now() + Number(value.expires_in) * 1000 : null,
      scope: typeof value.scope === 'string' ? value.scope : ''};
  }
  async accessToken(force = false) {
    const tokens = this.store.data.oauth.tokens;
    // Changing the configured server must not silently reuse another server's saved login.
    const savedEndpoint = this.store.data.oauth.discovery?.endpoint || FISH_MCP;
    if (tokens && savedEndpoint !== this.endpoint)
      throw new BridgeError('MCP 地址已更换，请重新登录当前服务；旧服务令牌不会转发。', 401, 'login_required');
    if (!tokens) throw new BridgeError('尚未授权：先打开适配器控制台，登录 Fish 并选择 Plus 所在团队。', 401, 'login_required');
    if (!force && (!tokens.expires_at || tokens.expires_at > Date.now() + 30000)) return tokens.access_token;
    if (!tokens.refresh_token) throw new BridgeError('授权需要更新，但没有刷新令牌，请重新登录 Fish。', 401, 'login_required');
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const {discovery, client} = this.store.data.oauth;
        if (!discovery || !client) throw new BridgeError('缺少授权元数据，请重新登录 Fish。', 401, 'login_required');
        const fresh = await this.tokenRequest(discovery, {grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
          client_id: client.client_id, resource: discovery.resource});
        if (!fresh.refresh_token) fresh.refresh_token = tokens.refresh_token;
        await this.store.update(s => { s.oauth.tokens = fresh; });
        return fresh.access_token;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async clear() { this.pending.clear(); await this.store.update(s => { delete s.oauth.tokens; }); }
  status() { const t = this.store.data.oauth.tokens; return {authorized: !!t?.access_token, expiresAt: t?.expires_at || null, refreshAvailable: !!t?.refresh_token}; }
}
