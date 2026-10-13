// 朋友圈 (moments) without DOM or network: the moments preset, the prompts for new posts and for reactions, and the
// parser for the model's answer.
//
// The model answers in tagged lines, one item per line:
//   【动态】名字：内容          a new post (only when asking for new posts)
//   【配图】english tags       a picture for the post above (optional)
//   【赞】名字、名字            likes on the post above (or on the post being reacted to)
//   【评论】名字：内容          a comment; 「名字 回复 名字：内容」 answers someone
// The rules come from the chat preset: its rules marked for 朋友圈, plus its story length and posts per refresh.
import {plainStory} from './chat.js';
import {isPlaceholderRole} from './protocol.js';

export const MOMENTS_LIMITS = Object.freeze({posts: 300, comments: 60, text: 2000, people: 12, story: 40, perRefresh: 5});

/** 朋友圈 options (the rules live in the chat preset, as rules used in 朋友圈). Automatic posts are off by default:
 *  each costs a model call. */
export function defaultMoments() {
  return {auto: false, every: 8, dailyMax: 4, images: true, replyToMe: true};
}
const count = (value, min, max, fallback) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
export function normalizeMoments(value) {
  const base = defaultMoments();
  if (!value || typeof value !== 'object') return base;
  return {auto: value.auto === true, every: count(value.every, 1, 100, base.every), dailyMax: count(value.dailyMax, 1, 30, base.dailyMax), images: value.images !== false, replyToMe: value.replyToMe !== false};
}

const fill = (template, values) => String(template).replace(/\{\{(.+?)\}\}/g, (m, key) => values[key.trim()] ?? m);
const who = (name, user) => name === 'me' ? user : name;

/** A post as the model reads it: author, text, picture, likes and comments. */
export function postLines(post, user) {
  const lines = [`${who(post.author, user)}：${post.text}${post.photoId || post.imageTags ? '（配了图）' : ''}`];
  if (post.likes?.length) lines.push(`  赞：${post.likes.map(n => who(n, user)).join('、')}`);
  for (const c of post.comments || []) lines.push(`  ${who(c.from, user)}${c.to ? ' 回复 ' + who(c.to, user) : ''}：${c.text}`);
  return lines.join('\n');
}

/**
 * The request for moments, with the chat preset's rules used in 朋友圈. mode 'posts': new posts from the people; 'react': reactions to one post (the user's new post);
 * 'reply': answers to the user's comment on a post. people: [{name, persona, card}]. recent: latest posts, for variety.
 */
export function buildMomentsRequest({preset, mode = 'posts', people, story = [], user = '我', userPersona = '', recent = [], post = null, comment = null, images = true, lore = '', memory = '', earlier = ''}) {
  const values = {'用户': user};
  const rules = preset.entries.filter(e => e.enabled && e.text.trim() && (e.use || []).includes('moments')).filter(e => images || e.id !== 'm-picture').map(e => fill(e.text, values));
  const names = people.map(p => p.name);
  const system = [
    rules.join('\n\n'),
    `【朋友圈里的人】\n${people.map(p => `- ${p.name}：${(p.persona || p.card || '').trim() || '（没有资料，按剧情里的表现来）'}`).join('\n')}`,
    lore.trim() ? `【世界书】（这些人物和这个世界的设定，写给读者看的：人设、口音、方言、说话方式按这里来；里面的秘密不是每个人都知道）\n${lore.trim()}` : '',
    userPersona.trim() ? `【${user}】（${user}自己的设定，里面可能有别人不知道的事）\n${userPersona.trim()}` : '',
    earlier.trim() ? `【更早的剧情】（记忆插件整理的长期剧情，旁观的记录：每个人只经历了其中一部分）\n${earlier.trim()}` : '',
    story.length ? `【最近的剧情】（旁观的记录：读者看得到全部，朋友圈里的每个人只经历了其中一部分）\n${story.map(s => `${s.name}：${s.text}`).join('\n')}` : '',
    ['【每个人知道什么】',
      '- 每个人只知道自己在场经历的、别人告诉过 TA 的事；不在场的剧情，谁都不能写进自己的动态和评论，也不能「碰巧」猜中细节。',
      `- 朋友圈是给所有朋友看的：就算是自己经历的私事，一般也只含蓄地提，不把和${user}私下在做什么、说了什么的细节写出来，除非人设就是爱晒。`,
      '- 拿不准一个人知不知道的，就当不知道。'].join('\n'),
    memory.trim() ? `${memory.trim()}\n（这些是各人和${user}私下聊过的事：只有那个人自己知道，别人的动态和评论里不要提）` : '',
    recent.length && mode === 'posts' ? `【最近的朋友圈】（不要重复这些内容）\n${recent.map(p => postLines(p, user)).join('\n')}` : '',
    ['【输出格式】',
      '每一项单独一行，只能用下面这几种写法，不要写别的文字、编号或解释：',
      mode === 'posts' ? '「【动态】名字：动态内容」发一条新动态；' : '',
      mode === 'posts' && images ? '「【配图】英文 tag」给上一条动态配图，不需要配图就不写；' : '',
      '「【赞】名字、名字」点赞；',
      `「【评论】名字：评论内容」评论，回复某人时写「【评论】名字 回复 某人：内容」。`,
      `名字只能是：${names.join('、')}。不要替${user}写动态、点赞或评论。`].filter(Boolean).join('\n')
  ].filter(Boolean).join('\n\n');
  let ask;
  if (mode === 'posts') ask = `挑 1 到 ${preset.posts} 个人各发一条新动态（不一定每个人都发）。每条动态下面可以跟着别人的赞和评论。`;
  else if (mode === 'react') ask = `【${user}刚发的动态】\n${postLines(post, user)}\n\n朋友们看到了这条动态：写出谁点了赞、谁评论了什么。`;
  else ask = `【这条动态】\n${postLines(post, user)}\n\n${user}刚评论：「${comment.text}」${comment.to ? `（回复 ${who(comment.to, user)}）` : ''}\n被评论的人回复${user}，别的人也可以接话。只写新的评论。`;
  return [{role: 'system', content: system}, {role: 'user', content: ask}];
}

const LINE = /^\s*(?:[-*•]\s*)?[【\[]\s*(动态|配图|赞|点赞|评论)\s*[】\]]\s*(.*)$/;
const SAID = /^([^:：\n]{1,40}?)\s*(?:回复\s*([^:：\n]{1,40}?))?\s*[:：]\s*(.+)$/;
const clean = s => String(s).replace(/<[^>]+>/g, '').trim().replace(/^[「“"](.*)[」”"]$/s, '$1').trim();

/**
 * The model's answer as {posts: [{author, text, imageTags, likes, comments}], likes, comments}. posts only for mode
 * 'posts'; likes and comments outside a post belong to the post being reacted to. Unknown names are dropped, and
 * nobody speaks for the user.
 */
export function parseMoments(reply, {names, user = '我', mode = 'posts'}) {
  const body = String(reply || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/```[a-z]*\n?|```/g, '');
  const known = name => names.find(n => n === String(name).trim());
  const target = name => { const n = String(name || '').trim(); return !n ? '' : n === user || n === '我' ? 'me' : known(n) || ''; };
  const out = {posts: [], likes: [], comments: []};
  let post = null;
  const holder = () => post || out;
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, kind, rest] = m;
    if (kind === '动态') {
      if (mode !== 'posts') continue;
      const s = rest.match(SAID), author = s && known(s[1]);
      post = null;
      if (!author || isPlaceholderRole(author)) continue;
      const said = clean(s[3]).slice(0, MOMENTS_LIMITS.text);
      if (!said) continue;
      if (out.posts.length >= MOMENTS_LIMITS.perRefresh) break;
      post = {author, text: said, imageTags: '', likes: [], comments: []};
      out.posts.push(post);
    } else if (kind === '配图') {
      if (post && !post.imageTags) post.imageTags = clean(rest).replace(/[一-鿿]+/g, ' ').split(/[,，]/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ').slice(0, 600);
    } else if (kind === '赞' || kind === '点赞') {
      const list = holder().likes;
      for (const name of rest.split(/[、,，\s]+/)) { const n = known(name); if (n && !list.includes(n)) list.push(n); }
    } else {
      const s = rest.match(SAID), from = s && known(s[1]);
      if (!from) continue;
      const said = clean(s[3]).slice(0, 500);
      if (said && holder().comments.length < 20) holder().comments.push({from, to: target(s[2]), text: said});
    }
  }
  // A post's author does not like their own post.
  for (const p of out.posts) p.likes = p.likes.filter(n => n !== p.author);
  return out;
}

/** Recent story messages as plain lines, for the prompt. */
// Recent story for the phone's requests: a reply is kept whole up to `each` characters (it used to be cut at 600, so a
// long reply stopped mid-sentence), and the newest come first until `total` is used up.
export const STORY_LIMITS = Object.freeze({each: 4000, total: 20000});
// limit: how many replies, or a chat preset (its context, storyEach and storyTotal; 0 there is no limit).
export function storyLines(chat, limit, user, {each = STORY_LIMITS.each, total = STORY_LIMITS.total} = {}) {
  if (limit && typeof limit === 'object') { const p = limit; limit = p.context; each = p.storyEach ?? each; total = p.storyTotal ?? total; }
  each = each || Infinity; total = total || Infinity;
  const out = [];
  let used = 0;
  for (let i = (chat?.length || 0) - 1; i >= 0 && out.length < limit; i--) {
    const m = chat[i];
    if (!m || m.is_system) continue;
    let said = plainStory(m.mes);
    if (!said) continue;
    if (said.length > each) said = said.slice(0, each) + '……';
    if (out.length && used + said.length > total) break;
    used += said.length;
    out.unshift({name: m.name || (m.is_user ? user : '旁白'), text: said});
  }
  return out;
}
