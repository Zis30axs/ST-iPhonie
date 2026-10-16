import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeNativeMcp} from '../native-probe.js';
import {mcpHttpError} from '../mcp-errors.js';
const host = (options = {}) => {
  const calls = [];
  const m = {servers: {
    async create(params) {calls.push(['create',params]);return {id:'probe-test-uuid'}},
    async setState(p) {calls.push(['setState',p])},
    async refresh(p) {
      calls.push(['refresh',p]); if(options.refreshError) throw Error('upstream HTTP 403');
      return {protocolVersion:'2025-06-18',tools:[{nativeName:'generate_speech'}],diagnostics:[]};
    },
    async remove(p) {calls.push(['remove',p]);if(options.removeError)throw Error('storage failure')}
  }};
  return {calls,host:{api:{mcp:m}}};
};
test('native discovers tools and deletes registration without leaking bearer in result',async()=>{
  const x=host(), r=await probeNativeMcp(x.host,'https://api.fish.audio/mcp','test-secret');
  assert.equal(r.count,1);
  assert.deepEqual(r.toolNames,['generate_speech']);
  assert.equal(x.calls[0][1].headers.Authorization,'Bearer test-secret');
  assert.deepEqual(x.calls.map(x=>x[0]),['create','setState','refresh','remove']);
  assert.ok(!JSON.stringify(r).includes('test-secret'));
});
test('native cleanup happens on discovery failure',async()=>{
  const x=host({refreshError:true});await assert.rejects(probeNativeMcp(x.host,'https://api.fish.audio/mcp','test'),/403/);
  assert.equal(x.calls.at(-1)[0],'remove');
});
test('native cleanup failure requires manual removal',async()=>{
  const x=host({removeError:true});await assert.rejects(probeNativeMcp(x.host,'https://api.fish.audio/mcp','test'),/立即.*删除/);
});
test('native does not write token without MCP host',async()=>{
  await assert.rejects(probeNativeMcp({},'https://api.fish.audio/mcp','test'),e=>e.code==='native_mcp_unavailable');
});
test('native waits for TauriTavern bootstrap before checking the MCP API',async()=>{
  const x=host(), pending={};
  pending.ready=Promise.resolve().then(()=>{pending.api=x.host.api;});
  const r=await probeNativeMcp(pending,'https://api.fish.audio/mcp','test-secret');
  assert.equal(r.count,1);
});
test('native refresh errors retain operation and HTTP category without raw Bearer text',async()=>{
  const x=host();x.host.api.mcp.servers.refresh=async()=>{throw Error('upstream HTTP 403 Bearer test-secret');};
  await assert.rejects(probeNativeMcp(x.host,'https://api.fish.audio/mcp','test-secret'),e=>{
    assert.equal(e.code,'http_403');assert.equal(e.operation,'refresh');assert.ok(!e.message.includes('test-secret'));return true;
  });
  assert.equal(x.calls.at(-1)[0],'remove');
});
const resp=(status,body,auth='')=>new Response(body,{status,headers:auth?{'www-authenticate':auth}:{}});
test('403 invalid Origin classification redacts raw body',async()=>{
  const msg=await mcpHttpError(resp(403,'Invalid Origin header with secret Bearer ABCDEF'));
  assert.match(msg,/Origin/); assert.ok(!msg.includes('ABCDEF'));
});
test('403 insufficient_scope classified',async()=>assert.match(await mcpHttpError(resp(403,'{"error":"insufficient_scope"}')),/Scope/));
test('unknown 403 leaves cause uncertain',async()=>{
  const msg=await mcpHttpError(resp(403,'blocked'));assert.match(msg,/可能/);
  assert.ok(!msg.includes('拒绝了浏览器 Origin'));
});
test('401 reports Bearer rejection',async()=>assert.match(await mcpHttpError(resp(401,'unauthorized')),/Bearer/));
