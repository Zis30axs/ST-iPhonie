// Narrow, data-only contract for an immersive story. Phone stores remain the
// authority for messages and reading; no settings or ordinary contacts change.
export const STORY_LINK_LIMITS = Object.freeze({contacts: 100, messages: 2000, events: 10000});
const fail = message => { throw Error(message); };
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}无效`);
  return value.trim();
};
export function storySpace(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(sessionId)) fail('剧情存档标识无效');
  return `unread-city:${sessionId}`;
}
export function storyContacts(values) {
  if (!Array.isArray(values) || values.length > STORY_LINK_LIMITS.contacts) fail('剧情联系人列表无效');
  const ids = new Set(), names = new Set();
  return values.map(value => {
    const id = text(value?.id, 80, '人物标识'), name = text(value?.name, 40, '人物名字');
    if (!/^[a-zA-Z0-9_.:-]+$/.test(id) || name === 'me') fail('人物标识或名字不能用于手机联系人');
    if (ids.has(id) || names.has(name)) fail('剧情联系人存在重复标识或同名人物，请先区分人物名字');
    ids.add(id); names.add(name);
    if (value.description !== undefined && typeof value.description !== 'string') fail('人物描述无效');
    return {id, name, description: (value.description || '').slice(0, 4000)};
  });
}
export const storyThreadId = (space, npcId) => `${space}:npc:${npcId}`;
export function storyBatch(sessionId, contacts, messages = []) {
  const space = storySpace(sessionId), people = storyContacts(contacts), ids = new Set(people.map(c => c.id));
  if (!Array.isArray(messages) || messages.length > STORY_LINK_LIMITS.messages) fail('一次剧情消息过多');
  const events = new Set();
  const clean = messages.map(value => {
    const id = text(value?.id, 240, '剧情消息标识'), npcId = text(value?.npcId, 80, '消息人物标识');
    if (!ids.has(npcId)) fail('剧情消息对应的人物不在联系人中');
    if (events.has(id)) fail('同一批剧情消息存在重复标识');
    events.add(id);
    const message = text(value.text, 4000, '剧情消息内容');
    if (value.at !== undefined && (typeof value.at !== 'string' || value.at.length > 80)) fail('剧情时间无效');
    if (value.read !== undefined && typeof value.read !== 'boolean') fail('剧情已读状态无效');
    return {id, npcId, text: message, at: value.at || '', read: value.read === true};
  });
  return {space, contacts: people, messages: clean};
}

/** Pure transaction transform, exported for regression checks. Never mutates input. */
export function applyStoryBatch(existing, batch, {now = Date.now(), id = () => crypto.randomUUID()} = {}) {
  const rows = [], changed = [];
  const owners = new Map(existing.flatMap(row => (row.storyLink?.events || []).map(event => [event.id, row.storyLink.npcId])));
  for (const event of batch.messages) if (owners.has(event.id) && owners.get(event.id) !== event.npcId) fail('剧情消息标识已属于另一个人物');
  for (const contact of batch.contacts) {
    const threadId = storyThreadId(batch.space, contact.id), before = existing.find(row => row.id === threadId);
    if (before && (before.space !== batch.space || before.storyLink?.npcId !== contact.id)) fail('剧情手机记录与已有聊天冲突');
    const row = before ? structuredClone(before) : {id: threadId, type: 'dm', name: contact.name, members: [contact.name], unread: 0, createdAt: now, updatedAt: now, messages: [], space: batch.space,
      storyLink: {npcId: contact.id, description: contact.description, events: []}};
    const oldName = row.members[0];
    row.name = contact.name; row.members = [contact.name]; row.storyLink.description = contact.description;
    if (oldName !== contact.name) for (const message of row.messages) if (message.from === oldName) message.from = contact.name;
    const seen = new Map(row.storyLink.events.map(event => [event.id, event]));
    for (const event of batch.messages.filter(message => message.npcId === contact.id)) {
      const prior = seen.get(event.id);
      if (prior) {
        // Reading is monotonic even if the world's last save predates the phone.
        if (event.read && !prior.read) { prior.read = true; row.unread = Math.max(0, row.unread - 1); }
        continue;
      }
      if (seen.size >= STORY_LINK_LIMITS.events) fail('当前人物的剧情消息记录已满，请导出存档后开启新聊天');
      const messageId = id();
      row.messages.push({id: messageId, from: contact.name, kind: 'text', text: event.text, at: now + row.messages.length,
        storyEventId: event.id, storyAt: event.at});
      const receipt = {id: event.id, messageId, read: event.read};
      row.storyLink.events.push(receipt); seen.set(event.id, receipt);
      if (!event.read) row.unread++;
      row.updatedAt = now;
    }
    row.messages = row.messages.slice(-1000);
    if (!before || JSON.stringify(row) !== JSON.stringify(before)) changed.push(row.id);
    rows.push(row);
  }
  return {rows, changed};
}

export function storySnapshot(sessionId, rows, contacts) {
  const byId = new Map(rows.map(row => [row.storyLink?.npcId, row]));
  const receipts = [], people = contacts.map(contact => {
    const row = byId.get(contact.id), last = row?.messages.filter(m => m.kind !== 'system').at(-1);
    receipts.push(...(row?.storyLink?.events || []).filter(e => e.read).map(e => e.id));
    return {npcId: contact.id, threadId: storyThreadId(storySpace(sessionId), contact.id), name: contact.name, unread: row?.unread || 0,
      last: last ? {id: last.storyEventId || last.id, text: last.text, from: last.from, at: last.storyAt || String(last.at)} : null};
  });
  return {sessionId, unreadTotal: rows.reduce((n, row) => n + (row.muted ? 0 : row.unread || 0), 0), contacts: people, receipts: [...new Set(receipts)]};
}
