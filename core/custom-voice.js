// 自己的接口: a speech service the user runs or has (GPT-SoVITS, CosyVoice, IndexTTS…, or any HTTP text-to-speech),
// told by templates instead of written into the plugin. The address, the request body (JSON) and the headers say where
// each thing goes: {{text}} the line, {{lang}} its language (zh, ja, en, ko, yue…), {{emotion}} its 情绪, {{voice}} the
// voice (an ID, or a reference audio's path on the machine that runs the service), {{ref_text}} {{ref_lang}} what is
// said in the reference audio and in which language, {{key}} the key. The answer is the audio itself, or JSON with a
// link to it or the audio in base64. The voices are the user's own list (parameters.js, 自己的接口 → 音色).
import {languageCode} from './languages.js';
import {pick} from './music.js';

/** One-click formats of well-known self-hosted services: only the user's own address goes in. */
export const CUSTOM_TEMPLATES = Object.freeze([
  {id: 'gpt-sovits', name: 'GPT-SoVITS（api_v2）', example: 'http://127.0.0.1:9880',
    note: '在 GPT-SoVITS 文件夹里运行 api_v2.py（默认端口 9880）。音色的「参考音频」填参考音频在那台电脑上的路径，再填参考文本和参考语言。',
    fill: base => ({url: base + '/tts', method: 'POST', answer: 'audio', path: '', headers: '',
      body: JSON.stringify({text: '{{text}}', text_lang: '{{lang}}', ref_audio_path: '{{voice}}', prompt_text: '{{ref_text}}', prompt_lang: '{{ref_lang}}', text_split_method: 'cut5', media_type: 'wav', streaming_mode: false}, null, 2)})}
]);

const SLOT = /\{\{\s*(text|lang|emotion|voice|ref_text|ref_lang)\s*\}\}/g;
const KEY_SLOT = /\{\{\s*key\s*\}\}/g;
/** A language as the short code these services take: 日语 → ja, 粤语 → yue; '' when unknown. */
export function shortLanguage(value) {
  const raw = String(value ?? '').trim(), code = languageCode(raw).split('-')[0];
  return code || (/粤|cantonese|yue/i.test(raw) ? 'yue' : '');
}
/** What goes into the slots for a line said by a role. */
export function customValues(c, route, line) {
  const name = String(route.voice || '').trim(), row = (c.params.voices || []).find(r => String(r.name || '').trim() === name);
  const lang = shortLanguage(route.language) || 'zh';
  return {text: String(line.text || ''), lang, emotion: String(line.emotion || ''), voice: row ? String(row.voice || '').trim() || name : name,
    ref_text: row ? String(row.ref_text || '') : '', ref_lang: (row && shortLanguage(row.ref_lang)) || lang};
}
const jsonText = value => JSON.stringify(String(value)).slice(1, -1);
const fill = (template, values, as) => String(template || '').replace(SLOT, (m, key) => as(values[key] ?? ''));

/** The request for a line (the key is put in only when it is sent, so it never reaches the cache key or the preview). */
export function buildCustomRequest(c, route, line) {
  const p = c.params, url = String(p.url || '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw Error('自己的接口：先在引擎 App 里填好接口地址（http:// 或 https:// 开头）');
  const values = customValues(c, route, line), method = p.method === 'GET' ? 'GET' : 'POST', template = url + (method === 'POST' ? p.body : '');
  if (/\{\{\s*voice\s*\}\}/.test(template) && !values.voice) throw Error('请先选择角色音色');
  let body;
  if (method === 'POST' && String(p.body || '').trim()) {
    try { body = JSON.parse(fill(p.body, values, jsonText)); } catch { throw Error('自己的接口：请求体不是有效的 JSON，检查一下引号和逗号'); }
  }
  return {engine: 'custom', url: fill(url, values, encodeURIComponent), method, ...(body !== undefined ? {body} : {}), headers: String(p.headers || ''),
    answer: ['url', 'base64'].includes(p.answer) ? p.answer : 'audio', path: String(p.path || '').trim(), format: 'auto'};
}

/** fetch() arguments for a request, with the key in. */
export function customInit(request, key = '') {
  const headers = {};
  for (const line of request.headers.split('\n')) {
    const m = line.match(/^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*)$/);
    if (m) headers[m[1]] = m[2].replace(KEY_SLOT, key).trim();
  }
  if (key && !/\{\{\s*key\s*\}\}/.test(request.headers) && !Object.keys(headers).some(h => h.toLowerCase() === 'authorization')) headers.Authorization = 'Bearer ' + key;
  const init = {method: request.method, headers};
  if (request.method === 'POST' && request.body !== undefined) { init.body = JSON.stringify(request.body); if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'; }
  return {url: request.url.replace(KEY_SLOT, encodeURIComponent(key)), init};
}

/** The audio's type from its first bytes (services often say application/octet-stream). */
export function audioType(bytes, said = '') {
  const b = bytes, ascii = (at, n) => String.fromCharCode(...b.slice(at, at + n));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (b.length >= 4 && ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 4 && ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (b.length >= 3 && (ascii(0, 3) === 'ID3' || b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.length >= 8 && ascii(4, 4) === 'ftyp') return 'audio/mp4';
  return /^audio\//i.test(said) ? said.split(';')[0] : 'audio/wav';
}
function fromBase64(text) {
  const raw = String(text).replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
  let bin;
  try { bin = atob(raw); } catch { throw Error('自己的接口：回答里的 base64 音频读不出来'); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The audio from an answer. read(response) → Uint8Array (size-limited); load(url) → a Response for a link the answer
 * gave.
 */
export async function readCustomAnswer(response, request, {read, load}) {
  if (!response.ok) {
    const said = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw Error(`自己的接口回答 HTTP ${response.status}${said ? '：' + said : ''}`);
  }
  const type = response.headers.get('content-type') || '';
  if (request.answer === 'audio') {
    if (/json|text\/html/i.test(type)) throw Error('自己的接口回的不是音频（是 ' + type.split(';')[0] + '）：检查「回答是什么」');
    const bytes = await read(response);
    if (!bytes.length) throw Error('自己的接口没有回声音');
    return new Blob([bytes], {type: audioType(bytes, type)});
  }
  let json;
  try { json = JSON.parse(new TextDecoder().decode(await read(response))); } catch { throw Error('自己的接口回的不是 JSON：检查「回答是什么」'); }
  const value = request.path ? pick(json, request.path) : json;
  if (typeof value !== 'string' || !value.trim()) throw Error(`回答的「${request.path || '（没填位置）'}」里没有${request.answer === 'url' ? '音频链接' : '音频'}：检查「在 JSON 的哪里」`);
  if (request.answer === 'base64') {
    const bytes = fromBase64(value), said = value.match(/^data:([^;,]+)/)?.[1] || '';
    if (!bytes.length) throw Error('自己的接口没有回声音');
    return new Blob([bytes], {type: audioType(bytes, said)});
  }
  let link;
  try { link = new URL(value.trim(), request.url).href; } catch { throw Error('回答里的音频链接不是网址'); }
  const audio = await load(link);
  if (!audio.ok) throw Error(`音频链接打不开（HTTP ${audio.status}）`);
  const bytes = await read(audio);
  if (!bytes.length) throw Error('音频链接里没有声音');
  return new Blob([bytes], {type: audioType(bytes, audio.headers.get('content-type') || '')});
}

/** The voices of the list, for picking one for a role. */
export function customVoices(c) {
  return (c.params.voices || []).filter(r => String(r.name || '').trim()).map(r => ({id: String(r.name).trim(), name: String(r.name).trim() + (r.voice ? ' · ' + String(r.voice).split(/[\\/]/).pop().slice(0, 40) : '')}));
}
