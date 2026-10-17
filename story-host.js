import {storyContacts, storySnapshot, storySpace, storyThreadId} from './core/story-link.js';

/** Public story-only API. Its leases never expose the settings/backend API. */
export function createStoryHost({backend, currentChatId, isActive = () => true, openThread = () => {}}) {
  let current = null, disposed = false;
  const activeChat = () => String(currentChatId() ?? '');
  function bind(request) {
    if (disposed || !isActive()) return Promise.reject(Error('手机剧情联动尚未启用'));
    const sessionId = request?.sessionId, space = storySpace(sessionId), chatId = String(request?.chatId ?? '');
    const contacts = storyContacts(request?.contacts);
    if (!chatId || activeChat() !== chatId) return Promise.reject(Error('聊天已经切换，请重新进入剧情'));
    current?.release();
    const listeners = new Set();
    let released = false, people = contacts, tail = Promise.resolve(), scheduled = false, publication = 0;
    const label = typeof request.label === 'string' ? request.label.slice(0, 80) : '剧情';
    const guard = () => {
      if (disposed || released || current !== lease || !isActive() || activeChat() !== chatId) throw Error('剧情手机连接已失效，请重新进入当前聊天');
      backend.assertOpen();
    };
    const snapshot = async () => {
      guard();
      const rows = await backend.chats.storyThreads(sessionId, {all: true});
      guard();
      return storySnapshot(sessionId, rows, people);
    };
    const publish = () => {
      publication++;
      if (scheduled || released) return;
      scheduled = true;
      queueMicrotask(async () => {
        scheduled = false;
        const version = publication;
        try { const value = await snapshot(); if (version !== publication) return; for (const listener of listeners) { try { listener(structuredClone(value)); } catch {} } }
        catch { /* a switched/released lease cannot publish old-session data */ }
      });
    };
    const overlay = () => backend.setStorySpace({key: space, name: label, members: people.map(c => c.name), contacts: people});
    const release = () => {
      if (released) return;
      released = true; off(); listeners.clear();
      if (current === lease) { current = null; openThread(null); backend.setStorySpace(null); }
    };
    const off = backend.subscribe(event => {
      if (released) return;
      if (activeChat() !== chatId || !isActive()) { release(); return; }
      if (event.type === 'chat') publish();
    });
    const lease = Object.freeze({
      sync({contacts: updated = people, messages = []} = {}) {
        const next = storyContacts(updated);
        const incoming = structuredClone(messages);
        const work = tail.then(async () => {
          guard();
          const result = await backend.chats.syncStory(sessionId, next, incoming, guard);
          guard(); people = next; overlay();
          for (const threadId of result.changed) backend.emit('chat', {threadId, story: true});
          return snapshot();
        });
        tail = work.catch(() => {});
        return work;
      },
      snapshot,
      subscribe(listener) {
        guard();
        if (typeof listener !== 'function') throw Error('剧情手机订阅需要回调函数');
        listeners.add(listener); publish(); return () => listeners.delete(listener);
      },
      async openContact(npcId) {
        guard();
        if (!people.some(person => person.id === npcId)) throw Error('当前剧情没有这个联系人');
        await tail; guard(); openThread(storyThreadId(space, npcId));
      },
      release,
    });
    current = lease;
    return lease.sync({contacts, messages: []}).then(() => lease, error => { release(); throw error; });
  }
  return Object.freeze({
    api: Object.freeze({version: 1, bind}),
    chatChanged() { current?.release(); },
    dispose() { if (disposed) return; current?.release(); disposed = true; },
  });
}
