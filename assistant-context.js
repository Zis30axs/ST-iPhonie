// Observe the host's outgoing request objects; never regenerate, reconstruct, or persist story prompts.
const contextOf = context => typeof context === 'function' ? context() : context || {};
const chatKey = ctx => ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null;
const isStory = type => [undefined, 'normal', 'regenerate', 'swipe', 'continue', 'impersonate'].includes(type);

export function createAssistantContext(context) {
  const ctx = contextOf(context), source = ctx.eventSource, types = ctx.eventTypes || {}, listeners = [];
  let generation = null, pending = null, snapshot = null, closed = false;
  const identity = () => { const now = contextOf(context); return {chat: now.chat, id: chatKey(now), api: now.mainApi}; };
  const same = item => { const now = identity(); return item && item.chat === now.chat && item.id === now.id && item.api === now.api; };
  const listen = (key, fn) => { if (source?.on && types[key]) { source.on(types[key], fn); listeners.push([types[key], fn]); } };
  const finish = () => {
    if (pending && same(pending)) {
      // Keep the event argument by reference until all asynchronous plugin listeners finish, including replacements.
      const value = pending.api === 'openai' ? pending.data.messages : pending.data.prompt;
      if (Array.isArray(value) && value.length || typeof value === 'string' && value.length) {
        snapshot = {...pending, messages: typeof value === 'string' ? [{role: 'user', content: value}] : structuredClone(value), capturedAt: Date.now()};
        delete snapshot.data;
      }
    }
    pending = null; generation = null;
  };
  listen('GENERATION_STARTED', (type, options, dryRun) => {
    if (!dryRun && isStory(type)) { generation = {...identity(), type}; pending = null; }
  });
  listen('GENERATE_AFTER_DATA', (data, dryRun) => {
    if (dryRun || !same(generation)) return;
    if (generation.api !== 'openai' && typeof data?.prompt === 'string') pending = {...generation, data};
  });
  listen('CHAT_COMPLETION_SETTINGS_READY', data => {
    if (!same(generation) || generation.api !== 'openai' || !isStory(data?.type) || !Array.isArray(data?.messages)) return;
    pending = {...generation, data};
  });
  listen('GENERATION_ENDED', finish);
  listen('GENERATION_STOPPED', () => { pending = null; generation = null; });
  const invalidate = () => { pending = null; generation = null; snapshot = null; };
  listen('CHAT_CHANGED', invalidate);
  listen('MAIN_API_CHANGED', invalidate);
  return {
    info() {
      const available = !closed && same(snapshot);
      return {available: !!available, count: available ? snapshot.messages.length : 0,
        label: '最近一次正文发送快照', ...(available ? {capturedAt: snapshot.capturedAt} : {reason: '请先在当前酒馆聊天发送一次正文，完成后再读取快照'})};
    },
    async build(_ctx, {signal} = {}) {
      if (signal?.aborted) throw Object.assign(Error('助手已停止'), {name: 'AbortError'});
      if (!this.info().available) throw Error(this.info().reason);
      const messages = structuredClone(snapshot.messages);
      return {messages, info: {...this.info(), included: messages.length, total: messages.length, truncated: false}};
    },
    close() { closed = true; pending = null; generation = null; snapshot = null; for (const [event, fn] of listeners) source.removeListener(event, fn); },
  };
}
