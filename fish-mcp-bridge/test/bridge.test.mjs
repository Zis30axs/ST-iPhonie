import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {fixture} from './fixture.mjs';

test('HTTP end-to-end: PKCE registration, callback, MCP, Chinese IDs, audio and cache (LOCAL MOCK)', async t => {
  const f = await fixture(t); const callback = await f.login();
  assert.equal(f.state.registers, 1); assert.equal(f.state.exchanges, 1);
  assert.equal((await fetch(callback)).status, 400, 'callback replay must fail');
  const toolResponse = await f.request('/admin/tools'); assert.equal(toolResponse.status, 200);
  const tools = await toolResponse.json(); assert.equal(tools.detected.tool, 'generate_speech');
  const input = {input: '你好，中文模型与音色名称保持原样。', voice: '音色-艾玛', model: '中文模型/测试版本', language: 'zh', emotion: '轻松', response_format: 'wav'};
  const r = await f.request('/v1/audio/speech', input); assert.equal(r.status, 200, await r.clone().text());
  assert.equal(r.headers.get('content-type'), 'audio/wav'); assert.deepEqual(Buffer.from(await r.arrayBuffer()), f.wav);
  assert.equal(f.state.lastArgs.voice_id, input.voice); assert.equal(f.state.lastArgs.model, input.model); assert.equal(f.state.lastArgs.text, input.input);
  const again = await f.request('/v1/audio/speech', input); assert.equal(again.headers.get('x-bridge-cache'), 'hit'); assert.equal(f.state.generations, 1);
  const status = await (await f.request('/admin/status')).text(); assert.ok(!status.includes('fixture-access')); assert.ok(!status.includes(f.store.data.bridgeKey));
  const saved = JSON.parse(await readFile(f.store.file, 'utf8')); assert.equal(saved.oauth.tokens.access_token, f.state.token);
  if (process.platform !== 'win32') assert.equal((await stat(f.store.file)).mode & 0o777, 0o600);
});
test('Streamable HTTP SSE, notification handling and tool pagination (LOCAL MOCK)', async t => {
  const f = await fixture(t, {sse: true, pagination: true}); await f.login();
  assert.equal((await f.mcp.tools()).length, 3);
  const out = await f.speech.synthesize({input: '中文流式边界测试', voice: 'default'});
  assert.deepEqual(out.bytes, f.wav); assert.equal(f.state.lastArgs.voice_id, undefined);
});
test('Concurrent token refresh uses one rotating refresh token (LOCAL MOCK)', async t => {
  const f = await fixture(t); await f.login(); await f.store.update(s => {s.oauth.tokens.expires_at = 1;});
  const tokens = await Promise.all(Array.from({length: 12}, () => f.oauth.accessToken()));
  assert.equal(new Set(tokens).size, 1); assert.equal(f.state.refreshes, 1);
  assert.equal(f.store.data.oauth.tokens.refresh_token, 'fixture-refresh-2');
});
test('An explicit 401 refreshes once; generation happens once (LOCAL MOCK)', async t => {
  const f = await fixture(t); await f.login(); await f.mcp.tools();
  f.store.data.oauth.tokens.access_token = 'expired-fixture-token';
  const out = await f.speech.synthesize({input: '一条请求'}); assert.equal(out.mime, 'audio/wav');
  assert.equal(f.state.refreshes, 1); assert.equal(f.state.generations, 1);
});
test('Concurrent identical HTTP requests share one generation (LOCAL MOCK)', async t => {
  const f = await fixture(t); await f.login();
  const responses = await Promise.all(Array.from({length: 8}, () => f.request('/v1/audio/speech', {input: '不要重复收费'})));
  for (const r of responses) assert.equal(r.status, 200);
  assert.equal(f.state.generations, 1);
});
test('Async job polling returns audio, not the accepted-job JSON (LOCAL MOCK)', async t => {
  const f = await fixture(t, {asyncJob: true}); await f.login();
  const out = await f.speech.synthesize({input: '异步任务'});
  assert.equal(out.mime, 'audio/wav'); assert.equal(f.state.generations, 1); assert.equal(f.state.polls, 1);
});
test('Editing polling mapping resumes the accepted job without resubmission (LOCAL MOCK)', async t => {
  const f = await fixture(t, {asyncJob: true}); await f.login();
  await f.store.update(s => {s.config.speech.pollTool = 'not_a_real_tool';});
  await assert.rejects(f.speech.synthesize({input: '保存任务'}), e => e.code === 'tool_not_found');
  await f.store.update(s => {s.config.speech.pollTool = 'get_generation';});
  const out = await f.speech.synthesize({input: '保存任务'}); assert.equal(out.mime, 'audio/wav'); assert.equal(f.state.generations, 1);
});
test('Pending job timeout does not cause automatic or subsequent resubmission (LOCAL MOCK)', async t => {
  const f = await fixture(t, {asyncJob: true, neverComplete: true}); await f.login();
  for (let i = 0; i < 2; i++) await assert.rejects(f.speech.synthesize({input: '尚未完成'}), e => e.code === 'generation_pending');
  assert.equal(f.state.generations, 1); assert.equal(f.state.polls, 6);
});
for (const status of [429, 500, 503]) test(`No automatic billable retry after HTTP ${status} (LOCAL MOCK)`, async t => {
  const f = await fixture(t, {failHTTP: status}); await f.login();
  await assert.rejects(f.speech.synthesize({input: '失败不重试'}), e => e.code === `mcp_http_${status}`);
  assert.equal(f.state.generations, 1);
});
test('MCP isError is not treated as generated audio (LOCAL MOCK)', async t => {
  const f = await fixture(t, {toolError: true}); await f.login();
  await assert.rejects(f.speech.synthesize({input: '失败'}), e => e.code === 'mcp_tool_failed'); assert.equal(f.state.generations, 1);
});
test('Auth is enforced even though custom Origins and Hosts are allowed by default', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/health')).status, 200);
  assert.equal((await fetch(f.origin + '/admin/status')).status, 401);
  assert.equal((await f.request('/admin/status', undefined, {Origin: 'http://tavern.custom:9999'})).status, 200);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(f.origin + '/admin/status', {headers: {...f.headers, Host: 'bridge.custom:' + new URL(f.origin).port}}, res => {res.resume(); resolve(res.statusCode);}); req.on('error', reject);
  });
  assert.equal(hostileHostStatus, 200);
  const preflight = await fetch(f.origin + '/v1/audio/speech', {method: 'OPTIONS', headers: {Origin: 'http://localhost:8000', 'Access-Control-Request-Method': 'POST'}});
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:8000');
  assert.equal((await fetch(f.origin + '/oauth/callback?code=x&state=wrong')).status, 400);
});
test('Voice search preserves Chinese IDs and uses MCP (LOCAL MOCK)', async t => {
  const f = await fixture(t); await f.login();
  const r = await f.request('/voices?search=' + encodeURIComponent('中文')); assert.equal(r.status, 200);
  assert.equal((await r.json()).voices[1].id, '中文音色ID'); assert.equal(f.state.generations, 0);
});
test('Invalid required input and enum rejected before synthesis (LOCAL MOCK)', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await f.request('/v1/audio/speech', {input: ''})).status, 400);
  assert.equal((await f.request('/v1/audio/speech', {input: '测试', language: 'not-supported'})).status, 400);
  assert.equal(f.state.generations, 0);
});
test('Control page and static resources are functional, not token-bearing HTML', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/app.css', '/app.js']) {const r = await fetch(f.origin + path); assert.equal(r.status, 200); assert.ok(!(await r.text()).includes(f.store.data.bridgeKey));}
  const config = structuredClone(f.store.data.config); config.voices = [{id: '中文音色', name: '我的音色'}];
  assert.equal((await f.request('/admin/config', config)).status, 200);
  assert.equal(f.store.data.config.voices[0].id, '中文音色');
});
test('Oversized and incorrect Content-Type HTTP bodies fail before processing', async t => {
  const f = await fixture(t);
  const big = await f.request('/v1/audio/speech', {input: 'x'.repeat(70000)}); assert.equal(big.status, 413);
  const wrongType = await f.request('/v1/audio/speech', {input:'hi'}, {'Content-Type':'text/plain'}); assert.equal(wrongType.status, 415);
  assert.equal(f.state.generations,0);
});
