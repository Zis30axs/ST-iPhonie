import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError, isObject, getPath, setPath, assertString} from './util.mjs';
import {MAX_AUDIO, audioMime, safeDownloadAudio} from './net.mjs';

const ALIASES = {
  text: ['text', 'input', 'script', 'content'], voice: ['voice_id', 'reference_id', 'voice'],
  language: ['language', 'language_code', 'lang'], model: ['model', 'model_name', 'model_id'],
  emotion: ['emotion', 'style', 'instructions'], format: ['format', 'output_format', 'response_format'], speed: ['speed', 'speaking_rate']
};
const clean = s => String(s).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
export function schemaNode(schema, root = schema, depth = 0) {
  if (depth > 12) throw new BridgeError('工具 Schema 嵌套或循环引用过深。', 502, 'schema_unsupported');
  if (!isObject(schema)) return {};
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new BridgeError('不自动下载工具 Schema 的远程引用。', 502, 'schema_unsupported');
    const parts = schema.$ref.slice(2).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    const ref = parts.reduce((x, k) => x?.[k], root);
    if (!ref) throw new BridgeError('工具 Schema 引用了不存在的定义。', 502, 'schema_unsupported');
    const {$ref, ...rest} = schema; return schemaNode({...ref, ...rest}, root, depth + 1);
  }
  const branches = schema.anyOf || schema.oneOf;
  if (branches) {
    const meaningful = branches.filter(x => x.type !== 'null');
    if (meaningful.length === 1) return schemaNode({...schema, ...meaningful[0], anyOf: undefined, oneOf: undefined}, root, depth + 1);
  }
  if (schema.allOf) {
    const merged = {...schema, properties: {...schema.properties}, required: [...(schema.required || [])], allOf: undefined};
    for (const part of schema.allOf) {
      const resolved = schemaNode(part, root, depth + 1);
      merged.properties = {...merged.properties, ...resolved.properties};
      merged.required.push(...(resolved.required || []));
      if (resolved.type) merged.type = resolved.type;
      if (resolved.additionalProperties === false) merged.additionalProperties = false;
    }
    return merged;
  }
  return schema;
}
export function fieldsOf(schema, root = schema, prefix = '', depth = 0) {
  if (depth > 4) return [];
  const resolved = schemaNode(schema, root), fields = [];
  for (const [key, raw] of Object.entries(resolved.properties || {})) {
    const s = schemaNode(raw, root), path = prefix ? `${prefix}.${key}` : key;
    if (s.properties || s.type === 'object') fields.push(...fieldsOf(s, root, path, depth + 1));
    else fields.push({path, key: clean(key), schema: s});
  }
  return fields;
}
function findField(fields, aliases) {
  for (const alias of aliases) {
    const hits = fields.filter(f => f.key === alias);
    if (hits.length === 1) return hits[0].path;
    if (hits.length > 1) return '';
  }
  return '';
}
function speechScore(tool) {
  const name = clean(tool.name);
  if (/(transcrib|recognition|clone|design|list|search|estimate|quote|status|history|delete|image|video)/.test(name)) return 0;
  if (/(text_to_speech|synthesize_speech|generate_speech|speech_generate|speech_synthesize)/.test(name)) return 100;
  if (/(^|_)tts($|_)/.test(name)) return 90;
  if (/speech/.test(name) && /(generate|synthes|create)/.test(name)) return 80;
  if (/audio/.test(name) && /(generate|synthes|create)/.test(name) && /text.to.speech/i.test(tool.description || '')) return 70;
  return 0;
}
function selectTool(tools, selected, scorer, what) {
  if (selected) {
    const tool = tools.find(t => t.name === selected);
    if (!tool) throw new BridgeError(`找不到已配置的${what}工具「${selected}」。请重新读取真实工具列表。`, 400, 'tool_not_found');
    return tool;
  }
  const ranked = tools.map(tool => ({tool, score: scorer(tool)})).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].score === ranked[1]?.score)
    throw new BridgeError(`无法唯一确定${what}工具。请在控制台查看真实 Schema，并填写工具名与字段映射。`, 409, 'mapping_required');
  return ranked[0].tool;
}
export function speechPlan(tools, profile = {}) {
  const tool = selectTool(tools, profile.tool, speechScore, '语音合成');
  if (/(image|video|transcrib|clone|delete|payment|purchase)/i.test(tool.name))
    throw new BridgeError('此适配器只允许配置语音合成，不提供图像、视频、删除或支付工具转发。', 400, 'non_speech_tool');
  const available = fieldsOf(tool.inputSchema || {}), fields = {};
  for (const [key, aliases] of Object.entries(ALIASES)) fields[key] = findField(available, aliases);
  Object.assign(fields, profile.fields || {});
  for (const path of Object.values(fields)) if (path && !available.some(f => f.path === path))
    throw new BridgeError(`参数路径「${path}」不在所选工具的 Schema 中。`, 400, 'invalid_mapping');
  if (!fields.text) throw new BridgeError('未能识别文本字段，请填写 speech.fields.text。', 409, 'mapping_required');
  return {tool, fields};
}
function setRequiredDefaults(args, rawSchema, root = rawSchema, depth = 0) {
  if (depth > 8) return;
  const schema = schemaNode(rawSchema, root);
  for (const key of schema.required || []) {
    const sub = schemaNode(schema.properties?.[key] || {}, root);
    if (args[key] === undefined && Object.hasOwn(sub, 'default')) args[key] = structuredClone(sub.default);
  }
  for (const [key, value] of Object.entries(args)) if (isObject(value) && schema.properties?.[key]) setRequiredDefaults(value, schema.properties[key], root, depth + 1);
}
export function validateArgs(value, rawSchema, path = 'arguments', root = rawSchema, depth = 0) {
  if (depth > 15) throw new BridgeError('工具 Schema 验证递归过深。', 400, 'schema_unsupported');
  const s = schemaNode(rawSchema, root);
  const fail = reason => { throw new BridgeError(`${path} ${reason}。请按实际 MCP Schema 修改映射；请求尚未提交。`, 400, 'invalid_tool_arguments'); };
  if (s.anyOf || s.oneOf) {
    let matches = 0;
    for (const variant of s.anyOf || s.oneOf) { try { validateArgs(value, variant, path, root, depth + 1); matches++; } catch {} }
    if (!matches || (s.oneOf && matches !== 1)) fail('不满足 Schema 分支');
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const matches = t => t === 'null' ? value === null : t === 'object' ? isObject(value) : t === 'array' ? Array.isArray(value)
    : t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === t;
  if (types.length && !types.some(matches)) fail('类型不符');
  if (s.enum && !s.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) fail('不在允许的枚举值内');
  if (Object.hasOwn(s, 'const') && JSON.stringify(s.const) !== JSON.stringify(value)) fail('不等于要求的固定值');
  if (typeof value === 'string') {
    const len = [...value].length;
    if (s.minLength !== undefined && len < s.minLength) fail('过短');
    if (s.maxLength !== undefined && len > s.maxLength) fail('过长');
    // Do not execute remote regex patterns (potential ReDoS). The server applies additional schema constraints.
  }
  if (typeof value === 'number') {
    if ((s.minimum !== undefined && value < s.minimum) || (s.maximum !== undefined && value > s.maximum) ||
      (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) || (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum)) fail('超出数值范围');
  }
  if (isObject(value)) {
    for (const key of s.required || []) if (value[key] === undefined) fail(`缺少必填字段 ${key}`);
    for (const [key, val] of Object.entries(value)) {
      if (s.additionalProperties === false && !Object.hasOwn(s.properties || {}, key)) fail(`含未知字段 ${key}`);
      if (s.properties?.[key]) validateArgs(val, s.properties[key], `${path}.${key}`, root, depth + 1);
    }
  }
  if (Array.isArray(value)) {
    if ((s.minItems !== undefined && value.length < s.minItems) || (s.maxItems !== undefined && value.length > s.maxItems)) fail('数组长度不符');
    if (s.items) for (const [i, item] of value.entries()) validateArgs(item, s.items, `${path}[${i}]`, root, depth + 1);
  }
}
export function buildSpeechArgs(plan, input, profile = {}) {
  let text = assertString(input.input ?? input.text, 'input/text', 16000, true);
  const voice = assertString(input.voice, 'voice', 4096).trim(), language = assertString(input.language ?? input.lang, 'language', 100);
  const model = assertString(input.model, 'model', 4096), emotion = assertString(input.emotion, 'emotion', 300);
  const format = assertString(input.response_format, 'response_format', 20);
  const speed = input.speed;
  if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < .1 || speed > 4))
    throw new BridgeError('speed 必须是 0.1 到 4 的数字。', 400, 'invalid_input');
  if (format && !['mp3', 'wav', 'ogg', 'opus', 'flac', 'aac', 'mp4'].includes(format))
    throw new BridgeError('此桥接器不转码或输出裸 PCM；请选择受支持的音频容器，或省略 response_format。', 400, 'unsupported_format');
  if (format && !plan.fields.format) throw new BridgeError('该工具未发现格式字段。省略 response_format 可保留原始音频，或手动指定映射。', 400, 'unsupported_format');
  if (speed !== undefined && speed !== 1 && !plan.fields.speed) throw new BridgeError('该工具没有可识别的语速字段。', 400, 'unsupported_speed');
  if (emotion && !plan.fields.emotion) text = `[${emotion.replace(/[\[\]\r\n]/g, ' ')}] ${text}`;
  const args = structuredClone(profile.extra || {});
  if (!isObject(args)) throw new BridgeError('speech.extra 必须是 JSON 对象。', 400, 'invalid_mapping');
  const values = {text, voice: voice === 'default' ? '' : voice, language,
    model: ['fish-mcp', 'tts-1', ''].includes(model) ? '' : model, emotion, format, speed};
  for (const [key, value] of Object.entries(values)) if (plan.fields[key] && value !== undefined && value !== '') setPath(args, plan.fields[key], value);
  setRequiredDefaults(args, plan.tool.inputSchema);
  validateArgs(args, plan.tool.inputSchema);
  return args;
}
export function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  for (const part of result?.content || []) if (part.type === 'text') {
    let text = String(part.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try { return JSON.parse(text); } catch {}
  }
  return result;
}
export function extractAudio(result, resultPath = '') {
  const payload = payloadOf(result);
  if (resultPath) return locate(getPath(payload, resultPath), 0, true);
  for (const part of result?.content || []) {
    if (part.type === 'audio' && typeof part.data === 'string') return {base64: part.data};
    if (part.type === 'resource_link' && /^audio\//.test(part.mimeType || '') && part.uri) return {url: part.uri};
    if (part.type === 'resource' && /^audio\//.test(part.resource?.mimeType || '') && part.resource.blob) return {base64: part.resource.blob};
  }
  const found = locate(payload); if (found) return found;
  for (const part of result?.content || []) if (part.type === 'text') {
    const matches = String(part.text).match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
    const audioLinks = matches.filter(x => /\.(mp3|wav|ogg|opus|flac|m4a|aac)([?#]|$)/i.test(x));
    if (audioLinks.length === 1) return {url: audioLinks[0]};
  }
  return null;
}
function locate(value, depth = 0, explicit = false) {
  if (depth > 8) return null;
  if (typeof value === 'string' && explicit) {
    if (/^https?:\/\//i.test(value)) return {url: value};
    if (/^data:audio\/[^;]+;base64,/.test(value)) return {base64: value.split(',').slice(1).join(',')};
  }
  if (Array.isArray(value)) { for (const item of value) { const found = locate(item, depth + 1, explicit); if (found) return found; } }
  if (!isObject(value)) return null;
  for (const k of ['audio_url', 'audioUrl', 'download_url', 'downloadUrl']) if (typeof value[k] === 'string') return {url: value[k]};
  if (typeof value.url === 'string' && (explicit || /\.(mp3|wav|ogg|opus|flac|m4a|aac)([?#]|$)/i.test(value.url))) return {url: value.url};
  if (typeof value.audio_base64 === 'string') return {base64: value.audio_base64};
  for (const k of ['audio', 'output', 'outputs', 'result', 'results', 'data', 'file', 'files']) if (value[k] !== undefined) {
    const found = locate(value[k], depth + 1, k === 'audio' || k === 'file'); if (found) return found;
  }
  return null;
}
function jobOf(result, profile = {}) {
  const payload = payloadOf(result);
  const status = String(payload?.status ?? payload?.data?.status ?? payload?.state ?? '').toLowerCase();
  if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(status))
    throw new BridgeError('Fish 报告生成任务失败或被取消。没有把任务提交当作生成成功。', 502, 'generation_failed');
  const id = profile.pollIdPath ? getPath(payload, profile.pollIdPath) :
    payload?.task_id ?? payload?.job_id ?? payload?.generation_id ?? payload?.data?.task_id ?? payload?.data?.job_id ??
    (['pending', 'queued', 'processing', 'running', 'in_progress'].includes(status) ? payload?.id ?? payload?.data?.id : undefined);
  return id === undefined || id === null ? null : {id};
}
export class SpeechService {
  constructor(mcp, store, {download = safeDownloadAudio, pollInterval = 1500, maxPolls = 100} = {}) {
    this.mcp = mcp; this.store = store; this.download = download; this.pollInterval = pollInterval; this.maxPolls = maxPolls;
    this.cache = new Map(); this.cacheBytes = 0; this.inflight = new Map(); this.jobs = new Map(); this.tail = Promise.resolve(); this.waiting = 0;
  }
  async plan() { return speechPlan(await this.mcp.tools(), this.store.data.config.speech); }
  async synthesize(input, signal) {
    if (!isObject(input)) throw new BridgeError('请求体必须是 JSON 对象。', 400, 'invalid_input');
    const config = structuredClone(this.store.data.config.speech);
    const plan = speechPlan(await this.mcp.tools(), config), args = buildSpeechArgs(plan, input, config);
    const hash = createHash('sha256').update(JSON.stringify({tool: plan.tool.name, args})).digest('hex');
    const cached = this.cache.get(hash);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return {...cached.audio, cached: true};
    if (this.inflight.has(hash)) return this.inflight.get(hash);
    if (this.waiting >= 20) throw new BridgeError('配音队列已满（20）。请等已有请求完成，不要批量重试。', 429, 'queue_full');
    this.waiting++;
    const task = this.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      let result = this.jobs.get(hash)?.result;
      if (!result && this.jobs.size >= 20) throw new BridgeError('已有 20 个未处理的生成任务/结果，请先处理它们，避免继续提交和扣费。', 429, 'pending_results_full');
      if (!result) { result = await this.mcp.call(plan.tool.name, args, signal); this.jobs.set(hash, {result}); }
      let audio = extractAudio(result, config.resultPath);
      if (!audio) {
        const job = jobOf(result, config);
        if (job) {
          this.jobs.set(hash, {result});
          // Never submit again while an accepted job remains unresolved, including after a timeout.
          audio = await this.poll(job, config, signal);
        }
      }
      if (!audio) throw new BridgeError('MCP 已返回，但未找到音频。请根据真实 outputSchema 设置 speech.resultPath；并未宣称生成成功。', 502, 'audio_not_found');
      let output;
      if (audio.base64) {
        const b64 = audio.base64.replace(/\s/g, '');
        if (b64.length > Math.ceil(MAX_AUDIO * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64))
          throw new BridgeError('MCP 内嵌音频过大或 Base64 无效。', 502, 'invalid_audio');
        const bytes = Buffer.from(b64, 'base64'); output = {bytes, mime: audioMime(bytes)};
      } else output = await this.download(audio.url, {signal});
      const expected = input.response_format;
      const wanted = {mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'audio/mp4', aac: 'audio/mp4'};
      if (expected && output.mime !== wanted[expected])
        throw new BridgeError('生成的实际格式与请求不符。桥接器不伪装扩展名或转码；下次省略 response_format。', 502, 'format_mismatch');
      this.jobs.delete(hash);
      if (this.cache.has(hash)) this.cacheBytes -= this.cache.get(hash).audio.bytes.length;
      this.cache.set(hash, {audio: output, at: Date.now()}); this.cacheBytes += output.bytes.length;
      while (this.cacheBytes > 64 * 1024 * 1024 || this.cache.size > 100) {
        const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).audio.bytes.length; this.cache.delete(key);
      }
      return {...output, cached: false};
    }).finally(() => { this.waiting--; this.inflight.delete(hash); });
    this.inflight.set(hash, task); this.tail = task;
    return task;
  }
  async poll(job, profile, signal) {
    const tools = await this.mcp.tools(), tool = selectTool(tools, profile.pollTool, t =>
      /^(get|check|poll)_(generation|speech|tts|task|job)(_status|_result)?$/.test(clean(t.name)) ? 80 : 0, '任务查询');
    if (!tool.annotations?.readOnlyHint && !/^(get|check|poll)_/.test(clean(tool.name)))
      throw new BridgeError('轮询工具必须声明只读或明确为 get/check/poll 查询。', 400, 'unsafe_poll_tool');
    const idField = profile.pollIdField || findField(fieldsOf(tool.inputSchema), ['task_id', 'job_id', 'generation_id', 'id']);
    if (!idField) throw new BridgeError('已提交任务，但未识别查询 ID 字段。填写 speech.pollIdField 后可继续同一请求，不会重新提交。', 409, 'mapping_required');
    const args = structuredClone(profile.pollExtra || {}); setPath(args, idField, job.id); setRequiredDefaults(args, tool.inputSchema); validateArgs(args, tool.inputSchema);
    for (let n = 0; n < this.maxPolls; n++) {
      await delay(this.pollInterval, undefined, {signal});
      const result = await this.mcp.call(tool.name, args, signal);
      const audio = extractAudio(result, profile.pollResultPath || profile.resultPath); if (audio) return audio;
      jobOf(result, profile);
    }
    throw new BridgeError('生成任务仍未给出音频。此次请求不重复提交；同一输入可继续查询。重启会丢失内存任务记录。', 504, 'generation_pending');
  }
  reset() { this.cache.clear(); this.cacheBytes = 0; this.jobs.clear(); }
  async voices(search = '') {
    const configured = this.store.data.config;
    const rows = [{id: 'default', name: 'Fish 默认音色（按语言选择）'}, ...(configured.voices || [])];
    if (!configured.voiceTool && !search) return {voices: rows, note: '默认音色和手动保存的音色。搜索时才尝试 MCP 音色查询。'};
    const tools = await this.mcp.tools();
    const tool = selectTool(tools, configured.voiceTool, t => /^(search|list|find)_(voices?|voice_models?)$/.test(clean(t.name)) ? 100 : 0, '音色查询');
    if (!tool.annotations?.readOnlyHint && !/^(search|list|find)_/.test(clean(tool.name)))
      throw new BridgeError('音色查询工具必须是只读查询。', 400, 'unsafe_voice_tool');
    const fields = fieldsOf(tool.inputSchema), query = configured.voiceFields?.query || findField(fields, ['query', 'search', 'q', 'title']);
    const args = structuredClone(configured.voiceExtra || {});
    if (query) setPath(args, query, search); setRequiredDefaults(args, tool.inputSchema); validateArgs(args, tool.inputSchema);
    const result = payloadOf(await this.mcp.call(tool.name, args));
    const list = configured.voiceResultPath ? getPath(result, configured.voiceResultPath) :
      Array.isArray(result) ? result : result?.voices ?? result?.items ?? result?.data?.items ?? result?.data ?? result?.results;
    if (!Array.isArray(list)) throw new BridgeError('音色查询结果不是列表，请配置 voiceResultPath。', 502, 'voice_list_mapping_required');
    for (const v of list.slice(0, 500)) {
      const id = typeof v === 'string' ? v : v?.voice_id ?? v?._id ?? v?.id ?? v?.model_id;
      const name = typeof v === 'string' ? v : v?.title ?? v?.name ?? id;
      if (id !== undefined && name !== undefined && !rows.some(r => r.id === String(id))) rows.push({id: String(id), name: String(name)});
    }
    return {voices: rows, note: '音色搜索通过 MCP 完成。'};
  }
}
