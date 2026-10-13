// 来电 (voice calls) without DOM or network: call options, the request for each turn of a call, and the reply parser.
//
// A call is spoken: every line the contact says is written in the voice format of the active voice preset (the same
// tags as story dialogue), so it can be read aloud with the contact's own voice. Rules come from the chat preset, the
// ones used in 电话. The finished call is kept in the private chat as one message of kind 'call'.
import {parseDialogue} from './protocol.js';
import {messageLine, knowsRule} from './chat.js';
import {languageName} from './languages.js';

// perTurn: lines kept from one answer (each is read aloud one after another); a talkative contact may say a lot.
export const CALL_LIMITS = Object.freeze({lines: 80, perTurn: 10, ring: [15, 60], history: 12});

/** auto: characters call on their own every `every` story replies, at most `dailyMax` a day; ring: seconds before a missed call. */
export function defaultCalls() {
  return {auto: false, every: 12, dailyMax: 1, ring: 30};
}
const count = (value, min, max, fallback) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
export function normalizeCalls(value) {
  const base = defaultCalls();
  if (!value || typeof value !== 'object') return base;
  return {auto: value.auto === true, every: count(value.every, 1, 100, base.every), dailyMax: count(value.dailyMax, 1, 10, base.dailyMax), ring: count(value.ring, ...CALL_LIMITS.ring, base.ring)};
}

const fill = (template, values) => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), String(template));
const who = (from, user) => from === 'me' ? user : from;

/** How the call reads in a transcript (the prompt of the next turn, or the chat history). */
export function callTranscript(lines, user) {
  return lines.map(l => `${who(l.from, user)}：${l.translation || l.text}`).join('\n');
}
/** Seconds as 3:07 or 1:02:09. */
export function callClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * The request for one turn of a call.
 * mode: 'incoming' (the contact called and the user just answered), 'outgoing' (the user called and the contact just
 * picked up), 'reply' (the user said something), 'voicemail' (the user did not answer; the contact leaves a message).
 * contact: {name, persona, card, voice, language}; voiceRules: how this contact's lines are read (engine tags).
 */
export function buildCallRequest({preset, mode, contact, lines = [], history = [], story = [], user = '我', userPersona = '', voiceFormat, voiceRules = '', reason = '', lore = '', memory = '', earlier = ''}) {
  const name = contact.name, voiced = !!contact.voice && !!voiceFormat;
  const spoken = languageName(contact.language || 'zh');
  const values = {'用户': user, '对象': name, '语音格式': voiceFormat || '', '可发语音': voiced ? `${name}（${spoken}）` : '（只说中文）'};
  const rules = preset.entries.filter(e => e.enabled && e.text.trim() && e.use.includes('call')).map(e => fill(e.text, values));
  const situation = {
    incoming: `${name}给${user}打了语音电话，${user}刚刚接通。${reason ? `（打来的原因：${reason}）` : '打电话要有个理由：想${user}了、有事要说、刚发生了什么、想听听声音……按人设和最近的事情来。'}`,
    outgoing: `${user}给${name}打了语音电话，${name}刚刚接起来。${name}不知道${user}为什么打来。`,
    reply: `你们正在通话。`,
    voicemail: `${name}给${user}打了语音电话，${user}没有接。${name}要留一段语音留言。${reason ? `（打来的原因：${reason}）` : ''}`
  }[mode];
  const turn = {
    incoming: `（电话接通了。${name}先开口，说明为什么打来。）`,
    outgoing: `（电话接通了。${name}先开口，像平时接${user}的电话那样。）`,
    reply: lines.at(-1)?.from === 'me' ? `（轮到${name}说话，接着${user}刚才的话往下说。）` : `（${user}没有接话，${name}接着往下说。）`,
    voicemail: `（${name}对着语音信箱留言，长短按人设和打来的原因，一般不超过五六句。）`
  }[mode];
  const system = [
    rules.join('\n\n'),
    `【通话对象】\n- ${name}：${(contact.persona || contact.card || '').trim() || '（没有资料，按剧情里的表现来）'}`,
    lore.trim() ? `【世界书】（这些人物和这个世界的设定，写给读者看的：人设、口音、方言、说话方式按这里来；里面的秘密${name}不一定知道）\n${lore.trim()}` : '',
    userPersona.trim() ? `【${user}】（${user}自己的设定，里面可能有${name}不知道的事）\n${userPersona.trim()}` : '',
    earlier.trim() ? `【更早的剧情】（记忆插件整理的长期剧情，旁观的记录：${name}只经历了其中一部分）\n${earlier.trim()}` : '',
    story.length ? `【最近的剧情】（旁观的记录：读者看得到全部，${name}只经历了其中一部分）\n${story.map(s => `${s.name}：${s.text}`).join('\n')}` : '',
    memory.trim(),
    story.length || earlier.trim() ? knowsRule([name], user) : '',
    history.length ? `【${name}和${user}最近的手机聊天】\n${history.map(m => messageLine(m, user)).filter(Boolean).join('\n')}` : '',
    `【现在】\n${situation}`,
    ['【输出格式】',
      `只写${name}接下来说的话，每句单独一行；说多少按人设和情境，最多 ${CALL_LIMITS.perTurn - 1} 句${voiced ? `，整行写成：${voiceFormat}（标签里的角色写「${name}」）` : '，直接写说的话，不加名字和引号'}。`,
      voiced ? `${name}在电话里说${spoken}：标签里的原文（{文本}）是${name}真正说出口、会被念出来的话，必须用${spoken}写${spoken === '中文' ? '' : '，不要写成中文'}；引号里的{译文}是给${user}看的中文翻译。` : '',
      `不要写${user}的话，不要写动作、旁白、表情符号、时间或任何解释。`,
      mode === 'voicemail' ? '' : `${name}想挂电话时（话说完了、被叫走了、生气了），最后单独一行写「[挂断]」。通话不要太短也不要没完没了，自然就好。`,
      voiced && voiceRules ? voiceRules : ''].filter(Boolean).join('\n')
  ].filter(Boolean).join('\n\n');
  const said = lines.length ? `【通话内容】\n${callTranscript(lines, user)}\n\n` : '';
  return [{role: 'system', content: system}, {role: 'user', content: said + turn}];
}

const HANGUP = /^\s*[[【(（]\s*(挂断|挂电话|挂了|结束通话)\s*[\]】)）]\s*$/;
/**
 * The contact's lines from the model's reply: [{text, translation, emotion}] (text is what is read aloud; translation
 * is what the user reads) and whether the contact hangs up. Lines with the voice tag keep the original language.
 */
export function parseCallReply(reply, {name, user = '我', voiceFormat, voiced = false}) {
  const body = String(reply || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/```[a-z]*\n?|```/g, '');
  const out = [];
  let hangup = false;
  for (let raw of body.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (HANGUP.test(raw) || /[[【]\s*挂断\s*[\]】]/.test(raw)) { hangup = true; raw = raw.replace(/[[【]\s*(挂断|挂电话|挂了|结束通话)\s*[\]】]/g, ''); if (!raw.trim()) continue; }
    const named = raw.match(/^\s*(?:\*\*)?([^:：\n]{1,40}?)(?:\*\*)?\s*[:：]\s*(.*)$/);
    let content = raw;
    if (named && named[1].trim() === name) content = named[2];
    else if (named && [user, '我', '旁白'].includes(named[1].trim())) continue; // the user's line, written by mistake
    const voice = voiceFormat ? parseDialogue(content, voiceFormat)[0] : null;
    if (voice) {
      const translation = voice.translation.trim(), text = voice.text.trim();
      if (voiced && text) out.push({text, translation: translation || text, emotion: voice.emotion || 'calm'});
      else if (translation || text) out.push({text: translation || text, translation: translation || text, emotion: voice.emotion || 'calm'});
    } else {
      const plain = content.replace(/<[^>]+>/g, '').trim().replace(/^[「“"『](.*)[」”"』]$/s, '$1').trim();
      if (plain) out.push({text: plain.slice(0, 600), translation: plain.slice(0, 600), emotion: 'calm'});
    }
    if (out.length >= CALL_LIMITS.perTurn) break;
  }
  return {lines: out, hangup};
}

/** Short words for how a call ended, as the chat shows it. */
export function callSummary(m) {
  const mine = m.dir === 'out';
  if (m.state === 'answered') return `语音通话 ${callClock(m.duration)}`;
  if (m.state === 'missed') return mine ? '对方无人接听' : m.voicemail?.length ? '未接来电 · 有语音留言' : '未接来电';
  if (m.state === 'declined') return mine ? '对方已拒绝' : '已拒绝';
  return mine ? '已取消' : '对方已取消';
}
