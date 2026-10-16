import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeHost, resolveNativeHost, nativeMcpFailure} from '../native-host.js';
const host = () => ({api:{mcp:{servers:Object.fromEntries(['create','setState','refresh','remove'].map(name=>[name,async()=>{}]))}}});
test('ordinary Windows browser has no native MCP and receives an actionable reason', async()=>{
  const view={};view.parent=view;
  assert.equal(inspectNativeHost(view).tauriHost,false);
  await assert.rejects(resolveNativeHost(view),e=>e.code==='native_browser'&&/普通浏览器/.test(e.message));
});
test('same-origin iframe resolves ancestor host and calls functions on their owner',async()=>{
  const parent={__TAURITAVERN__:host()};parent.parent=parent;
  const child={parent};
  assert.equal(inspectNativeHost(child).hostLocation,'ancestor');
  assert.equal(inspectNativeHost(child).nativeMcpAvailable,true);
  assert.equal(await resolveNativeHost(child),parent.__TAURITAVERN__);
});
test('cross-origin ancestors are ignored safely',async()=>{
  const foreign=new Proxy({}, {get(){throw new DOMException('Blocked cross-origin','SecurityError');}});
  await assert.rejects(resolveNativeHost({parent:foreign}),e=>e.code==='native_browser');
});
test('awaits main readiness when host is injected after the iframe opens',async()=>{
  const parent={};parent.__TAURITAVERN_MAIN_READY__=Promise.resolve().then(()=>{parent.__TAURITAVERN__=host();});
  assert.equal(await resolveNativeHost({parent}),parent.__TAURITAVERN__);
});
test('waits for frontend injection after Tauri IPC is available',async()=>{
  const view={__TAURI_RUNNING__:true};
  setTimeout(()=>{view.__TAURITAVERN__=host();},5);
  assert.equal(await resolveNativeHost(view,{timeoutMs:200}),view.__TAURITAVERN__);
});
test('Tauri without TauriTavern does not invent an MCP plugin',async()=>{
  await assert.rejects(resolveNativeHost({__TAURI_INTERNALS__:{}},{timeoutMs:1}),e=>e.code==='native_host_missing');
});
test('old hosts report the precise missing MCP methods',async()=>{
  await assert.rejects(resolveNativeHost({__TAURITAVERN__:{api:{mcp:{servers:{create(){}}}}}}),e=>e.code==='native_mcp_unavailable'&&/servers.refresh/.test(e.message));
});
test('bootstrap rejection never exposes its message or token',async()=>{
  const view={__TAURITAVERN_MAIN_READY__:Promise.reject(Error('Bearer test-secret'))};
  await assert.rejects(resolveNativeHost(view),e=>e.code==='native_ready_failed'&&!e.message.includes('test-secret'));
});
test('stuck bootstrap is bounded without invoking native writes',async()=>{
  await assert.rejects(resolveNativeHost({__TAURITAVERN_MAIN_READY__:new Promise(()=>{})},{timeoutMs:1}),e=>e.code==='native_ready_timeout');
});
test('raw Tauri CommandError and Error.cause preserve HTTP classification only',()=>{
  for(const error of [{InternalServerError:'mcp.discovery_initialize_failed: HTTP status 403 Bearer test-secret'}, {cause:{InternalServerError:'HTTP 401 Bearer test-secret'}}, Error('HTTP status client error (403 Forbidden): Bearer test-secret'), {InternalServerError:'UnexpectedStatus { status: 403, body: "Bearer test-secret" }'}]){
    const failure=nativeMcpFailure(error,'refresh');
    assert.match(failure.code,/^http_40[13]$/);assert.equal(failure.operation,'refresh');assert.ok(!failure.message.includes('test-secret'));
  }
  assert.equal(nativeMcpFailure({InternalServerError:'mcp.discovery_initialize_failed: Insufficient scope: Bearer test-secret'},'refresh').code,'http_403');
  assert.equal(nativeMcpFailure(Error('mcp.discovery_initialize_failed: Auth required: Bearer test-secret'),'refresh').code,'http_401');
});
