import {test} from 'node:test';
import assert from 'node:assert/strict';
import {storyBatch, storySpace, storyContacts, applyStoryBatch, storySnapshot} from './story-link.js';
import {inSpace} from './chat.js';
import {createStoryHost} from '../story-host.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const contacts = [{id: 'lin', name: '林同学', description: '图书馆同学'}, {id: 'zhou', name: '周同学', description: ''}];
const message = {id: 'story-1:phone:0', npcId: 'lin', text: '我在图书馆等你。', at: '第1天 17:12', read: false};
let serial = 0;
const options = () => ({now: 1234567890, id: () => `m-${++serial}`});
const apply = (rows = [], messages = [message], session = A, people = contacts) => applyStoryBatch(rows, storyBatch(session, people, messages), options());

test('seeds stable NPC threads and preserves story time as data', () => {
  const {rows} = apply();
  assert.equal(rows.length, 2); assert.equal(rows[0].unread, 1);
  assert.equal(rows[0].messages[0].storyAt, '第1天 17:12');
  assert.equal(rows[0].messages[0].from, '林同学');
  assert.equal(storySnapshot(A, rows, contacts).contacts[0].last.id, message.id);
});
test('replaying a committed event neither duplicates nor changes its text', () => {
  const first = apply(), again = apply(first.rows, [{...message, text: 'changed input'}]);
  assert.deepEqual(again.rows, first.rows); assert.deepEqual(again.changed, []);
});
test('a read receipt persists across a stale unread world replay', () => {
  const first = apply(), read = apply(first.rows, [{...message, read: true}]);
  const replay = apply(read.rows);
  assert.equal(replay.rows[0].unread, 0);
  assert.deepEqual(storySnapshot(A, replay.rows, contacts).receipts, [message.id]);
});
test('new messages increase unread without reviving earlier read events', () => {
  const first = apply([], [{...message, read: true}]);
  const result = apply(first.rows, [message, {...message, id: 'story-2:phone:0'}]);
  assert.equal(result.rows[0].unread, 1);
  assert.deepEqual(storySnapshot(A, result.rows, contacts).receipts, [message.id]);
});
test('two chats use separate rows for the same NPC and event id', () => {
  const a = apply().rows, b = apply([], [message], B).rows;
  assert.notEqual(a[0].id, b[0].id); assert.notEqual(a[0].space, b[0].space);
  assert.equal(a[0].unread, 1); assert.equal(b[0].unread, 1);
});
test('strict story filtering excludes legacy shared and other-story rows; ordinary views exclude story rows', () => {
  const here = {key: storySpace(A), strict: true};
  assert.equal(inSpace({}, here), false);
  assert.equal(inSpace({space: storySpace(B)}, here), false);
  assert.equal(inSpace({space: storySpace(A)}, here), true);
  assert.equal(inSpace({space: storySpace(A)}, null), false);
  assert.equal(inSpace({}, null), true);
  assert.equal(inSpace({space: 'card:old'}, {key: 'card:old'}), true);
});
test('duplicate names/identities and unknown senders fail before applying a batch', () => {
  assert.throws(() => storyContacts([...contacts, {...contacts[0], id: 'someone-else'}]), /同名/);
  assert.throws(() => storyContacts([...contacts, {...contacts[0], name: '另一个人'}]), /重复/);
  assert.throws(() => storyBatch(A, contacts, [{...message, npcId: 'unknown'}]), /不在联系人/);
  assert.throws(() => storyBatch(A, contacts, [message, message]), /重复标识/);
});
test('event identity cannot move to another NPC', () => {
  const first = apply();
  assert.throws(() => apply(first.rows, [{...message, npcId: 'zhou'}]), /另一个人物/);
});
test('a colliding ordinary record is rejected without mutating it', () => {
  const first = apply(), legacy = {...first.rows[0], space: 'card:existing'};
  delete legacy.storyLink;
  const original = structuredClone(legacy);
  assert.throws(() => apply([legacy]), /已有聊天冲突/);
  assert.deepEqual(legacy, original);
});
test('deduplication survives the phone history retention limit', () => {
  const messages = Array.from({length: 1001}, (_, n) => ({...message, id: `event-${n}`}));
  const first = apply([], messages);
  assert.equal(first.rows[0].messages.length, 1000);
  assert.equal(first.rows[0].storyLink.events.length, 1001);
  const replay = apply(first.rows, messages);
  assert.equal(replay.rows[0].unread, 1001); assert.deepEqual(replay.changed, []);
});
test('NPC rename updates only the owned thread and its sender names', () => {
  const first = apply(), original = structuredClone(first.rows);
  const updated = apply(first.rows, [], A, [{...contacts[0], name: '林晴'}, contacts[1]]);
  assert.equal(updated.rows[0].messages[0].from, '林晴');
  assert.deepEqual(first.rows, original); assert.equal(updated.rows[0].id, first.rows[0].id);
});
test('text and world time remain plain strings; malformed inputs are rejected', () => {
  const text = '<img src=x onerror=alert(1)>不是执行指令';
  assert.equal(apply([], [{...message, text}]).rows[0].messages[0].text, text);
  assert.throws(() => storyBatch(A, contacts, [{...message, read: 'yes'}]), /已读状态/);
  assert.throws(() => storyBatch(A, contacts, [{...message, text: 'x'.repeat(4001)}]), /内容/);
  assert.throws(() => storySpace('not-a-session'), /存档标识/);
});

function fixture() {
  let chat = 'chat-A', active = true, block = null;
  const data = new Map(), listeners = new Set(), opened = [], events = [], overlays = [];
  const backend = {
    storySpace: null, assertOpen() { if (!active) throw Error('closed'); },
    setStorySpace(value) { this.storySpace = value; overlays.push(value); },
    emit(type, extra) { const event = {type, ...extra}; events.push(event); for (const listener of listeners) listener(event); },
    subscribe(listener) { listeners.add(listener); listener({type: 'playback'}); return () => listeners.delete(listener); },
    async threads() { return [...data.values()].filter(row => inSpace(row, {...this.storySpace, strict: true})); },
    chats: {
      async syncStory(session, people, messages, guard) {
        if (block) await block;
        guard();
        const result = apply([...data.values()].filter(row => row.space === storySpace(session)), messages, session, people);
        for (const row of result.rows) data.set(row.id, row);
        return result;
      },
      async storyThreads(session) { return structuredClone([...data.values()].filter(row => row.space === storySpace(session))); },
    },
  };
  const host = createStoryHost({backend, currentChatId: () => chat, isActive: () => active, openThread: id => opened.push(id)});
  return {host, data, listeners, opened, events, overlays, backend,
    bind: (sessionId = A, chatId = chat) => host.api.bind({sessionId, chatId, label: '未读之城', contacts}),
    chat: value => { chat = value; }, active: value => { active = value; }, block: value => { block = value; },
    read: id => { const row = data.get(id); row.unread = 0; row.storyLink.events.forEach(e => { e.read = true; }); backend.emit('chat', {threadId: id}); },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test('lease subscribes to real read changes and release restores ordinary view without deleting messages', async () => {
  const f = fixture(), lease = await f.bind(), values = [];
  const snap = await lease.sync({messages: [message]});
  lease.subscribe(value => values.push(value));
  f.read(snap.contacts[0].threadId); await settle();
  assert.equal(values.at(-1).unreadTotal, 0); assert.deepEqual(values.at(-1).receipts, [message.id]);
  await lease.openContact('lin'); assert.equal(f.opened.at(-1), snap.contacts[0].threadId);
  lease.release(); lease.release();
  assert.equal(f.backend.storySpace, null); assert.equal(f.listeners.size, 0); assert.equal(f.data.size, 2);
  await assert.rejects(lease.snapshot(), /失效/);
});
test('phone reads remain read after release and a new binding replays stale world data', async () => {
  const f = fixture(), lease = await f.bind(), snap = await lease.sync({messages: [message]});
  f.read(snap.contacts[0].threadId); lease.release();
  const next = await f.bind();
  assert.equal((await next.sync({messages: [message]})).unreadTotal, 0);
  assert.equal(f.data.get(snap.contacts[0].threadId).messages.length, 1);
});
test('a changed real chat rejects queued writes, notifications, and opening old contacts', async () => {
  const f = fixture(), lease = await f.bind();
  let unblock; f.block(new Promise(resolve => { unblock = resolve; }));
  const work = lease.sync({messages: [message]}); await settle();
  f.chat('chat-B'); f.host.chatChanged(); unblock();
  await assert.rejects(work, /失效/);
  await assert.rejects(lease.openContact('lin'), /失效/);
  assert.equal([...f.data.values()].reduce((n, row) => n + row.messages.length, 0), 0);
  await assert.rejects(f.bind(A, 'chat-A'), /聊天已经切换/);
});
test('replacement binding isolates identical NPC names, and old release cannot clear new view', async () => {
  const f = fixture(), a = await f.bind(); await a.sync({messages: [message]});
  f.chat('chat-B'); const b = await f.bind(B); await b.sync({messages: [message]});
  a.release(); assert.equal(f.backend.storySpace.key, storySpace(B));
  assert.equal((await b.snapshot()).unreadTotal, 1);
  f.host.dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.data.size, 4);
});
test('a slower earlier snapshot cannot overwrite a newer unread publication', async () => {
  const f = fixture(), lease = await f.bind(); await lease.sync({messages: [message]});
  const original = f.backend.chats.storyThreads;
  let resolveOld, first = true;
  f.backend.chats.storyThreads = async (...args) => {
    const value = await original(...args);
    if (first) { first = false; await new Promise(resolve => { resolveOld = resolve; }); }
    return value;
  };
  const seen = []; lease.subscribe(value => seen.push(value)); await settle();
  f.read([...f.data.values()][0].id); await settle();
  assert.equal(seen.at(-1).unreadTotal, 0);
  resolveOld(); await settle();
  assert.equal(seen.length, 1); assert.equal(seen[0].unreadTotal, 0);
  lease.release();
});
