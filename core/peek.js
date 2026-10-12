// 查手机: a look into a character's own phone — their chats with other people, what they searched for, their notes, the
// photos in their album, their shopping cart and wallpaper — made up by the model from who they are and what they know.
// No DOM or network here: the prompt, the parser and the checks on what is stored. One snapshot per character; looking
// again makes a new one.
//
// The model answers in sections, one item per line:
//   【知道】一件事                   what the owner really knows (written first so the rest keeps to it; not stored)
//   【聊天】对象                    a chat with someone; the lines under it are 「名字：内容」
//   【搜索】搜索的内容               one search
//   【备忘录】标题｜内容             one note
//   【相册】照片里拍了什么｜english tags   one photo, described (the tags only when pictures can be drawn)
//   【购物车】商品｜价格｜备注        one thing in the cart
//   【壁纸】画面｜english tags        the wallpaper, like a photo
import {messageLine} from './chat.js';

export const PEEK_LIMITS = Object.freeze({chats: 5, lines: 24, searches: 12, notes: 5, photos: 9, cart: 8, knows: 10, text: 600});

const fill = (template, values) => String(template).replace(/\{\{(.+?)\}\}/g, (m, key) => values[key.trim()] ?? m);
const clip = (value, max) => String(value ?? '').slice(0, max);
const short = value => clip(value, 30).replace(/[|｜【】]/g, '').trim();
// What the user wrote in brackets in the story is their own thoughts or a note to the model: nobody in the story heard it.
const unsaid = text => String(text).replace(/（[^（）]*）|\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The request: the preset's rules used in 查手机, the character, the world, the user, the story and the real phone chat
 * between the character and the user (their phone has that chat too, so the other chats may mention the user). The
 * story and the settings are written for the reader, who sees everything; the phone may only hold what its owner knows,
 * so the model first lists that and writes the rest from it.
 */
export function buildPeekRequest({preset, person, story = [], user = '我', userPersona = '', history = [], lore = '', images = false, memory = '', earlier = '', before = null}) {
  const name = person.name;
  const rules = preset.entries.filter(e => e.enabled && e.text.trim() && (e.use || []).includes('peek')).map(e => fill(e.text, {'用户': user, '对象': name}));
  const said = story.map(s => ({...s, text: s.name === user ? unsaid(s.text) : s.text})).filter(s => s.text);
  const drawn = what => images ? `「${what}｜英文 danbooru tag」` : `「${what}」`;
  const system = [
    rules.join('\n\n'),
    `【手机的主人】\n- ${name}：${(person.persona || person.card || '').trim() || '（没有资料，按剧情里的表现来）'}`,
    lore.trim() ? `【世界书】（这个世界和人物的设定，写给读者看的，${name}不一定都知道；人设、口音、方言、说话方式按这里来）\n${lore.trim()}` : '',
    userPersona.trim() ? `【${user}】（${user}自己的设定，里面可能有${name}不知道的事）\n${userPersona.trim()}` : '',
    earlier.trim() ? `【更早的剧情】（记忆插件整理的长期剧情，也是旁观的记录：${name}只经历了其中一部分）\n${earlier.trim()}` : '',
    said.length ? `【最近的剧情】（旁观的记录：读者看得到全部，${name}只经历了其中一部分）\n${said.map(s => `${s.name}：${s.text}`).join('\n')}` : '',
    memory.trim() ? `${memory.trim()}\n（这是${name}和${user}自己聊过的事，${name}都知道）` : '',
    before ? `【上次看到的手机】（${name}的手机里本来就有这些，现在都还在；这次不用再写）\n${peekSummary(before)}` : '',
    history.length ? `【${name}和${user}在手机上的聊天】（这是真的，${name}的手机里也有；不用再写这一段）\n${history.map(m => messageLine(m, user)).filter(Boolean).join('\n')}` : '',
    ['【' + name + '知道什么】',
      `手机是${name}自己的，里面只能有${name}知道的事：`,
      `- 能写：${name}在场亲眼看到、亲耳听到的事，${user}或别人告诉${name}的事，手机上真的聊过的内容，还有${name}自己的生活。`,
      `- 不能写：${name}不在场时发生的剧情，${user}心里想的、没说出口的话，旁白交代的秘密和真相，设定里${name}本来不知道的事。这些不能出现在聊天、搜索、备忘录、相册和购物车里，也不能让${name}碰巧猜中。`,
      `- 拿不准${name}知不知道的，就当不知道。`].join('\n'),
    ['【输出格式】',
      '分成下面几块，每一项单独一行，只能用这几种写法，不要写别的文字、编号或解释：',
      `「【知道】一件事」先写这块：${name}真正知道的、和最近剧情或${user}有关的事，3 到 8 条，只能是上面「能写」的；后面的内容只用这些事和${name}自己的生活来写；`,
      `「【聊天】对象」开始一段${name}和某人的聊天（2 到 4 段，对象是朋友、家人、同事或别的角色，不要写和${user}的），下面每行写「名字：内容」，名字只用${name}或这个对象；`,
      '「【搜索】搜索的内容」最近的搜索记录，5 到 10 条；',
      '「【备忘录】标题｜内容」备忘录，1 到 3 条；',
      images ? `${drawn('【相册】照片里拍了什么')}相册里最近的照片：先用一句中文描述画面（拍到人就写出是谁：别人写名字，${name}自己写「自拍」或和谁的合照），竖线后面写画这张图用的英文 tag（tag 里不写名字），3 到 6 张；`
        : `${drawn('【相册】照片里拍了什么')}相册里最近的照片，用一句话描述画面，3 到 6 张；`,
      `「【购物车】商品｜价格｜备注」购物车里的东西，2 到 6 件，价格只写数字（元），备注是${name}为什么想买或者买给谁，可以空着；`,
      `${drawn('【壁纸】画面')}${name}的手机壁纸，1 张，竖着的画面。`].join('\n')
  ].filter(Boolean).join('\n\n');
  const ask = before
    ? `${user}又拿到了${name}的手机。上次看过以后过了一段时间，只写从那以后新多出来的东西：【聊天】1 到 3 段，可以接着上次的对象（用同一个名字，只写新消息），也可以是新的人；【搜索】2 到 6 条新的；【备忘录】新写的或改过的（改过的用原来的标题，写改完的全文），没有就不写；【相册】新拍的 1 到 3 张；【购物车】写现在购物车里的全部东西（已经买了的不写，新想买的写上）；壁纸没换就不写【壁纸】。【知道】照常先写。`
    : `${user}拿到了${name}的手机。写出${name}手机里现在有的东西。`;
  return [{role: 'system', content: system}, {role: 'user', content: ask}];
}
/** The phone as last seen, short, for 接着上次看. */
export function peekSummary(p) {
  const out = [];
  for (const c of p.chats || []) out.push(`【聊天】${c.with}（最近几句）\n${c.lines.slice(-6).map(l => `${l.from}：${l.text}`).join('\n')}`);
  if (p.searches?.length) out.push(`【搜索】${p.searches.join('；')}`);
  for (const n of p.notes || []) out.push(`【备忘录】${n.title}｜${n.text.slice(0, 120)}`);
  if (p.photos?.length) out.push(`【相册】${p.photos.map(x => x.text).join('；')}`);
  if (p.cart?.length) out.push(`【购物车】${p.cart.map(x => x.name).join('；')}`);
  if (p.wallpaper?.text) out.push(`【壁纸】${p.wallpaper.text}`);
  return out.join('\n');
}
/**
 * 接着上次看: what is new put onto the phone as last seen. A chat with the same person goes on (its newest lines kept);
 * new searches, notes and photos come first (a note of the same title is the changed one); the cart is as it is now;
 * the wallpaper stays unless it changed. Drawn photos keep their pictures.
 */
export function mergePeek(old, found) {
  if (!old) return found;
  const chats = (old.chats || []).map(c => ({...c, lines: [...c.lines]}));
  for (const c of [...(found.chats || [])].reverse()) {
    const at = chats.findIndex(x => x.with === c.with);
    const lines = at >= 0 ? [...chats[at].lines, ...c.lines].slice(-PEEK_LIMITS.lines) : c.lines;
    if (at >= 0) chats.splice(at, 1);
    chats.unshift({with: c.with, lines});
  }
  const searches = [...new Set([...(found.searches || []), ...(old.searches || [])])].slice(0, PEEK_LIMITS.searches);
  const notes = [...(found.notes || []), ...(old.notes || []).filter(n => !(found.notes || []).some(x => x.title && x.title === n.title))].slice(0, PEEK_LIMITS.notes);
  const photos = [...(found.photos || []), ...(old.photos || [])].slice(0, PEEK_LIMITS.photos);
  return {...found, chats: chats.slice(0, PEEK_LIMITS.chats), searches, notes, photos,
    cart: found.cart?.length ? found.cart : old.cart || [], wallpaper: found.wallpaper || old.wallpaper || null};
}

const LINE = /^\s*(?:[-*•]\s*)?[【\[]\s*(聊天|搜索|搜索记录|备忘录|备忘|相册|照片|购物车|购物|壁纸|知道)\s*[】\]]\s*(.*)$/;
const SAID = /^([^:：\n]{1,30}?)\s*[:：]\s*(.+)$/;
const clean = s => String(s).replace(/<[^>]+>/g, '').trim().replace(/^[「“"](.*)[」”"]$/s, '$1').trim();
/** A described picture: the Chinese description, and the English tags after the bar (Chinese words dropped). */
function picture(value) {
  const [text, ...rest] = value.split(/[|｜]/);
  const tags = rest.join(',').replace(/[一-鿿]+/g, ' ').split(/[,，]/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ').slice(0, 600);
  return {text: clean(text).slice(0, 200), tags};
}
const price = value => { const n = Number(String(value).replace(/[,，\s]/g, '').match(/\d+(?:\.\d+)?/)?.[0]); return Number.isFinite(n) && n >= 0 ? Math.min(n, 9999999) : 0; };

/** The model's answer as {chats: [{with, lines: [{from, text}]}], searches, notes: [{title, text}], photos: [{text, tags}],
 *  cart: [{name, price, note}], wallpaper: {text, tags} | null, knows: string[]}. */
export function parsePeek(reply, {name, user = '我'} = {}) {
  const body = String(reply || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/```[a-z]*\n?|```/g, '');
  const out = {chats: [], searches: [], notes: [], photos: [], cart: [], wallpaper: null, knows: []};
  let chat = null, note = null;
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) {
      // Lines of the chat being written, or more lines of a note.
      const s = chat && raw.trim().match(SAID);
      if (s && chat.lines.length < PEEK_LIMITS.lines) { const from = short(s[1]), text = clean(s[2]).slice(0, PEEK_LIMITS.text); if (from && text) chat.lines.push({from: from === user ? 'me' : from, text}); }
      else if (note && raw.trim()) note.text = (note.text + '\n' + clean(raw)).slice(0, PEEK_LIMITS.text);
      continue;
    }
    const [, kind, rest] = m, value = clean(rest);
    chat = null; note = null;
    if (kind === '聊天') {
      const other = short(value);
      if (other && other !== name && out.chats.length < PEEK_LIMITS.chats) { chat = {with: other, lines: []}; out.chats.push(chat); }
    } else if (kind.startsWith('搜索')) {
      if (value && out.searches.length < PEEK_LIMITS.searches) out.searches.push(value.slice(0, 100));
    } else if (kind.startsWith('备忘')) {
      const [title, ...text] = value.split(/[|｜]/);
      const entry = text.length ? {title: clean(title).slice(0, 40), text: clean(text.join('｜')).slice(0, PEEK_LIMITS.text)} : {title: '', text: value.slice(0, PEEK_LIMITS.text)};
      if (entry.text && out.notes.length < PEEK_LIMITS.notes) { out.notes.push(entry); note = entry; }
    } else if (kind.startsWith('购物')) {
      const [item, cost = '', ...note] = value.split(/[|｜]/);
      if (clean(item) && out.cart.length < PEEK_LIMITS.cart) out.cart.push({name: clean(item).slice(0, 60), price: price(cost), note: clean(note.join('｜')).slice(0, 100)});
    } else if (kind === '壁纸') {
      const wall = picture(value);
      if (wall.text && !out.wallpaper) out.wallpaper = wall;
    } else if (kind === '知道') {
      if (value && out.knows.length < PEEK_LIMITS.knows) out.knows.push(value.slice(0, 200));
    } else if (value && out.photos.length < PEEK_LIMITS.photos) {
      const photo = picture(value);
      if (photo.text) out.photos.push(photo);
    }
  }
  out.chats = out.chats.filter(c => c.lines.length);
  return out;
}

/** The id of a person's snapshot: one per person (per card, with 分区 on). */
export const peekId = (name, space = '') => 'peek:' + (space ? space + ':' : '') + name;
/** A picture as it is stored: its description, (when it can be drawn) its tags, the drawn picture and how drawing went. */
function cleanPicture(x) {
  const photo = {text: clip(x.text, 200).trim(), tags: clip(x.tags, 600).trim()};
  if (x.photoId) photo.photoId = clip(x.photoId, 512);
  if (['waiting', 'done', 'failed'].includes(x.state)) photo.state = x.state;
  if (x.note) photo.note = clip(x.note, 200);
  return photo;
}
/** A snapshot as it is stored: {id, kind: 'peek', name, at, chats, searches, notes, photos, cart, wallpaper?, space?}. */
export function cleanPeek(p, at) {
  const name = short(p?.name);
  if (!name) throw Error('不知道是谁的手机');
  const chats = (Array.isArray(p.chats) ? p.chats : []).slice(0, PEEK_LIMITS.chats).map(c => ({with: short(c?.with),
    lines: (Array.isArray(c?.lines) ? c.lines : []).slice(0, PEEK_LIMITS.lines).map(l => ({from: short(l?.from), text: clip(l?.text, PEEK_LIMITS.text).trim()})).filter(l => l.from && l.text)})).filter(c => c.with && c.lines.length);
  const list = (value, max, size) => (Array.isArray(value) ? value : []).map(x => clip(x, size).trim()).filter(Boolean).slice(0, max);
  const notes = (Array.isArray(p.notes) ? p.notes : []).slice(0, PEEK_LIMITS.notes).map(n => ({title: clip(n?.title, 40).trim(), text: clip(n?.text, PEEK_LIMITS.text).trim()})).filter(n => n.text);
  const photos = (Array.isArray(p.photos) ? p.photos : []).slice(0, PEEK_LIMITS.photos).map(x => typeof x === 'string' ? {text: x} : x || {}).map(cleanPicture).filter(x => x.text);
  const cart = (Array.isArray(p.cart) ? p.cart : []).slice(0, PEEK_LIMITS.cart).map(x => ({name: clip(x?.name, 60).trim(), price: price(x?.price), note: clip(x?.note, 100).trim()})).filter(x => x.name);
  const wall = p.wallpaper && typeof p.wallpaper === 'object' ? cleanPicture(p.wallpaper) : null;
  const space = clip(p.space, 300);
  const out = {id: peekId(name, space), kind: 'peek', name, at, chats, searches: list(p.searches, PEEK_LIMITS.searches, 100), notes, photos, cart, ...(wall?.text ? {wallpaper: wall} : {}), ...(space ? {space} : {})};
  if (!chats.length && !out.searches.length && !notes.length && !out.photos.length && !cart.length) throw Error(`没看到${name}手机里的东西，可以再试一次`);
  return out;
}
