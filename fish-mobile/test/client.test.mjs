import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {MobileFishClient, inspectAuthorizationLink, pkce, parseCallback, readRpc, findAudio, mapFields, buildArguments, errorText} from '../client.js';
const mem = () => { const m = new Map(); return {getItem: k => m.get(k) || null, setItem: (k, v) => m.set(k, v)}; };
const reply = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
const config = {endpoint: 'http://127.0.0.1:8989/mcp', redirectURI: 'http://127.0.0.1:3789/oauth/callback', clientId: '', scope: ''};
const metadata = {issuer: 'http://127.0.0.1:8989', authorization_endpoint: 'http://127.0.0.1:8989/authorize', token_endpoint: 'http://127.0.0.1:8989/token', registration_endpoint: 'http://127.0.0.1:8989/register', code_challenge_methods_supported: ['S256']};
const tool = {name: 'generate_speech', inputSchema: {type: 'object', properties: {text: {type: 'string'}, voice_id: {type: 'string'}, language: {type: 'string'}, model: {type: 'string'}}}};
function harness({storage = mem(), behavior = {}, now} = {}) {
  const requests = [], catalog = [tool]; let generated = 0;
  const fetcher = async (target, init = {}) => {
    const u = new URL(target); requests.push({target, init});
    if (behavior.network) throw new TypeError('fake network error with test_secret in raw error');
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return reply({resource: config.endpoint, authorization_servers: [metadata.issuer]});
    if (u.pathname === '/.well-known/oauth-authorization-server') return reply({...metadata, ...(behavior.metadata || {})});
    if (u.pathname === '/register') return reply({client_id: 'test-client', token_endpoint_auth_method: 'none'});
    if (u.pathname === '/token') {
      if (behavior.tokenNetwork) throw new TypeError('lost response');
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'authorization_code') assert.ok(body.get('code_verifier'));
      return reply({access_token: 'test_access', refresh_token: 'test_refresh', expires_in: 3600, token_type: 'Bearer'});
    }
    if (u.pathname === '/mcp' && init.method !== 'POST') return new Response('', {status: 401});
    const request = JSON.parse(init.body); const {id, method} = request;
    assert.equal(init.headers.Authorization, 'Bearer test_access');
    if (method === 'initialize') return reply({jsonrpc: '2.0', id, result: {protocolVersion: '2025-06-18', serverInfo: {name: 'fake-fish', version: 'test'}}});
    if (method === 'notifications/initialized') return new Response(null, {status: 202});
    if (method === 'tools/list') return reply({jsonrpc: '2.0', id, result: {tools: catalog, ...(behavior.cursor ? {nextCursor: 'repeated'} : {})}});
    if (method === 'tools/call') {
      generated++;
      if (behavior.generationNetwork) throw new TypeError('unknown outcome');
      if (behavior.http429) return new Response('{}', {status: 429});
      const result = behavior.noAudio ? {structuredContent: {status: 'queued', task_id: 'test-job'}} : behavior.toolError ? {isError: true} : {structuredContent: {audio_url: 'https://cdn.example/audio.wav'}};
      return reply({jsonrpc: '2.0', id, result});
    }
    assert.fail('Unexpected request ' + target);
  };
  const c = new MobileFishClient({storage, fetcher, ...(now ? {now} : {})});
  c.configure(config);
  const login = async () => {
    const link = new URL(await c.startLogin());
    await c.finishLogin(config.redirectURI + '?code=test_code&state=' + link.searchParams.get('state'));
  };
  return {c, storage, fetcher, requests, login, behavior, generated: () => generated};
}
test('PKCE uses separate random state, verifier, and an S256 challenge', async () => {
  const x = await pkce(); assert.equal(x.verifier.length, 43); assert.equal(x.state.length, 43);
  assert.notEqual(x.state, x.verifier); assert.equal(x.challenge, createHash('sha256').update(x.verifier).digest('base64url'));
});
test('manual callback verifies exact redirect and state; rejects duplicates and expiration', () => {
  const p = {state: 'state1', redirectURI: config.redirectURI, expiresAt: 500};
  assert.equal(parseCallback(config.redirectURI + '?code=x&state=state1', p, 10), 'x');
  for (const raw of ['https://evil.test/?code=x&state=state1', config.redirectURI + '?code=x&state=bad', config.redirectURI + '?code=x&code=y&state=state1', config.redirectURI + '?code=x&state=state1&state=state1']) assert.throws(() => parseCallback(raw, p, 10));
  assert.throws(() => parseCallback(config.redirectURI + '?code=x&state=state1', p, 501));
});
test('callback survives a new client/WebView instance through persistent state', async () => {
  const h = harness(), link = new URL(await h.c.startLogin());
  const rebuilt = new MobileFishClient({storage: h.storage, fetcher: h.fetcher});
  assert.equal(rebuilt.status().pending, true);
  await rebuilt.finishLogin(config.redirectURI + '?code=x&state=' + link.searchParams.get('state'));
  assert.equal(rebuilt.status().authorized, true);
});
test('state mismatch sends no token request, valid callback is consumed once', async () => {
  const h = harness(), link = new URL(await h.c.startLogin());
  await assert.rejects(h.c.finishLogin(config.redirectURI + '?code=x&state=wrong'));
  assert.equal(h.requests.filter(r => r.target.endsWith('/token')).length, 0);
  const callback = config.redirectURI + '?code=x&state=' + link.searchParams.get('state');
  await h.c.finishLogin(callback); await assert.rejects(h.c.finishLogin(callback));
  assert.equal(h.requests.filter(r => r.target.endsWith('/token')).length, 1);
});
test('unknown token exchange outcome is never retried with the same code', async () => {
  const h = harness({behavior: {tokenNetwork: true}}), link = new URL(await h.c.startLogin());
  const raw = config.redirectURI + '?code=x&state=' + link.searchParams.get('state');
  await assert.rejects(h.c.finishLogin(raw)); await assert.rejects(h.c.finishLogin(raw));
  assert.equal(h.requests.filter(r => r.target.endsWith('/token')).length, 1);
});
test('HTTP, custom ports, and loopback endpoints are actually attempted', async () => {
  const h = harness(); await h.login(); assert.equal(h.c.status().authorized, true);
  assert.ok(h.requests.every(r => r.target.startsWith('http://127.0.0.1:8989/')));
});
test('issuer mismatch is not treated as a cosmetic network restriction', async () => {
  const h = harness({behavior: {metadata: {issuer: 'https://different.example'}}});
  await assert.rejects(h.c.startLogin(), /issuer/); assert.equal(h.requests.filter(r => r.target.endsWith('/register')).length, 0);
});
test('changing endpoint clears old authorization and audio cache', async () => {
  const h = harness(); await h.login(); h.c.lastAudio = {signature: 'x'};
  h.c.configure({...config, endpoint: 'http://other.example/mcp'});
  assert.equal(h.c.status().authorized, false); assert.equal(h.c.lastAudio, null);
});
test('expiry refreshes once for concurrent token readers', async () => {
  const h = harness(); await h.login(); h.c.state.tokens.expiresAt = 1;
  const before = h.requests.length; await Promise.all([h.c.accessToken(), h.c.accessToken()]);
  assert.equal(h.requests.slice(before).filter(r => r.target.endsWith('/token')).length, 1);
});
test('MCP handshake then tools/list perform no speech generation', async () => {
  const h = harness(); await h.login(); assert.equal((await h.c.listTools())[0].name, tool.name);
  assert.equal(h.generated(), 0); assert.equal(h.c.status().connected, true);
});
test('MCP pagination loops fail rather than returning incomplete catalogue', async () => {
  const h = harness({behavior: {cursor: true}}); await h.login(); await assert.rejects(h.c.listTools(), /cursor/);
});
test('SSE fragmented chunks, progress messages and final response without stream close', async () => {
  let cancelled = false;
  const chunks = ['data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n', 'data: {"jsonrpc":"2.0",', '"id":7,"result":{"ok":true}}\r\n\r\n'];
  const stream = new ReadableStream({start(ctrl) { chunks.forEach(s => ctrl.enqueue(new TextEncoder().encode(s))); }, cancel() { cancelled = true; }});
  const r = await readRpc(new Response(stream, {headers: {'content-type': 'text/event-stream'}}), 7);
  assert.deepEqual(r.result, {ok: true}); assert.equal(cancelled, true);
});
test('RPC rejects wrong IDs and malformed JSON', async () => {
  await assert.rejects(readRpc(reply({jsonrpc: '2.0', id: 4, result: {}}), 3));
  await assert.rejects(readRpc(new Response('not-json'), 1));
});
test('Chinese names/models and nested mappings are preserved, default voice omitted', () => {
  const mapping = mapFields(tool);
  assert.deepEqual(buildArguments({text: '你好', voice: 'default', model: '自定义中文模型', language: 'zh'}, mapping), {text: '你好', model: '自定义中文模型', language: 'zh'});
  assert.deepEqual(buildArguments({text: '你好', voice: '风堇'}, {text: 'request.text', voice: 'voice'}), {request: {text: '你好'}, voice: '风堇'});
});
test('mapping rejects prototype pollution and does not drop extra parameters', () => {
  assert.throws(() => buildArguments({text: 'x'}, {text: '__proto__.polluted'}));
  assert.deepEqual(buildArguments({text: 'x'}, {text: 'text'}, {server_new_option: true}), {server_new_option: true, text: 'x'});
});
test('audio extraction handles structured URL, text JSON, text links and inline audio', () => {
  assert.equal(findAudio({structuredContent: {data: {url: 'http://host:8080/file?sig=a'}}}).url, 'http://host:8080/file?sig=a');
  assert.equal(findAudio({content: [{type: 'text', text: '{"audio_url":"https://cdn.test/a.wav"}'}]}).url, 'https://cdn.test/a.wav');
  assert.equal(findAudio({content: [{type: 'audio', data: 'aGVsbG8=', mimeType: 'audio/wav'}]}).mime, 'audio/wav');
  assert.equal(findAudio({content: [{type: 'text', text: 'Listen: https://cdn.test/a.mp3'}]}).url, 'https://cdn.test/a.mp3');
});
test('successful repeated identical preview reuses in-memory result', async () => {
  const h = harness(); await h.login(); await h.c.listTools();
  await h.c.generate(tool.name, {text: '你好'}); await h.c.generate(tool.name, {text: '你好'});
  assert.equal(h.generated(), 1);
});
test('unknown speech outcome persists across WebView recreation and prevents automatic duplicate generation', async () => {
  const h = harness({behavior: {generationNetwork: true}}); await h.login(); await h.c.listTools();
  await assert.rejects(h.c.generate(tool.name, {text: '你好'}));
  const rebuilt = new MobileFishClient({storage: h.storage, fetcher: h.fetcher}); await rebuilt.listTools();
  await assert.rejects(rebuilt.generate(tool.name, {text: '你好'}), /上一笔/); assert.equal(h.generated(), 1);
});
test('HTTP 429 is not automatically retried', async () => {
  const h = harness({behavior: {http429: true}}); await h.login(); await h.c.listTools();
  await assert.rejects(h.c.generate(tool.name, {text: 'x'}), /429/); assert.equal(h.generated(), 1);
});
test('async task without audio is not reported as audio success', async () => {
  const h = harness({behavior: {noAudio: true}}); await h.login(); await h.c.listTools();
  await assert.rejects(h.c.generate(tool.name, {text: 'x'}), /尚无音频/); assert.equal(h.c.status().lastGeneration, 'pending');
});
test('tool error is not a successful preview', async () => {
  const h = harness({behavior: {toolError: true}}); await h.login(); await h.c.listTools();
  await assert.rejects(h.c.generate(tool.name, {text: 'x'}), /执行失败/); assert.equal(h.c.status().lastGeneration, 'error');
});
test('diagnostic error text does not echo raw network secrets', async () => {
  const h = harness({behavior: {network: true}});
  try { await h.c.startLogin(); assert.fail(); } catch (e) { assert.ok(!errorText(e).includes('test_secret')); assert.match(errorText(e), /CORS|网络/); }
});
test('storage failure does not masquerade as successful login', () => {
  const c = new MobileFishClient({storage: {getItem: () => null, setItem: () => { throw new Error('quota'); }}});
  assert.throws(() => c.configure(config), /无法保存/);
});
test('real loopback HTTP OAuth server verifies PKCE, form content type and resource', async t => {
  const requests = []; let origin, challenge;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    const body = Buffer.concat(chunks).toString(); requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    const send = x => res.end(JSON.stringify(x));
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return send({resource: origin + '/mcp', authorization_servers: [origin]});
    if (req.url === '/.well-known/oauth-authorization-server') return send({issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register'});
    if (req.url === '/register') { assert.equal(JSON.parse(body).token_endpoint_auth_method, 'none'); return send({client_id: 'real-loopback-test'}); }
    if (req.url === '/token') {
      assert.match(req.headers['content-type'], /application\/x-www-form-urlencoded/);
      const form = new URLSearchParams(body); assert.equal(form.get('resource'), origin + '/mcp');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
      return send({access_token: 'test-only-token', token_type: 'Bearer', expires_in: 3600});
    }
    res.statusCode = 401; send({error: 'test_login_required'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const c = new MobileFishClient({storage: mem()}); c.configure({...config, endpoint: origin + '/mcp'});
  const link = new URL(await c.startLogin()); challenge = link.searchParams.get('code_challenge');
  await c.finishLogin(config.redirectURI + '?code=test-real-http&state=' + link.searchParams.get('state'));
  assert.equal(c.status().authorized, true); assert.equal(requests.filter(x => x === '/token').length, 1);
});


test('OAuth URL contains one client_id, redirect_uri and PKCE challenge before opening Safari', async () => {
  const h = harness(), link = new URL(await h.c.startLogin());
  assert.equal(link.searchParams.get('client_id'), 'test-client');
  assert.equal(link.searchParams.get('redirect_uri'), config.redirectURI);
  assert.equal(link.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(link.searchParams.getAll('client_id').length, 1);
  assert.equal(link.searchParams.getAll('redirect_uri').length, 1);
  assert.equal(inspectAuthorizationLink(link.href).clientIdPresent, true);
});
test('OAuth link validation rejects omitted/duplicated fields and produces redacted diagnostics', async () => {
  const h = harness(), link = new URL(await h.c.startLogin());
  const summary = JSON.stringify(inspectAuthorizationLink(link.href));
  for (const field of ['client_id', 'redirect_uri']) {
    const missing = new URL(link.href); missing.searchParams.delete(field);
    assert.throws(() => inspectAuthorizationLink(missing.href), /缺失或重复/);
    const duplicate = new URL(link.href); duplicate.searchParams.append(field, 'evil');
    assert.throws(() => inspectAuthorizationLink(duplicate.href), /缺失或重复/);
  }
  assert.ok(!summary.includes('test-client'));
  assert.ok(!summary.includes(link.searchParams.get('state')));
  assert.throws(() => inspectAuthorizationLink(link.href, {redirectURI: 'https://wrong.example/callback'}), /不一致/);
});
test('complete OAuth URL can be recovered after Safari switch and discarded after exchange', async () => {
  const h = harness(), link = await h.c.startLogin();
  const restored = new MobileFishClient({storage: h.storage, fetcher: h.fetcher});
  assert.equal(restored.pendingAuthorizationUrl(), link);
  await restored.finishLogin(config.redirectURI + '?code=test&state=' + new URL(link).searchParams.get('state'));
  assert.equal(restored.pendingAuthorizationUrl(), '');
});
