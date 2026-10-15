import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {safeDownloadAudio, fetchJSON} from '../src/net.mjs';
import {extractAudio} from '../src/speech.mjs';
import {FishOAuth} from '../src/oauth.mjs';
import {fixture, wavFixture} from './fixture.mjs';

const execFileAsync = promisify(execFile);
async function audioServer(t, {tls = false, host = '127.0.0.1'} = {}) {
  const wav = wavFixture(), requests = [];
  const handler = (req, res) => {
    requests.push({url: req.url, headers: req.headers});
    if (req.url === '/redirect') {res.writeHead(302, {Location: '/audio.wav?redirected=1'}); res.end(); return;}
    if (req.url === '/loop') {res.writeHead(302, {Location: '/loop'}); res.end(); return;}
    if (req.url === '/json-redirect') {res.writeHead(307, {Location: '/json'}); res.end(); return;}
    if (req.url === '/json') {res.writeHead(200, {'Content-Type': 'application/json'}); res.end('{"ok":true}'); return;}
    if (req.url === '/missing') {res.writeHead(404); res.end('missing'); return;}
    if (req.url === '/oversized') {res.writeHead(200, {'Content-Length': 12345678}); res.end('x'); return;}
    if (req.url === '/html') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<html>not audio</html>'); return;}
    res.writeHead(200, {'Content-Type': 'audio/wav', 'Content-Length': wav.length}); res.end(wav);
  };
  const keyPath = new URL('./fixtures/localhost-test.key', import.meta.url);
  const certPath = new URL('./fixtures/localhost-test.crt', import.meta.url);
  const server = tls ? https.createServer({key: await readFile(keyPath), cert: await readFile(certPath)}, handler) : http.createServer(handler);
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, host, resolve);});
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return {server, requests, wav, port: server.address().port, url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, certPath};
}

test('Real HTTP loopback audio download accepts a nonstandard port without flags', async t => {
  const s = await audioServer(t); const audio = await safeDownloadAudio(s.url + '/audio.wav');
  assert.deepEqual(audio.bytes, s.wav); assert.equal(audio.mime, 'audio/wav');
  assert.equal(s.requests[0].headers.authorization, undefined); assert.equal(s.requests[0].headers.cookie, undefined);
});
test('Private DNS result is used by transport rather than rejected in preflight', async t => {
  const s = await audioServer(t); let lookups = 0;
  const audio = await safeDownloadAudio(`http://audio.internal:${s.port}/audio.wav`, {resolver: async hostname => {
    assert.equal(hostname, 'audio.internal'); lookups++; return [{address: '127.0.0.1', family: 4}];
  }});
  assert.deepEqual(audio.bytes, s.wav); assert.ok(lookups >= 1);
});
test('Real HTTP LAN audio URL works', async t => {
  const ip = Object.values(networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal)?.address;
  if (!ip) return t.skip('No non-loopback IPv4 interface available');
  const s = await audioServer(t, {host: '0.0.0.0'}); const audio = await safeDownloadAudio(`http://${ip}:${s.port}/audio.wav`);
  assert.deepEqual(audio.bytes, s.wav);
});
test('Signed query string and percent-encoded audio path are preserved', async t => {
  const s = await audioServer(t); const path = '/%E9%9F%B3%E9%A2%91.wav?signature=a%2Fb%2Bc&expires=123';
  await safeDownloadAudio(s.url + path); assert.equal(s.requests[0].url, path);
});
test('HTTP redirects are followed without silently upgrading the scheme', async t => {
  const s = await audioServer(t); const audio = await safeDownloadAudio(s.url + '/redirect');
  assert.deepEqual(audio.bytes, s.wav); assert.equal(s.requests[1].url, '/audio.wav?redirected=1');
});
test('HTTPS audio on a nonstandard port works with a locally trusted test CA', async t => {
  const s = await audioServer(t, {tls: true});
  const code = `import {safeDownloadAudio} from ${JSON.stringify(new URL('../src/net.mjs', import.meta.url).href)};
    const a = await safeDownloadAudio(${JSON.stringify(s.url + '/audio.wav')}); console.log(JSON.stringify({mime:a.mime,length:a.bytes.length}));`;
  const {stdout} = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
    env: {...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(s.certPath)}, timeout: 15000
  });
  assert.deepEqual(JSON.parse(stdout), {mime: 'audio/wav', length: s.wav.length});
});
test('HTTPS certificate validation is not globally disabled', async t => {
  const s = await audioServer(t, {tls: true});
  await assert.rejects(safeDownloadAudio(s.url + '/audio.wav'), e => ['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(e.code));
});
test('HTTP audio URL extraction supports structured, explicit-path and text results', () => {
  const url = 'http://192.168.10.8:9876/audio.wav?token=example';
  assert.deepEqual(extractAudio({structuredContent: {audio_url:url}}), {url});
  assert.deepEqual(extractAudio({structuredContent: {asset:{signed:url}}}, 'asset.signed'), {url});
  assert.deepEqual(extractAudio({content: [{type:'text', text:`音频：[试听](${url})`}]}), {url});
});
test('HTTP JSON redirects reach the actual response', async t => {
  const s = await audioServer(t); const {value} = await fetchJSON(s.url + '/json-redirect'); assert.deepEqual(value, {ok:true});
});
test('A configured HTTP MCP and non-Fish OAuth hostname are not blocked', () => {
  const oauth = new FishOAuth({data:{oauth:{}}}, {endpoint:'http://mcp.internal:8099/mcp'});
  for (const url of ['http://sso.internal:1234/authorize','https://login.example:9443/token','http://[::1]:8099/register']) assert.equal(oauth.trustedURL(url).href, url);
});
test('Real local HTTP OAuth login and MCP redirects work without a test-only bypass', async t => {
  const f = await fixture(t, {mcpRedirect:true}); await f.login();
  const audio = await f.speech.synthesize({input:'HTTP MCP 重定向测试', voice:'中文音色'});
  assert.deepEqual(audio.bytes, f.wav); assert.equal(f.state.generations, 1);
});
test('Changing the configured MCP endpoint does not leak the previous endpoint token', async t => {
  const f = await fixture(t); await f.login();
  const other = new FishOAuth(f.store, {endpoint:'http://other.internal:8999/mcp'});
  await assert.rejects(other.accessToken(), e => e.code === 'login_required');
});
test('Arbitrary tavern Origins receive CORS responses but cannot bypass the bridge key', async t => {
  const f = await fixture(t);
  for (const origin of ['http://tavern.lan:9999','https://my-tavern.example','http://192.168.1.22:8080']) {
    const pre = await fetch(f.origin + '/v1/audio/speech', {method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Private-Network':'true'}});
    assert.equal(pre.status,204); assert.equal(pre.headers.get('access-control-allow-origin'),origin);
    assert.equal(pre.headers.get('access-control-allow-private-network'),'true');
    const status = await f.request('/admin/status', undefined, {Origin:origin}); assert.equal(status.status,200);
    assert.equal((await fetch(f.origin + '/admin/status',{headers:{Origin:origin}})).status,401);
  }
});
test('LAN administration works with a key; unauthenticated administration still fails', async t => {
  const ip = Object.values(networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal)?.address;
  if (!ip) return t.skip('No non-loopback IPv4 interface available');
  const f = await fixture(t, {listenHost:'0.0.0.0'}); const url = `http://${ip}:${new URL(f.origin).port}/admin/status`;
  assert.equal((await fetch(url,{headers:f.headers})).status,200); assert.equal((await fetch(url)).status,401);
});
test('Invalid audio, actual HTTP errors and bounded downloads remain errors', async t => {
  const s = await audioServer(t);
  await assert.rejects(safeDownloadAudio(s.url+'/html'),e=>e.code==='invalid_audio');
  await assert.rejects(safeDownloadAudio(s.url+'/missing'),e=>e.code==='audio_download_failed');
  await assert.rejects(safeDownloadAudio(s.url+'/oversized',{maxBytes:64}),e=>e.code==='audio_too_large');
  await assert.rejects(safeDownloadAudio(s.url+'/loop'),e=>e.code==='redirect_limit');
  await assert.rejects(safeDownloadAudio('file:///tmp/not-a-network-service'),e=>e.code==='unsupported_audio_protocol');
});
