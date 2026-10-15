import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {StateStore} from '../src/state.mjs';
import {FishOAuth} from '../src/oauth.mjs';
import {McpClient} from '../src/mcp.mjs';
import {SpeechService} from '../src/speech.mjs';
import {createBridgeServer} from '../src/server.mjs';

export function wavFixture() {
  // Test-only synthetic signal. This is NOT speech and NOT a Fish-generated sample.
  const n = 800, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 1000), 44 + 2 * i);
  return b;
}
export const TOOL = {name: 'generate_speech', description: 'Generate speech from text', inputSchema: {
  type: 'object', properties: {text: {type: 'string', minLength: 1, maxLength: 20000}, voice_id: {type: 'string'},
    language: {type: 'string', enum: ['zh', 'en', 'ja']}, model: {type: 'string'}, style: {type: 'string'},
    format: {type: 'string', enum: ['wav', 'mp3']}, speed: {type: 'number', minimum: .5, maximum: 2}},
  required: ['text'], additionalProperties: false}};
const VOICE_TOOL = {name: 'search_voices', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {query: {type: 'string'}}, required: ['query'], additionalProperties: false}};
const POLL_TOOL = {name: 'get_generation', annotations: {readOnlyHint: true}, inputSchema: {type: 'object', properties: {generation_id: {type: 'string'}}, required: ['generation_id'], additionalProperties: false}};
export async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-mcp-test-'));
  const state = {registers: 0, exchanges: 0, refreshes: 0, initializations: 0, generations: 0, polls: 0,
    requests: [], expectedChallenge: '', token: 'fixture-access-1', refresh: 'fixture-refresh-1', registered: null};
  const wav = wavFixture(); let remoteOrigin;
  const sendJSON = (res, status, value, headers = {}) => {res.writeHead(status, {'Content-Type': 'application/json', ...headers}); res.end(JSON.stringify(value));};
  const remote = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, remoteOrigin);
      if (options.mcpRedirect && req.method === 'POST' && url.pathname === '/mcp') { res.writeHead(307, {Location: '/mcp-final'}); res.end(); return; }
      if (req.method === 'GET' && url.pathname === '/mcp') {
        sendJSON(res, 401, {error: 'authorization_required'}, {'WWW-Authenticate': `Bearer resource_metadata="${remoteOrigin}/.well-known/oauth-protected-resource/mcp"`}); return;
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        sendJSON(res, 200, {resource: remoteOrigin + '/mcp', authorization_servers: [remoteOrigin + '/oauth']}); return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server/oauth') {
        sendJSON(res, 200, {issuer: remoteOrigin + '/oauth', authorization_endpoint: remoteOrigin + '/authorize',
          token_endpoint: remoteOrigin + '/oauth/token', registration_endpoint: remoteOrigin + '/oauth/register', code_challenge_methods_supported: ['S256']}); return;
      }
      const chunks = []; for await (const c of req) chunks.push(c); const text = Buffer.concat(chunks).toString();
      if (url.pathname === '/oauth/register') {
        state.registered = JSON.parse(text); state.registers++;
        assert.equal(state.registered.token_endpoint_auth_method, 'none');
        sendJSON(res, 201, {client_id: 'fixture-client', token_endpoint_auth_method: 'none'}); return;
      }
      if (url.pathname === '/oauth/token') {
        const fields = new URLSearchParams(text);
        assert.equal(fields.get('resource'), remoteOrigin + '/mcp'); assert.equal(fields.get('client_id'), 'fixture-client');
        if (fields.get('grant_type') === 'authorization_code') {
          assert.equal(fields.get('code'), 'fixture-authorization-code');
          assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), state.expectedChallenge);
          assert.equal(fields.get('redirect_uri'), state.registered.redirect_uris[0]); state.exchanges++;
        } else {
          assert.equal(fields.get('grant_type'), 'refresh_token'); assert.equal(fields.get('refresh_token'), state.refresh);
          state.refreshes++; state.token = 'fixture-access-' + (state.refreshes + 1); state.refresh = 'fixture-refresh-' + (state.refreshes + 1);
        }
        sendJSON(res, 200, {access_token: state.token, refresh_token: state.refresh, expires_in: 3600, token_type: 'Bearer'}); return;
      }
      if (!['/mcp', '/mcp-final'].includes(url.pathname)) {sendJSON(res, 404, {}); return;}
      state.requests.push({headers: req.headers, body: JSON.parse(text)});
      if (req.headers.authorization !== 'Bearer ' + state.token) {sendJSON(res, 401, {error: 'expired'}); return;}
      const rpc = JSON.parse(text);
      if (options.failHTTP && rpc.method === 'tools/call' && rpc.params.name === 'generate_speech') {
        state.generations++; sendJSON(res, options.failHTTP, {error: 'fixture failure'}); return;
      }
      let result;
      if (rpc.method === 'initialize') {
        assert.equal(req.headers['mcp-session-id'], undefined); state.initializations++;
        result = {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'LOCAL TEST FIXTURE ONLY', version: '1'}};
      } else {
        assert.equal(req.headers['mcp-session-id'], 'fixture-session'); assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
        if (rpc.method === 'notifications/initialized') {res.writeHead(202); res.end(); return;}
        if (rpc.method === 'tools/list') {
          result = options.pagination && !rpc.params.cursor ? {tools: [TOOL], nextCursor: 'second'} :
            {tools: options.pagination ? [VOICE_TOOL, POLL_TOOL] : [TOOL, VOICE_TOOL, POLL_TOOL]};
        } else if (rpc.method === 'tools/call') {
          if (rpc.params.name === 'generate_speech') {
            state.generations++; state.lastArgs = rpc.params.arguments;
            if (options.asyncJob) result = {content: [{type: 'text', text: JSON.stringify({status: 'queued', generation_id: 'fixture-job'})}]};
            else if (options.toolError) result = {isError: true, content: [{type: 'text', text: 'fixture-only tool failure'}]};
            else result = {content: [{type: 'audio', mimeType: 'audio/wav', data: wav.toString('base64')}]};
          } else if (rpc.params.name === 'get_generation') {
            assert.equal(rpc.params.arguments.generation_id, 'fixture-job'); state.polls++;
            result = options.neverComplete ? {structuredContent: {status: 'processing', generation_id: 'fixture-job'}} :
              {structuredContent: {status: 'completed', audio_url: 'https://cdn.example.test/fixture.wav'}};
          } else if (rpc.params.name === 'search_voices') result = {structuredContent: {voices: [{id: '中文音色ID', name: '测试音色'}]}};
          else throw new Error('Unknown fixture tool');
        } else throw new Error('Unknown fixture method');
      }
      const envelope = {jsonrpc: '2.0', id: rpc.id, result};
      if (options.sse) {
        res.writeHead(200, {'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'fixture-session'});
        res.write(': fixture keepalive\r\n\r\n'); res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n');
        const buffer = Buffer.from('event: message\r\ndata: ' + JSON.stringify(envelope) + '\r\n\r\n');
        for (let i = 0; i < buffer.length; i += 31) res.write(buffer.subarray(i, i + 31)); res.end();
      } else sendJSON(res, 200, envelope, {'Mcp-Session-Id': 'fixture-session'});
    } catch (e) { state.failure = e; sendJSON(res, 500, {error: 'fixture_assertion_failed'}); }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve)); remoteOrigin = 'http://127.0.0.1:' + remote.address().port;
  const store = await new StateStore(dir).open();
  const oauth = new FishOAuth(store, {endpoint: remoteOrigin + '/mcp'});
  const mcp = new McpClient(oauth);
  const speech = new SpeechService(mcp, store, {pollInterval: 1, maxPolls: 3,
    download: async (url, opts) => {assert.equal(url, 'https://cdn.example.test/fixture.wav'); assert.deepEqual(Object.keys(opts), ['signal']); return {bytes: wav, mime: 'audio/wav'};}});
  const bridge = createBridgeServer({oauth, mcp, speech, store});
  await new Promise(resolve => bridge.listen(0, options.listenHost || '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + bridge.address().port; oauth.redirectURI = origin + '/oauth/callback';
  const headers = {Authorization: 'Bearer ' + store.data.bridgeKey, 'Content-Type': 'application/json'};
  const request = (path, input, moreHeaders = {}) => fetch(origin + path, {method: input === undefined ? 'GET' : 'POST',
    headers: {...headers, ...moreHeaders}, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
  async function login() {
    const loginResponse = await request('/admin/login', {}); assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
    const authURL = new URL((await loginResponse.json()).url); state.expectedChallenge = authURL.searchParams.get('code_challenge');
    assert.equal(authURL.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(oauth.redirectURI); callback.searchParams.set('state', authURL.searchParams.get('state')); callback.searchParams.set('code', 'fixture-authorization-code');
    const r = await fetch(callback); assert.equal(r.status, 200, await r.clone().text()); return callback;
  }
  t.after(async () => {
    bridge.closeAllConnections(); remote.closeAllConnections();
    await Promise.all([new Promise(r => bridge.close(r)), new Promise(r => remote.close(r))]);
    await rm(dir, {recursive: true, force: true});
    if (state.failure) throw state.failure;
  });
  return {store, oauth, mcp, speech, state, wav, origin, remoteOrigin, headers, request, login, dir};
}
