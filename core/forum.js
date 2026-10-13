// 论坛: a public board everyone can read, next to 朋友圈 (which only friends see). Characters post and reply there,
// and so do strangers (路人) with their own screen names. No DOM or network here: the prompts, the parser for the model's
// answer and the checks on what is stored.
//
// The model answers in tagged lines, one item per line:
//   【热搜】话题                     a trending topic (only when asking for new posts)
//   【帖子】作者｜标题｜正文          a new post; 作者 is a character's name or a stranger's screen name
//   【回复】作者：内容                a reply to the post above; 「作者 回复 某人：内容」 answers someone
//   【网名】真名｜网名                 a screen name made up for a character who had none (kept from then on)
// Everyone is on the board by a screen name (网名): the user's and the characters' are given (or made up once) and the
// model writes only those; the answer is read back to the real names, which is how posts are stored.
import {isPlaceholderRole} from './protocol.js';

export const FORUM_LIMITS = Object.freeze({posts: 200, replies: 80, perRefresh: 5, hot: 8, title: 60, text: 2000, reply: 500});

const fill = (template, values) => String(template).replace(/\{\{(.+?)\}\}/g, (m, key) => values[key.trim()] ?? m);
const who = (name, user) => name === 'me' ? user : name;
const clip = (value, max) => String(value ?? '').slice(0, max);
const person = value => clip(value, 30).replace(/[|｜]/g, '').trim();

/** A post as the model reads it: author, title, text and the replies under it. label: the name shown for someone. */
export function postLines(post, user, max = 30, label = name => who(name, user)) {
  const lines = [`${label(post.author)}｜${post.title || '（无标题）'}｜${post.text}`];
  for (const r of (post.replies || []).slice(-max)) lines.push(`  ${label(r.from)}${r.to ? ' 回复 ' + label(r.to) : ''}：${r.text}`);
  return lines.join('\n');
}
/** How someone shows on the board: the user's 网名 for 'me', a character's 网名, or the name itself. */
export const screenName = (handles = {}, user = '我') => name => name === 'me' ? handles.me || user : handles[name] || name;

/**
 * The request for 论坛, with the chat preset's rules used in 论坛. mode 'posts': new posts and the 热搜;
 * 'react': replies to the user's new post; 'reply': answers to the user's reply. people: [{name, persona, card}].
 */
/** Who knows what on a public forum: strangers only what is public; characters only what they lived, and they keep it to themselves. */
export function forumKnows(user) {
  return ['【论坛上的人知道什么】',
    '论坛是公开的，帖子和回复只能写论坛上的人真的会知道的事：',
    '- 路人只知道公开的事：在街上、学校、店里这类公共场所发生、被很多人看到的事，传开了的消息和传闻，有人在论坛上发过的事，这个世界里人人都知道的常识。',
    '- 角色只知道自己在场经历的、别人告诉过 TA 的事；就算知道，在公开的论坛上一般也不会把私事说出来，要说也只说愿意让大家知道的，而且说得含糊。',
    `- ${user}和别人在家里、房间里、私下里做的事和说的话（在做什么、穿什么、抱着什么、吃什么、聊了什么），论坛上的人都不知道，也不能「碰巧」猜中或者写出一样的细节。`,
    '- 最近的剧情只能给论坛提供大方向（季节天气、城里的大事、大家都在关心的东西），不要把剧情里的具体场景、动作、对话搬到论坛上。',
    `- ${user}自己在论坛上发的帖子和回复是公开的，大家都看得到；回复时只根据帖子里写的内容和公开的事。`,
    '- 拿不准是不是公开的，就当不知道。'].join('\n');
}
export function buildForumRequest({preset, mode = 'posts', people, story = [], user = '我', userPersona = '', recent = [], hot = [], post = null, reply = null, lore = '', earlier = '', handles = {}}) {
  const label = screenName(handles, user), missing = people.filter(p => !handles[p.name]).map(p => p.name);
  const rules = preset.entries.filter(e => e.enabled && e.text.trim() && (e.use || []).includes('forum')).map(e => fill(e.text, {'用户': user}));
  const system = [
    rules.join('\n\n'),
    people.length ? `【论坛里的角色】（在论坛上都用网名）\n${people.map(p => `- ${handles[p.name] ? `网名「${handles[p.name]}」，其实是${p.name}` : p.name}：${(p.persona || p.card || '').trim() || '（没有资料，按剧情里的表现来）'}`).join('\n')}` : '',
    lore.trim() ? `【世界书】（这些人物和这个世界的设定，写给读者看的：人设、口音、方言、说话方式按这里来；里面的秘密和私事，论坛上的人不知道）\n${lore.trim()}` : '',
    userPersona.trim() ? `【${user}】（${user}自己的设定，论坛上的人不知道）\n${userPersona.trim()}` : '',
    earlier.trim() ? `【更早的剧情】（记忆插件整理的长期剧情，旁观的记录：论坛上的人看不到）\n${earlier.trim()}` : '',
    story.length ? `【最近的剧情】（旁观的记录：读者看得到全部，论坛上的人看不到。这不是论坛上的人知道的事）\n${story.map(s => `${s.name}：${s.text}`).join('\n')}` : '',
    mode === 'posts' && hot.length ? `【之前的热搜】（可以延续，也可以换新的）\n${hot.join('\n')}` : '',
    mode === 'posts' && recent.length ? `【最近的帖子】（不要重复这些内容）\n${recent.map(p => `${label(p.author)}｜${p.title}`).join('\n')}` : '',
    forumKnows(user),
    ['【网名】',
      '论坛上大家都用网名：帖子和回复的作者、回复的对象、正文里提到的人，都只写网名，不写真名。网名背后是谁，路人不知道；角色一般也认不出别人的网名。',
      `${user}在论坛上的网名是「${label('me')}」：大家只看得到这个网名，不知道这是${user}。`,
      missing.length ? `${missing.join('、')}还没有网名：先在最前面给每人单独一行写「【网名】真名｜网名」，网名像真的网友起的、符合人设（不要带真名），之后发帖回帖都用这个网名。` : ''].filter(Boolean).join('\n'),
    ['【输出格式】',
      '每一项单独一行，只能用下面这几种写法，不要写别的文字、编号或解释：',
      mode === 'posts' ? `「【公开】一件事」先写这块，0 到 5 条：最近的剧情里，论坛上的人真的能知道的公开的事（在公共场所发生、很多人看见的，传开了的，有人发出来的）；没有就不写。帖子和回复里提到剧情，只能用这几条；` : '',
      mode === 'posts' ? '「【热搜】话题」现在论坛上的热搜，一个话题一行；' : '',
      mode === 'posts' ? '「【帖子】作者｜标题｜正文」发一条新帖子，作者写角色或路人的网名；' : '',
      '「【回复】作者：内容」回复上面的帖子，回复某人时写「【回复】作者 回复 某人：内容」。',
      `路人的网名要像真的网友（不要叫「路人甲」），同一个路人前后用同一个网名。不要替${user}（网名「${label('me')}」）发帖或回复。`].filter(Boolean).join('\n')
  ].filter(Boolean).join('\n\n');
  let ask;
  if (mode === 'posts') ask = `论坛刷新了：先写 3 到 6 个热搜话题，再发 1 到 ${preset.posts + 1} 条新帖子，有的是角色发的，有的是路人发的。每条帖子下面跟着几条回复，角色和路人都可以回。`;
  else if (mode === 'react') ask = `【${user}刚发的帖子】\n${postLines(post, user, 30, label)}\n\n大家看到了这个帖子：写出路人和角色的回复（一般三到八条，按话题热不热闹来）。只写回复。`;
  else ask = `【这个帖子】\n${postLines(post, user, 30, label)}\n\n${user}（${label('me')}）刚回复：「${reply.text}」${reply.to ? `（回复 ${label(reply.to)}）` : ''}\n被回复的人接着回${user}，别的人也可以插话。只写新的回复。`;
  return [{role: 'system', content: system}, {role: 'user', content: ask}];
}

const LINE = /^\s*(?:[-*•]\s*)?[【\[]\s*(热搜|帖子|回复|评论|网名)\s*[】\]]\s*(.*)$/;
const SAID = /^([^:：\n]{1,30}?)\s*(?:回复\s*([^:：\n]{1,30}?))?\s*[:：]\s*(.+)$/;
const clean = s => String(s).replace(/<[^>]+>/g, '').trim().replace(/^[「“"](.*)[」”"]$/s, '$1').trim();

/**
 * The model's answer as {hot: [话题], posts: [{author, title, text, replies}], replies}. Authors are characters or
 * strangers; nobody speaks for the user. Replies outside a post belong to the post being replied to.
 */
export function parseForum(reply, {user = '我', mode = 'posts', handles = {}} = {}) {
  const body = String(reply || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/```[a-z]*\n?|```/g, '');
  // Screen names back to who they are ('me' for the user's).
  const back = new Map(Object.entries(handles).map(([name, handle]) => [handle, name]));
  const real = name => back.get(name) || name;
  const isUser = name => !name || name === user || name === '我' || real(name) === 'me' || isPlaceholderRole(name);
  const target = name => { const n = real(person(name)); return !n ? '' : n === user || n === '我' ? 'me' : n; };
  const out = {hot: [], posts: [], replies: [], names: {}};
  let post = null;
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const [, kind, rest] = m;
    if (kind === '网名') {
      const [name, handle] = rest.split(/[|｜]/).map(s => person(clean(s)));
      if (name && handle && handle !== name && !isUser(name) && !back.has(handle)) { out.names[name] = handle; back.set(handle, name); }
    } else if (kind === '热搜') {
      const topic = clean(rest).replace(/^#|#$/g, '').trim().slice(0, 40);
      if (mode === 'posts' && topic && out.hot.length < FORUM_LIMITS.hot && !out.hot.includes(topic)) out.hot.push(topic);
    } else if (kind === '帖子') {
      post = null;
      if (mode !== 'posts' || out.posts.length >= FORUM_LIMITS.perRefresh) continue;
      let parts = rest.split(/[|｜]/).map(s => s.trim());
      // 「作者：正文」 without the bars: no title.
      if (parts.length < 2) { const s = rest.match(SAID); if (!s) continue; parts = [s[1], '', s[3]]; }
      if (parts.length === 2) parts = [parts[0], '', parts[1]];
      const author = real(person(parts[0].replace(/[:：]$/, ''))), title = clean(parts[1]).slice(0, FORUM_LIMITS.title), text = clean(parts.slice(2).join('｜')).slice(0, FORUM_LIMITS.text);
      if (isUser(author) || !text) continue;
      post = {author, title, text, replies: []};
      out.posts.push(post);
    } else {
      const s = rest.match(SAID), from = s && real(person(s[1]));
      if (!from || isUser(from)) continue;
      const said = clean(s[3]).slice(0, FORUM_LIMITS.reply), list = (post || out).replies;
      if (said && list.length < 20) list.push({from, to: target(s[2]), text: said});
    }
  }
  return out;
}

/** A post as it is stored. heat: how many have looked (shown as 热度), made up from its replies and likes. */
export function cleanPost(p, id, at, newId) {
  const author = person(p?.author), title = clip(p?.title, FORUM_LIMITS.title).trim(), text = clip(p?.text, FORUM_LIMITS.text).trim();
  if (!author) throw Error('帖子缺少作者');
  if (!text) throw Error('帖子内容为空');
  const replies = (Array.isArray(p.replies) ? p.replies : []).slice(-FORUM_LIMITS.replies).map((r, i) => cleanReply(r, r?.id || newId(), Number.isFinite(r?.at) ? r.at : at + i + 1));
  return {id, kind: 'forum', author, title, text, at, source: ['auto', 'me'].includes(p.source) ? p.source : 'auto',
    likes: Math.max(0, Math.round(Number(p.likes) || 0)), liked: p.liked === true, heat: Math.max(0, Math.round(Number(p.heat) || 0)), replies, ...(p.space ? {space: clip(p.space, 300)} : {})};
}
export function cleanReply(r, id, at) {
  const from = person(r?.from), said = clip(r?.text, FORUM_LIMITS.reply).trim();
  if (!from || !said) throw Error('回复内容为空');
  return {id: String(id), from, ...(person(r.to) ? {to: person(r.to)} : {}), text: said, at};
}
/** Made-up numbers for a new post from someone else, so the board looks lived in. */
export function startingHeat(post, random = Math.random) {
  const replies = post.replies?.length || 0;
  return {likes: Math.round(random() * 40 + replies * (3 + random() * 12)), heat: Math.round(200 + random() * 3000 + replies * 150)};
}
