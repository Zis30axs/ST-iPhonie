import test from 'node:test';
import assert from 'node:assert/strict';
import {speechPlan, buildSpeechArgs, validateArgs, extractAudio, fieldsOf, SpeechService} from '../src/speech.mjs';
import {audioMime} from '../src/net.mjs';
import {readRPC} from '../src/mcp.mjs';
import {setPath, BridgeError} from '../src/util.mjs';
import {TOOL, wavFixture} from './fixture.mjs';

test('Ambiguous synthesis tool selection fails closed', () => {
  assert.throws(() => speechPlan([TOOL, {...TOOL, name: 'synthesize_speech'}]), e => e.code === 'mapping_required');
});
test('Nested schema paths and local $ref support', () => {
  const tool = {name: 'tts', inputSchema: {type: 'object', $defs: {Params: {type: 'object', properties: {text: {type: 'string'}, voice_id: {type: 'string'}}, required: ['text']}}, properties: {request: {$ref: '#/$defs/Params'}}, required: ['request']}};
  const plan = speechPlan([tool]); assert.equal(plan.fields.text, 'request.text');
  assert.deepEqual(buildSpeechArgs(plan, {input: '中文', voice: '音色'}), {request: {text: '中文', voice_id: '音色'}});
});
test('Unknown required field is not guessed', () => {
  const tool = structuredClone(TOOL); tool.inputSchema.required.push('team'); tool.inputSchema.properties.team = {type: 'string'};
  assert.throws(() => buildSpeechArgs(speechPlan([tool]), {input: '测试'}), /team/);
});
test('Schema defaults and fixed extra parameters', () => {
  const tool = structuredClone(TOOL); tool.inputSchema.required.push('temperature'); tool.inputSchema.properties.temperature = {type: 'number', default: .7};
  const args = buildSpeechArgs(speechPlan([tool]), {input: '测试'}, {extra: {model: '固定中文模型'}});
  assert.equal(args.temperature, .7); assert.equal(args.model, '固定中文模型');
});
test('Unsupported requested formats and speed are rejected before calls', () => {
  const tool = structuredClone(TOOL); delete tool.inputSchema.properties.format; delete tool.inputSchema.properties.speed;
  const plan = speechPlan([tool]);
  assert.throws(() => buildSpeechArgs(plan, {input: 'text', response_format: 'mp3'}), e => e.code === 'unsupported_format');
  assert.throws(() => buildSpeechArgs(plan, {input: 'text', speed: 2}), e => e.code === 'unsupported_speed');
});
test('Emotion fallback is a performed Fish text tag', () => {
  const tool = structuredClone(TOOL); delete tool.inputSchema.properties.style;
  assert.equal(buildSpeechArgs(speechPlan([tool]), {input: '你好', emotion: '温柔'}).text, '[温柔] 你好');
});
test('Audio parser supports inline, structured URL, JSON text and explicit path', () => {
  assert.deepEqual(extractAudio({content: [{type: 'audio', data: 'aGVsbG8='}]}), {base64: 'aGVsbG8='});
  assert.deepEqual(extractAudio({structuredContent: {data: {audio_url: 'https://cdn.example.test/x'}}}), {url: 'https://cdn.example.test/x'});
  assert.deepEqual(extractAudio({content: [{type: 'text', text: '{"audio_url":"https://cdn.example.test/x"}'}]}), {url: 'https://cdn.example.test/x'});
  assert.deepEqual(extractAudio({structuredContent: {asset: {signed: 'https://cdn.example.test/download'}}}, 'asset.signed'), {url: 'https://cdn.example.test/download'});
  assert.equal(extractAudio({structuredContent: {status: 'queued', job_id: 'id'}}), null);
});
test('Audio MIME sniffing rejects HTML and JSON', () => {
  assert.equal(audioMime(wavFixture()), 'audio/wav');
  assert.throws(() => audioMime(Buffer.from('<html>login</html>')), e => e.code === 'invalid_audio');
  assert.throws(() => audioMime(Buffer.from('{"status":"ok"}')), e => e.code === 'invalid_audio');
});
test('Prototype pollution mappings are rejected', () => {
  assert.throws(() => setPath({}, '__proto__.polluted', true), e => e.code === 'invalid_mapping'); assert.equal({}.polluted, undefined);
});
test('JSON-RPC ID mismatch rejected', async () => {
  await assert.rejects(readRPC(new Response(JSON.stringify({jsonrpc:'2.0',id:99,result:{}}), {headers:{'content-type':'application/json'}}), 1), e => e.code === 'mcp_id_mismatch');
});
test('SSE handles split UTF-8 and CRLF and ignores notifications', async () => {
  const bytes = Buffer.from(': hi\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"text":"中文边界"}}\r\n\r\n');
  const stream = new ReadableStream({start(controller) {for (const b of bytes) controller.enqueue(Uint8Array.of(b)); controller.close();}});
  const result = await readRPC(new Response(stream,{headers:{'content-type':'text/event-stream'}}),1);
  assert.equal(result.result.text, '中文边界');
});
test('Unsupported remote schema references fail without a fetch', () => {
  assert.throws(() => fieldsOf({$ref: 'https://attacker.example/schema'}), e => e.code === 'schema_unsupported');
});
test('Schema numeric and array bounds', () => {
  assert.throws(() => validateArgs(5, {type:'number',maximum:4}), e => e.code === 'invalid_tool_arguments');
  assert.throws(() => validateArgs([], {type:'array',minItems:1}), e => e.code === 'invalid_tool_arguments');
});

for (const [name, failure] of [
  ['network disconnect', new TypeError('fixture network disconnect')],
  ['timeout', new DOMException('fixture timeout', 'TimeoutError')],
  ['incomplete MCP response', new BridgeError('fixture incomplete response', 502, 'incomplete_mcp_response')],
  ['invalid MCP response', new BridgeError('fixture invalid response', 502, 'invalid_mcp_response')],
  ['upstream HTTP 500', new BridgeError('fixture server failure', 502, 'mcp_http_500')],
]) test('Unknown paid outcome blocks a later identical submission after ' + name, async () => {
  let calls = 0;
  const service = new SpeechService({tools: async () => [TOOL], call: async () => {
    calls++; if (calls === 1) throw failure;
    return {content: [{type: 'audio', data: wavFixture().toString('base64')}]};
  }}, {data: {config: {speech: {}}}});
  await assert.rejects(service.synthesize({input: 'one paid request'}));
  await assert.rejects(service.synthesize({input: 'one paid request'}), e => e.code === 'generation_outcome_unknown');
  assert.equal(calls, 1);
});

for (const code of ['mcp_http_403', 'mcp_http_429', 'mcp_protocol_error', 'mcp_tool_failed'])
  test('Explicit rejection permits a later user retry after ' + code, async () => {
    let calls = 0;
    const service = new SpeechService({tools: async () => [TOOL], call: async () => {
      calls++; if (calls === 1) throw new BridgeError('fixture explicit rejection', 502, code);
      return {content: [{type: 'audio', data: wavFixture().toString('base64')}]};
    }}, {data: {config: {speech: {}}}});
    await assert.rejects(service.synthesize({input: 'explicit retry'}), e => e.code === code);
    assert.equal((await service.synthesize({input: 'explicit retry'})).mime, 'audio/wav');
    assert.equal(calls, 2);
  });

test('A null tool result is retained rather than triggering another paid submission', async () => {
  let calls = 0;
  const service = new SpeechService({tools: async () => [TOOL], call: async () => { calls++; return null; }},
    {data: {config: {speech: {}}}});
  for (let n = 0; n < 2; n++) await assert.rejects(service.synthesize({input: 'null result'}), e => e.code === 'audio_not_found');
  assert.equal(calls, 1);
});
