// 助手 settings and local conversations. Story/model context belongs only to the host's current request;
// none of it is part of these settings or documents.
import {DEFAULT_FORMAT, isPlaceholderRole} from './protocol.js';
import {languageName} from './languages.js';

export const ASSISTANT_LIMITS = Object.freeze({messages: 500, text: 100_000, entries: 50, entryText: 20_000, title: 80, presets: 100, tavernEntries: 500});
const PRESET_IDS = ['companion'];
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'prototype', 'constructor'].includes(key);
const text = (value, max, fallback = '') => typeof value === 'string' ? value.slice(0, max) : fallback;
const entry = (id, title, value) => ({id, title, text: value, enabled: true});

export function defaultAssistant() {
  return {source: 'builtin', activePreset: 'companion', readContext: false, tavernPreset: '', tavernEntries: {}, presets: [
    {id: 'companion', name: '助手', entries: [
      entry('identity', '助手身份', '你是用户的聊天助手，可以陪用户闲聊、一起讨论想法，回答问题并提出具体建议。用自然、亲切的中文交流，按话题决定回复长短。'),
      entry('reference', '参考剧情', '用户可能提供正在创作的正文作为参考。讨论正文时区分已有内容与你的推测，指出依据；缺少上下文时坦诚说明，不假装知道。只在用户要求续写或扮演时这样做。'),
      entry('format', '语音样例格式', '只有用户要求生成语音台词或试听样例时，才使用以下规则；平时自然聊天即可。每句完整使用当前格式：{{语音格式}}。填写实际角色名、情绪、完整译文和完整原文，不保留占位符。译文与原文表达同一句话，不概括、不漏译。旁白不加语音标签。'),
      entry('speakers', '语音样例角色', '仅供用户要求语音样例时参考。可试听的已配置角色：\n{{角色列表}}\n默认语言：{{语言}}。使用列表里的实际角色名，并遵守各角色的语言。没有配置角色时，先请用户在「角色」中配置音色，不虚构一个可试听角色。'),
    ]},
  ]};
}

/** Restores old/partial settings without retaining arbitrary fields, model context, or credentials. */
export function normalizeAssistant(value) {
  const base = defaultAssistant();
  if (!record(value)) return base;
  const saved = Array.isArray(value.presets) ? value.presets : [];
  const presets = base.presets.map(preset => {
    const own = saved.find(p => record(p) && p.id === preset.id);
    if (!own) return preset;
    const seen = new Set();
    const entries = Array.isArray(own.entries) ? own.entries.slice(0, ASSISTANT_LIMITS.entries).filter(record).map((item, i) => ({
      id: text(item.id, 100).trim() || `entry-${i}`, title: text(item.title, 100, '规则'),
      text: text(item.text, ASSISTANT_LIMITS.entryText), enabled: item.enabled !== false,
    })).filter(item => !seen.has(item.id) && seen.add(item.id)) : preset.entries;
    return {id: preset.id, name: text(own.name, 80).trim() || preset.name, entries};
  });
  const tavernEntries = Object.fromEntries(Object.entries(record(value.tavernEntries) ? value.tavernEntries : {}).filter(([name, entries]) => safeKey(name) && name.length <= 200 && record(entries)).slice(0, ASSISTANT_LIMITS.presets).map(([name, entries]) => [name,
    Object.fromEntries(Object.entries(entries).filter(([id, enabled]) => safeKey(id) && id.length <= 200 && typeof enabled === 'boolean').slice(0, ASSISTANT_LIMITS.tavernEntries)),
  ]));
  return {source: value.source === 'tavern' ? 'tavern' : 'builtin', activePreset: PRESET_IDS.includes(value.activePreset) ? value.activePreset : base.activePreset,
    presets, tavernPreset: text(value.tavernPreset, 200), tavernEntries, readContext: value.readContext === true};
}

/** User edits are validated before normalizing so invalid/oversized edits are never silently lost. */
export function validateAssistantPatch(patch) {
  if (!record(patch)) throw Error('助手设置格式无效');
  const allowed = ['source', 'activePreset', 'presets', 'tavernPreset', 'tavernEntries', 'readContext'];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw Error('助手设置包含不支持的字段');
  if ('source' in patch && !['builtin', 'tavern'].includes(patch.source)) throw Error('请选择助手预设来源');
  if ('activePreset' in patch && !PRESET_IDS.includes(patch.activePreset)) throw Error('请选择有效的助手预设');
  if ('readContext' in patch && typeof patch.readContext !== 'boolean') throw Error('读取上下文开关无效');
  if ('tavernPreset' in patch && (typeof patch.tavernPreset !== 'string' || patch.tavernPreset.length > 200)) throw Error('酒馆预设名称无效');
  if ('presets' in patch) {
    if (!Array.isArray(patch.presets) || patch.presets.length > PRESET_IDS.length) throw Error('助手预设列表无效');
    const seen = new Set();
    for (const preset of patch.presets) {
      if (!record(preset) || !PRESET_IDS.includes(preset.id) || seen.has(preset.id)) throw Error('助手预设 ID 无效或重复');
      seen.add(preset.id);
      if (typeof preset.name !== 'string' || !preset.name.trim() || preset.name.length > 80) throw Error('助手预设名称无效');
      if (!Array.isArray(preset.entries) || preset.entries.length > ASSISTANT_LIMITS.entries) throw Error('助手预设条目过多或格式无效');
      const ids = new Set();
      for (const item of preset.entries) {
        if (!record(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 100 || ids.has(item.id)) throw Error('助手条目 ID 无效或重复');
        ids.add(item.id);
        if (typeof item.title !== 'string' || item.title.length > 100 || typeof item.text !== 'string' || item.text.length > ASSISTANT_LIMITS.entryText || typeof item.enabled !== 'boolean') throw Error('助手条目格式无效或内容过长');
      }
    }
  }
  if ('tavernEntries' in patch) {
    if (!record(patch.tavernEntries) || Object.keys(patch.tavernEntries).length > ASSISTANT_LIMITS.presets) throw Error('酒馆预设开关列表无效');
    for (const [name, entries] of Object.entries(patch.tavernEntries)) {
      if (!safeKey(name) || name.length > 200 || !record(entries) || Object.keys(entries).length > ASSISTANT_LIMITS.tavernEntries) throw Error('酒馆预设开关列表无效');
      if (Object.entries(entries).some(([id, enabled]) => !safeKey(id) || id.length > 200 || typeof enabled !== 'boolean')) throw Error('酒馆预设条目开关无效');
    }
  }
}

/** One ordinary assistant; optional voice instructions apply only when the user asks for a voice sample. */
export function buildAssistantPrompt(settings, {voiceRules = ''} = {}) {
  const assistant = normalizeAssistant(settings?.assistant);
  if (assistant.source !== 'builtin') return '';
  const preset = assistant.presets.find(p => p.id === assistant.activePreset);
  const language = languageName(settings?.general?.defaultLanguage);
  const format = settings?.presets?.find(p => p.id === settings.activePreset)?.format || DEFAULT_FORMAT;
  const routes = (settings?.routes || []).filter(route => typeof route?.name === 'string' && route.name.trim() && !isPlaceholderRole(route.name) &&
    (route.voice || (route.engine === 'fish' && settings?.connections?.fish?.params?.references?.length)));
  const values = {'语音格式': format, '角色列表': routes.map(route => `- ${route.name}（${languageName(route.language || settings?.general?.defaultLanguage)}）`).join('\n') || '（尚未配置可试听的角色）', '语言': language};
  const prompt = preset.entries.filter(item => item.enabled && item.text.trim()).map(item => item.text.replace(/\{\{(语音格式|角色列表|语言)\}\}/g, (_, key) => values[key])).join('\n\n');
  const voice = preset.entries.some(item => item.id === 'format' && item.enabled && item.text.trim()) && typeof voiceRules === 'string' && voiceRules.trim();
  return [prompt, voice ? `仅当用户要求生成语音台词时，遵守以下引擎规则：\n${voice}` : ''].filter(Boolean).join('\n\n');
}

export function assistantId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw Error('助手会话 ID 无效');
  return id;
}
export function assistantMessage(value, at = Date.now()) {
  if (!record(value) || !['user', 'assistant'].includes(value.role) || typeof value.text !== 'string') throw Error('助手消息格式无效');
  if (!value.text.trim()) throw Error('请先填写消息');
  if (value.text.length > ASSISTANT_LIMITS.text) throw Error('助手单条消息不能超过 100000 字符');
  return {id: crypto.randomUUID(), role: value.role, text: value.text.trim(), at};
}
export function assertAssistantThread(thread) {
  if (!thread || thread.kind !== 'assistant') throw Error('这条助手会话已经不在了');
  if (!Array.isArray(thread.messages)) throw Error('助手会话内容格式无效');
  return thread;
}
export function assistantSummary(thread) {
  assertAssistantThread(thread);
  const {messages, ...summary} = thread;
  return {...summary, messageCount: messages.length, preview: String(messages.at(-1)?.text || '').replace(/\s+/g, ' ').slice(0, 120)};
}
