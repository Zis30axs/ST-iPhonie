import {createView, esc, btn, heading, field, select, toggle, copyText} from './common.js';
import {ASSISTANT_FILE_ACCEPT} from '../assistant-files.js';
import {assistantAttachments, assistantThoughts} from '../core/assistant.js';
import {icon, glyph} from './icons.js';

// Model HTML never enters the phone document. The preview has an opaque origin;
// scripts can manipulate their own document, but cannot access the host or make API requests.
export function assistantPreviewDocument(html) {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{color-scheme:light}body{margin:12px;font:14px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img,video,canvas,svg{max-width:100%}button,input,textarea,select{font:inherit}pre{white-space:pre-wrap}</style></head><body>${String(html)}</body></html>`;
}

/** Keep every part of a mixed reply; only explicitly labelled HTML fences become previews. */
export function assistantParts(text) {
  const value = String(text || ''), parts = [];
  const fences = /```([^\n`]*)\n([\s\S]*?)```/g;
  let at = 0, match;
  while ((match = fences.exec(value))) {
    if (match.index > at) parts.push({kind: 'text', text: value.slice(at, match.index)});
    parts.push({kind: /^html?$/i.test(match[1].trim()) ? 'html' : 'code', language: match[1].trim(), text: match[2]});
    at = fences.lastIndex;
  }
  if (at < value.length) parts.push({kind: 'text', text: value.slice(at)});
  if (!parts.length) parts.push({kind: 'text', text: value});
  // Raw fragments/documents work too; unknown tags such as <tts> stay plain text.
  for (const part of parts) if (part.kind === 'text' && /<(?:!doctype\s+html|html|head|body|div|section|article|button|script|style|form|table|canvas|svg|p|span|h[1-6]|ul|ol|details|a|img)\b/i.test(part.text)) part.kind = 'html';
  return parts;
}

export function assistantVoiceLines(api, text) {
  return assistantParts(assistantThoughts(text).text).flatMap(part => partVoiceLines(api, part));
}

function partVoiceLines(api, part) {
  if (part.kind === 'code' && !/^(?:tts|text|plaintext)?$/i.test(part.language)) return [];
  // Mask non-dialogue HTML without changing offsets. Generated HTML always stays in the iframe.
  const sample = part.kind === 'html' ? part.text.replace(/<!--[^]*?(?:-->|$)|<(script|style)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi, value => ' '.repeat(value.length)) : part.text;
  let lines; try { lines = api.parse(sample)?.lines || []; } catch { return []; }
  let end = 0;
  return [...lines].sort((a, b) => a.start - b.start).filter(line => {
    if (!Number.isInteger(line.start) || !Number.isInteger(line.end) || line.start < end || line.end <= line.start || line.end > sample.length) return false;
    end = line.end; return true;
  });
}

/** A small, escaped Markdown renderer: no generated links/images or raw tags in the parent. */
function prose(text) {
  return esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<strong class="assistant-subheading">$1</strong>')
    .replace(/^[ \t]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '<hr>').replace(/\n*<hr>\n*/g, '<hr>');
}

/** Use parser offsets rather than a tag regex, so custom dialogue formats render too. */
function inlineDialogue(part, lines, attrs, offset) {
  const utterance = (line, i) => `<span class="assistant-utterance">“${esc(line.translation || line.text)}”<button type="button" class="assistant-wave" data-action="voice-line" ${attrs} data-line="${offset + i}" aria-label="朗读 ${esc(line.role || '旁白')} 的台词" title="朗读 ${esc(line.role || '旁白')} 的台词"><span aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></button></span>`;
  if (part.kind === 'html') return lines.map(utterance).join('\n');
  let out = '', at = 0;
  lines.forEach((line, i) => { out += prose(part.text.slice(at, line.start)) + utterance(line, i); at = line.end; });
  return out + prose(part.text.slice(at));
}

export function assistantApp(ctx) {
  const {api, win} = ctx, v = createView(ctx, 'assistant');
  let mode = 'chat', threadId = null, thread = null, epoch = 0, selectionEpoch = 0, presetsEpoch = 0, settings = null;
  let tavern = [], tavernLoading = false, tavernError = '', settingsSaving = false;
  let renderedThreadId = null, renderedMessages = new Map(), renameId = null, editing = null;
  const fileDrafts = new Map(), fileReads = new Set(), displayCache = new Map();
  const attachments = (id = threadId) => fileDrafts.get(id) || [];
  const drafts = new Map(), errors = new Map(), pending = new Map(), previews = new Set();
  const state = () => api.getState().assistant || {};
  const busy = id => pending.has(id) || !!api.assistantBusy?.(id);
  function closePreviews() {
    previews.clear();
    for (const slot of v.root.querySelectorAll('[data-preview-mid]')) slot.remove();
    for (const button of v.root.querySelectorAll('[data-action=preview]')) { button.setAttribute('aria-expanded', 'false'); button.innerHTML = icon('eye') + '预览'; }
  }
  const draftKey = id => `st-iphonie-assistant-draft:${api.getState().scope || 'local'}:${id || 'new'}`;
  function draft(id = threadId) {
    if (!drafts.has(id)) { let saved = ''; try { saved = win.sessionStorage.getItem(draftKey(id)) || ''; } catch {} drafts.set(id, saved); }
    return drafts.get(id);
  }
  function saveDraft(value, id = threadId) {
    drafts.set(id, value);
    try { if (value) win.sessionStorage.setItem(draftKey(id), value); else win.sessionStorage.removeItem(draftKey(id)); } catch { /* still retained while the phone is open */ }
  }
  function contextCopy(s = state()) {
    if (!s.readContext) return '不读取正文上下文';
    const c = api.assistantContext?.();
    return c?.available ? c.label || '最近一次正文发送快照' : c?.reason || '请先在当前酒馆聊天发送一次正文，完成后再读取快照。';
  }
  function attachmentHTML(files, removable = false) {
    return files.length ? `<div class="assistant-attachments">${files.map((file, i) => `<div class="assistant-attachment">${file.kind === 'image' ? `<img src="${esc(file.data)}" alt="${esc(file.name)}" loading="lazy">` : icon('book')}<span>${esc(file.name)}</span>${removable ? btn('remove-file', icon('close'), 'icon-button', `data-file="${i}" aria-label="移除附件 ${esc(file.name)}"`) : ''}</div>`).join('')}</div>` : '';
  }
  function replyInfo(m) {
    const meta = m.meta || {}, reported = meta.reportedModel?.trim(), model = reported || meta.requestedModel?.trim();
    return `${Number.isFinite(meta.elapsedMs) ? `<span class="assistant-elapsed">· ${(meta.elapsedMs / 1000).toFixed(1)}s</span>` : ''}${model ? `<span class="assistant-model" title="${esc((reported ? '接口报告模型：' : '请求模型：') + model)}">· ${esc(model)}</span>` : ''}`;
  }
  function resizeComposer() {
    const box = v.root.querySelector('[data-assistant-draft]');
    if (!box) return;
    const messages = v.root.querySelector('.assistant-messages'), bottom = messages && messages.scrollHeight - messages.clientHeight - messages.scrollTop < 70;
    const scroll = box.scrollTop, style = win.getComputedStyle(box);
    const minimum = parseFloat(style.minHeight) || 36, maximum = parseFloat(style.maxHeight) || 116;
    const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    box.style.height = 'auto';
    const needed = box.scrollHeight + border;
    box.style.height = `${Math.min(maximum, Math.max(minimum, needed))}px`;
    box.style.overflowY = needed > maximum ? 'auto' : 'hidden'; box.scrollTop = scroll;
    if (bottom) messages.scrollTop = messages.scrollHeight;
  }
  let composerWidth = 0;
  const composerObserver = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width;
    if (width > 0 && width !== composerWidth) { composerWidth = width; resizeComposer(); }
  }) : null;
  composerObserver?.observe(v.root);
  const editingMessage = m => editing?.threadId === threadId && editing.mid === m.id;
  function userBody(m, attrs) {
    if (!editingMessage(m)) return `<div class="assistant-prose">${esc(m.text)}</div>`;
    return `<div class="assistant-edit"><textarea data-edit-message aria-label="编辑已发送消息" rows="3" maxlength="100000" ${editing.saving ? 'disabled' : ''}>${esc(editing.text)}</textarea><div class="assistant-message-tools">${btn('save-edit', editing.saving ? '保存中' : '保存', 'text-button', `${attrs} ${editing.saving ? 'disabled' : ''}`)}${btn('cancel-edit', '取消', 'text-button', `${attrs} ${editing.saving ? 'disabled' : ''}`)}</div></div>`;
  }
  function displayText(m) {
    const text = m.role === 'assistant' ? assistantThoughts(m.text).text : m.text;
    const depth = Math.max(0, (thread?.messages.length || 1) - 1 - (thread?.messages.findIndex(row => row.id === m.id) ?? 0));
    const key = JSON.stringify([threadId, m.id, m.text, m.role, depth]);
    if (displayCache.get(m.id)?.key !== key) displayCache.set(m.id, {key, text: api.assistantDisplay ? api.assistantDisplay(text, m.role, depth) : text});
    return displayCache.get(m.id).text;
  }
  function messageHTML(m, index, messages) {
    const attrs = `data-mid="${esc(m.id)}"`;
    if (m.role === 'user') return `<article class="assistant-message is-user" ${attrs}>${messages?.[index - 1]?.role === 'user' ? '' : '<span class="assistant-who">我</span>'}<div class="assistant-bubble">${userBody(m, attrs)}${attachmentHTML(m.attachments || [])}</div><details class="assistant-actions" data-group="actions-${esc(m.id)}"><summary aria-label="消息操作" title="消息操作">${icon('more')}</summary><div class="assistant-message-tools">${btn('copy', icon('copy') + '复制原文', 'text-button', attrs)}${btn('edit-message', icon('edit') + '编辑', 'text-button', attrs)}${btn('delete-message', icon('trash') + '删除', 'text-button', attrs)}</div></details></article>`;
    const visible = displayText(m), thoughts = assistantThoughts(m.text), reasoning = [m.meta?.reasoning?.trim(), thoughts.reasoning].filter(Boolean).filter((value, i, all) => all.indexOf(value) === i).join('\n\n');
    const parts = assistantParts(visible), lines = assistantVoiceLines(api, visible); let offset = 0;
    return `<article class="assistant-message" ${attrs}><span class="assistant-who">${icon('star')}助手${replyInfo(m)}</span><div class="assistant-bubble">${reasoning ? `<details class="assistant-reasoning" data-group="reasoning-${esc(m.id)}"><summary>思考内容</summary><div class="assistant-prose">${esc(reasoning)}</div></details>` : ''}${parts.map((p, i) => {
      const spoken = partVoiceLines(api, p), rendered = inlineDialogue(p, spoken, attrs, offset); offset += spoken.length;
      if (p.kind === 'text') return `<div class="assistant-prose">${rendered}</div>`;
      if (p.kind === 'code') {
        return spoken.length ? `<div class="assistant-prose">${rendered}</div>` : `<pre class="assistant-code"><code>${esc(p.text)}</code></pre>`;
      }
      const key = `${m.id}:${i}`, shown = previews.has(key);
      return `<div class="assistant-html"><div class="assistant-html-tools"><span>HTML · 可交互</span>${btn('preview', shown ? '收起预览' : icon('eye') + '预览', 'text-button', `${attrs} data-part="${i}" aria-expanded="${shown}"`)}</div>${shown ? `<div data-preview-mid="${esc(m.id)}" data-preview-part="${i}"></div>` : ''}<details data-group="source-${esc(key)}"><summary>查看源码</summary><pre class="assistant-code"><code>${esc(p.text)}</code></pre></details></div>${spoken.length ? `<div class="assistant-prose">${rendered}</div>` : ''}`;
    }).join('')}</div><details class="assistant-actions" data-group="actions-${esc(m.id)}"><summary aria-label="消息操作" title="消息操作">${icon('more')}</summary><div class="assistant-message-tools">${lines.length ? btn('voice-all', icon('wave') + '整条播放', 'text-button', attrs) : ''}${btn('copy', icon('copy') + '复制原文', 'text-button', attrs)}${btn('reroll', icon('refresh') + '重 roll', 'text-button', attrs)}${btn('delete-message', icon('trash') + '删除', 'text-button', attrs)}</div></details>${(m.variants?.length || 1) > 1 ? `<div class="assistant-variants">${btn('variant', '‹', 'icon-button', `${attrs} data-selected="${(m.selected || 0) - 1}" aria-label="上一个回复" ${m.selected > 0 ? '' : 'disabled'}`)}<span>${(m.selected || 0) + 1} / ${m.variants.length}</span>${btn('variant', '›', 'icon-button', `${attrs} data-selected="${(m.selected || 0) + 1}" aria-label="下一个回复" ${(m.selected || 0) < m.variants.length - 1 ? '' : 'disabled'}`)}</div>` : ''}</article>`;
  }
  function mountPreviews() {
    for (const slot of v.root.querySelectorAll('[data-preview-mid]')) {
      if (slot.querySelector('iframe') || !previews.has(`${slot.dataset.previewMid}:${slot.dataset.previewPart}`)) continue;
      const message = thread?.messages.find(m => m.id === slot.dataset.previewMid);
      const part = message && assistantParts(displayText(message))[Number(slot.dataset.previewPart)];
      if (message?.role !== 'assistant' || part?.kind !== 'html') continue;
      const frame = ctx.doc.createElement('iframe');
      frame.className = 'assistant-preview'; frame.title = '助手 HTML 交互预览';
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; autoplay 'none'");
      frame.srcdoc = assistantPreviewDocument(part.text); slot.append(frame);
    }
  }
  const messageKey = (m, i, list) => JSON.stringify([m.role, m.text, m.role === 'assistant' ? displayText(m) : '', m.meta, m.selected, m.variants?.length, list[i - 1]?.role, editingMessage(m), editingMessage(m) && editing.saving]);
  function patchChat(html, list) {
    const previous = v.root.querySelector('.assistant-chat');
    if (!previous || renderedThreadId !== threadId) v.draw(html);
    else {
      const template = ctx.doc.createElement('template'); template.innerHTML = html;
      const incoming = template.content.querySelector('.assistant-chat');
      previous.querySelector('.assistant-context').replaceChildren(...incoming.querySelector('.assistant-context').childNodes);
      const target = previous.querySelector('.assistant-messages'), wanted = new Set();
      const key = el => el.dataset.mid ? `message:${el.dataset.mid}` : el.className;
      const existing = new Map([...target.children].map(el => [key(el), el]));
      const messages = new Map(list.map((m, i) => [m.id, messageKey(m, i, list)]));
      const children = [...incoming.querySelector('.assistant-messages').children], keys = new Set(children.map(key));
      for (const child of [...target.children]) if (!keys.has(key(child))) child.remove();
      let index = 0;
      for (const fresh of children) {
        const old = existing.get(key(fresh)), before = renderedMessages.get(fresh.dataset.mid), now = messages.get(fresh.dataset.mid);
        const unchanged = fresh.dataset.mid ? before && now && before === now : old?.innerHTML === fresh.innerHTML;
        const node = old && unchanged ? old : fresh;
        if (old && !unchanged) old.replaceWith(fresh);
        // Existing message nodes stay attached, including their iframe browsing contexts.
        // Appending a reply or changing the busy indicator must not replay an HTML script.
        if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null);
        wanted.add(node); index++;
      }
      for (const child of [...target.children]) if (!wanted.has(child)) child.remove();
      const composer = previous.querySelector('.assistant-composer'), nextComposer = incoming.querySelector('.assistant-composer');
      const tray = composer.querySelector('[data-attachment-tray]'), nextTray = nextComposer.querySelector('[data-attachment-tray]');
      if (tray.innerHTML !== nextTray.innerHTML) tray.replaceChildren(...nextTray.childNodes);
      composer.querySelector('[data-action=attach]').disabled = nextComposer.querySelector('[data-action=attach]').disabled;
      const box = composer.querySelector('textarea'); if (box.value !== draft()) box.value = draft();
      const button = composer.querySelector('.assistant-send'), nextButton = nextComposer.querySelector('.assistant-send');
      if (button.outerHTML === nextButton.outerHTML) button.disabled = nextButton.disabled;
      else button.replaceWith(nextButton);
    }
    renderedThreadId = threadId; renderedMessages = new Map(list.map((m, i) => [m.id, messageKey(m, i, list)]));
  }
  function drawChat() {
    const waiting = busy(threadId), saving = pending.get(threadId)?.kind === 'save', list = thread?.messages || [], error = errors.get(threadId), last = list.at(-1);
    for (const [i, m] of list.entries()) {
      const before = renderedMessages.get(m.id);
      if (before && before !== messageKey(m, i, list)) for (const key of previews) if (key.startsWith(m.id + ':')) previews.delete(key);
    }
    const previous = v.root.querySelector('[data-assistant-draft]'), focused = previous === ctx.doc.activeElement;
    const selection = focused ? [previous.selectionStart, previous.selectionEnd] : null;
    const scroller = v.root.querySelector('.assistant-messages'), bottom = !scroller || scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 70;
    v.root.classList.add('assistant-chat-mode');
    patchChat(`<div class="assistant-chat"><header class="assistant-header"><div><span class="eyebrow">Assistant</span><h1>助手</h1></div><div class="heading-actions">${btn('threads', icon('layers'), 'round-button', 'aria-label="会话记录"')}${btn('new', icon('add'), 'round-button', 'aria-label="新建会话"')}${btn('settings', icon('sliders'), 'round-button', 'aria-label="助手设置"')}</div></header><div class="assistant-context">${icon(state().readContext ? 'book' : 'bubble')}<span>${esc(contextCopy())}</span></div><div class="assistant-messages" data-keep-scroll="assistant-messages" aria-label="助手对话" role="log">${list.length ? `<p class="assistant-conversation-title">${esc(thread.title || '当前会话')}</p>` + list.map(messageHTML).join('') : `<div class="assistant-welcome"><span class="assistant-mascot">${glyph('assistant')}</span><h2>陪你聊聊，帮你想想</h2></div>`}${waiting ? `<div class="assistant-wait" role="status"><i></i><span>${saving ? '正在发送……' : '助手正在想……'}</span></div>` : ''}${error ? `<p class="assistant-error" role="alert">${esc(error)}</p>` : ''}${!waiting && error && last?.role === 'user' ? `<div class="assistant-retry">${btn('retry', icon('refresh') + '重新回复', 'secondary small')}</div>` : ''}</div><div class="assistant-composer"><div data-attachment-tray>${attachmentHTML(attachments(), true)}${fileReads.has(threadId) ? '<span class="hint">正在读取附件……</span>' : ''}</div><input type="file" data-assistant-files accept="${ASSISTANT_FILE_ACCEPT}" multiple hidden>${btn('attach', icon('add'), 'assistant-attach', `aria-label="附加文件" ${fileReads.has(threadId) || pending.get(threadId)?.kind === 'save' ? 'disabled' : ''}`)}<textarea data-assistant-draft aria-label="发给助手的消息" placeholder="想说点什么……" rows="1">${esc(draft())}</textarea>${waiting ? btn('cancel', icon('stop'), 'assistant-send', 'aria-label="停止回复"') : sendButton()}</div></div>`, list);
    mountPreviews(); resizeComposer();
    for (const button of v.root.querySelectorAll('[data-action=reroll],[data-action=delete-message],[data-action=edit-message]')) button.disabled = waiting;
    const editSave = v.root.querySelector('[data-action=save-edit]'); if (editSave) editSave.disabled = waiting || !!editing?.saving;
    const next = v.root.querySelector('.assistant-messages'); if (bottom) next.scrollTop = next.scrollHeight;
    if (focused) { const box = v.root.querySelector('[data-assistant-draft]'); box.focus({preventScroll: true}); box.setSelectionRange(...selection); }
  }
  async function render() {
    if (v.disposed) return;
    const ticket = ++epoch, id = threadId, currentMode = mode;
    if (mode === 'settings') { drawSettings(); return; }
    if (mode === 'threads') {
      const rows = await api.assistantThreads();
      if (v.disposed || ticket !== epoch || currentMode !== mode) return;
      v.root.classList.remove('assistant-chat-mode');
      v.draw(heading('会话记录', btn('new', icon('add'), 'round-button', 'aria-label="新建会话"'), 'Assistant') + `<div class="group">${rows.length ? rows.map(r => `<div class="assistant-thread-row">${renameId === r.id ? `<div class="assistant-rename"><input data-thread-title value="${esc(r.title)}" maxlength="80" aria-label="会话名字">${btn('save-title', '保存', 'text-button', `data-id="${esc(r.id)}"`)}${btn('cancel-title', '取消', 'text-button')}</div>` : `<button data-action="thread" data-id="${esc(r.id)}"><strong>${esc(r.title || '新会话')}</strong><small>${esc(r.preview || `${r.messageCount || 0} 条消息`)}</small></button>${btn('rename-thread', icon('edit'), 'icon-button', `data-id="${esc(r.id)}" aria-label="修改会话名字"`)}`}${btn('delete-thread', icon('trash'), 'icon-button', `data-id="${esc(r.id)}" aria-label="删除会话 ${esc(r.title || '新会话')}"`)}</div>`).join('') : '<p class="hint">还没有会话。和助手说第一句话吧。</p>'}</div>`);
      return;
    }
    const row = id ? await api.assistantThread(id) : null;
    if (v.disposed || ticket !== epoch || id !== threadId || currentMode !== mode) return;
    if (id && !row) threadId = null;
    if (renderedThreadId !== threadId) displayCache.clear();
    thread = row; drawChat();
  }
  function drawSettings() {
    const s = settings || state(), built = s.presets?.find(p => p.id === s.activePreset), external = tavern.find(p => p.id === s.tavernPreset);
    const entries = s.source === 'tavern' ? external?.entries || [] : built?.entries || [];
    v.root.classList.remove('assistant-chat-mode');
    v.draw(heading('助手设置', btn('save-settings', settingsSaving ? '保存中' : '完成', 'primary small', settingsSaving ? 'disabled' : ''), 'Assistant') + `<p class="hint">这里的选择只用于助手。</p><div class="group">${field('预设来源', select('source', s.source, [['builtin', '默认助手'], ['tavern', '酒馆预设']]))}${s.source === 'tavern' ? field('酒馆预设', select('tavernPreset', s.tavernPreset, [['', '选择一个预设'], ...tavern.map(p => [p.id, p.name])])) : ''}${toggle('readContext', '读取正文上下文', s.readContext)}${s.readContext ? `<p class="hint">${esc(contextCopy(s))}</p><p class="hint">使用最近一次正文请求的完整快照，保留当次正则、预设与注入；不含随后生成的回复。刷新或切换正文后，请先发送一次正文。</p>` : '<p class="hint">只带助手提示词和这个会话，不读取正文。</p>'}</div>${s.source === 'tavern' && tavernLoading ? '<p class="hint" role="status">正在读取酒馆预设……</p>' : ''}${s.source === 'tavern' && tavernError ? `<p class="assistant-error" role="alert">${esc(tavernError)}</p>${btn('reload-presets', '重新读取', 'secondary small')}` : ''}<div class="group-title"><span>${s.source === 'tavern' ? '预设条目' : '助手提示词'}</span><small>${entries.length} 条</small></div><div class="assistant-entries">${entries.map(entry => {
      const enabled = s.source === 'tavern' ? s.tavernEntries?.[s.tavernPreset]?.[entry.id] ?? entry.enabled !== false : entry.enabled !== false;
      return `<details class="group assistant-entry" data-group="entry-${esc(entry.id)}"><summary><span>${esc(entry.title || entry.id)}${entry.marker ? '<small> · 上下文位置</small>' : ''}</span><input class="switch" type="checkbox" data-entry="${esc(entry.id)}" aria-label="启用 ${esc(entry.title || entry.id)}" ${enabled ? 'checked' : ''}></summary>${s.source === 'builtin' ? `<textarea data-entry-text="${esc(entry.id)}" aria-label="${esc(entry.title || entry.id)}的内容" rows="6">${esc(entry.text)}</textarea>` : `<pre class="assistant-code">${esc(entry.text || (entry.marker ? '正文快照完整保留当次发送内容，不由此处的条目开关裁剪。' : '这个条目没有文字内容。'))}</pre>`}</details>`;
    }).join('')}</div>`);
  }
  async function loadPresets() {
    const ticket = ++presetsEpoch; tavernLoading = true; tavernError = '';
    if (mode === 'settings') drawSettings();
    try { const result = await api.assistantPresets?.(); if (ticket === presetsEpoch) tavern = result || []; }
    catch (error) { if (ticket === presetsEpoch) tavernError = error.message; }
    finally { if (ticket === presetsEpoch) { tavernLoading = false; if (!v.disposed && mode === 'settings') drawSettings(); } }
  }
  function sendButton() {
    const writing = !!draft().trim() || attachments().length > 0, ready = !fileReads.has(threadId) && (writing || thread?.messages.at(-1)?.role === 'user');
    const label = writing ? '发送消息' : '让助手回复';
    return btn('send', icon(writing ? 'send' : 'bubble'), 'assistant-send', `aria-label="${label}" title="${label}" ${ready ? '' : 'disabled'}`);
  }
  async function send(retry = false) {
    if (busy(threadId) || fileReads.has(threadId)) return;
    const files = retry ? [] : attachments();
    const text = retry ? '' : draft().trim();
    if (!text && !files.length && (!threadId || thread?.messages.at(-1)?.role !== 'user')) return;
    // Lock before the first await: double Enter cannot create/send two conversations.
    const originalId = threadId, selected = selectionEpoch, job = {cancelled: false, kind: text || files.length ? 'save' : 'reply'}; pending.set(originalId, job);
    if (!retry) { saveDraft('', originalId); fileDrafts.delete(originalId); }
    drawChat();
    let id = originalId;
    try {
      if (!id) {
        const row = await api.newAssistantThread(); id = row.id; pending.set(id, job);
        if (pending.get(originalId) === job) pending.delete(originalId);
        if (threadId === originalId && selected === selectionEpoch) { threadId = id; thread = row; saveDraft(draft(originalId), id); saveDraft('', originalId); if (attachments(originalId).length) { fileDrafts.set(id, attachments(originalId)); fileDrafts.delete(originalId); } }
      }
      errors.delete(id); await render();
      if (job.cancelled) throw Object.assign(Error('已取消助手回复'), {name: 'AbortError'});
      if (text || files.length) {
        const current = await api.assistantThread(id);
        if (!current || current.messages.length >= 499) throw Error('这段助手对话已满，请新建对话后继续');
        if (job.cancelled) throw Object.assign(Error('已取消发送'), {name: 'AbortError'});
        await api.appendAssistantMessage(id, {role: 'user', text, attachments: files});
        job.saved = true;
      } else await api.assistantReply(id);
    } catch (error) {
      if (error?.name !== 'AbortError') errors.set(id, error.message || '回复没有完成，请重试。');
      // If generation failed before saving the user message, put the unsent text back.
      if (!job.saved) {
        if (text && !draft(id)) saveDraft(text, id);
        if (files.length) fileDrafts.set(id, [...files, ...attachments(id)]);
      }
    } finally { for (const key of [originalId, id]) if (pending.get(key) === job) pending.delete(key); if (!v.disposed) await render(); }
  }
  async function reroll(message) {
    if (!message || busy(threadId)) return;
    closePreviews();
    const id = threadId, job = {kind: 'reply'}; pending.set(id, job); errors.delete(id); drawChat();
    try { await api.assistantReroll(id, message.id); }
    catch (error) { if (error.name !== 'AbortError') errors.set(id, error.message); }
    finally { if (pending.get(id) === job) pending.delete(id); if (!v.disposed) await render(); }
  }
  v.on('change', '[data-assistant-files]', async el => {
    const id = threadId, files = [...el.files]; el.value = '';
    if (!files.length || fileReads.has(id) || pending.get(id)?.kind === 'save') return;
    fileReads.add(id); drawChat();
    try { const added = await api.assistantReadFiles(files); if (!v.disposed) fileDrafts.set(id, assistantAttachments([...attachments(id), ...added])); }
    finally { fileReads.delete(id); if (!v.disposed && mode === 'chat') drawChat(); }
  });
  v.on('input', '[data-edit-message]', el => { if (editing?.threadId === threadId) editing.text = el.value; });
  v.on('input', '[data-assistant-draft]', el => {
    saveDraft(el.value); resizeComposer(); const button = v.root.querySelector('[data-action=send]'); if (button) { const template = ctx.doc.createElement('template'); template.innerHTML = sendButton(); button.replaceWith(template.content.firstElementChild); }
  });
  v.on('keydown', '[data-assistant-draft]', (el, event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); return send(); }
  });
  v.on('input', '[data-entry-text]', el => {
    const p = settings.presets.find(p => p.id === settings.activePreset), entry = p?.entries.find(e => e.id === el.dataset.entryText);
    if (entry) entry.text = el.value;
  });
  v.on('change', '[data-field],[data-entry]', el => {
    if (!settings) return;
    if (el.dataset.entry) {
      if (settings.source === 'tavern') { settings.tavernEntries ||= {}; settings.tavernEntries[settings.tavernPreset] ||= {}; settings.tavernEntries[settings.tavernPreset][el.dataset.entry] = el.checked; }
      else { const entry = settings.presets.find(p => p.id === settings.activePreset)?.entries.find(e => e.id === el.dataset.entry); if (entry) entry.enabled = el.checked; }
      return;
    }
    settings[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    drawSettings();
    if (el.dataset.field === 'source' && settings.source === 'tavern') return loadPresets();
  });
  v.on('click', '[data-action]', async el => {
    const action = el.dataset.action, message = thread?.messages.find(m => m.id === el.dataset.mid);
    switch (action) {
      case 'attach': v.root.querySelector('[data-assistant-files]').click(); return;
      case 'remove-file': fileDrafts.set(threadId, attachments().filter((_, i) => i !== Number(el.dataset.file))); drawChat(); return;
      case 'reroll': return reroll(message);
      case 'variant': if (message && !busy(threadId)) { closePreviews(); await api.selectAssistantVariant(threadId, message.id, Number(el.dataset.selected)); await render(); } return;
      case 'edit-message':
        if (message?.role !== 'user' || busy(threadId)) return;
        editing = {threadId, mid: message.id, original: message.text, text: message.text, saving: false}; drawChat();
        v.root.querySelector('[data-edit-message]')?.focus(); return;
      case 'cancel-edit': if (!editing?.saving) { editing = null; drawChat(); } return;
      case 'save-edit': {
        const edit = editing;
        if (!edit || edit.threadId !== threadId || edit.saving || busy(threadId)) return;
        edit.saving = true; drawChat();
        try { await api.editAssistantMessage(edit.threadId, edit.mid, edit.text, edit.original); if (editing === edit) editing = null; }
        finally { edit.saving = false; if (!v.disposed) await render(); }
        return;
      }
      case 'delete-message': {
        const id = threadId;
        if (!message || busy(id) || !await ctx.confirm('删除这条消息？', message.role === 'assistant' ? '这条回复的所有版本都会删除。' : '消息和所附文件会一起删除。')) return;
        await api.deleteAssistantMessage(id, message.id); await render(); return;
      }
      case 'rename-thread': renameId = el.dataset.id; return render();
      case 'cancel-title': renameId = null; return render();
      case 'save-title': await api.renameAssistantThread(el.dataset.id, v.root.querySelector('[data-thread-title]').value); renameId = null; return render();
      case 'send': return send();
      case 'retry': return send(true);
      case 'cancel': { const job = pending.get(threadId); if (job) job.cancelled = true; api.assistantCancel?.(threadId); return; }
      case 'threads': closePreviews(); mode = 'threads'; return render();
      case 'thread': closePreviews(); selectionEpoch++; threadId = el.dataset.id; thread = null; mode = 'chat'; return render();
      case 'new': closePreviews(); selectionEpoch++; threadId = null; thread = null; mode = 'chat'; return render();
      case 'delete-thread': {
        const id = el.dataset.id;
        if (!await ctx.confirm('删除这个助手会话？', '会话里的消息会一并删除。')) return;
        api.assistantCancel?.(id); await api.deleteAssistantThread(id); saveDraft('', id); fileDrafts.delete(id); errors.delete(id);
        if (id === threadId) { threadId = null; thread = null; } return render();
      }
      case 'settings': closePreviews(); settings = structuredClone(state()); mode = 'settings'; drawSettings(); return loadPresets();
      case 'reload-presets': return loadPresets();
      case 'save-settings':
        if (settingsSaving) return;
        settingsSaving = true;
        try { await api.saveAssistant(settings); settings = null; mode = 'chat'; await render(); }
        finally { settingsSaving = false; } return;
      case 'preview': {
        if (message?.role !== 'assistant') return;
        const key = `${message.id}:${el.dataset.part}`, block = el.closest('.assistant-html');
        if (previews.has(key)) { previews.delete(key); block.querySelector('[data-preview-mid]')?.remove(); }
        else {
          previews.add(key);
          const slot = ctx.doc.createElement('div'); slot.dataset.previewMid = message.id; slot.dataset.previewPart = el.dataset.part;
          block.querySelector('details').before(slot); mountPreviews();
        }
        el.setAttribute('aria-expanded', String(previews.has(key))); el.innerHTML = previews.has(key) ? '收起预览' : icon('eye') + '预览'; return;
      }
      case 'copy': if (message && await copyText(win, message.text)) ctx.notify('原文已复制'); else ctx.notify('没能复制，请展开源码后手动选取'); return;
      case 'voice-all': if (message?.role === 'assistant') return api.speak(assistantVoiceLines(api, displayText(message))); return;
      case 'voice-line': {
        if (message?.role !== 'assistant') return;
        const line = assistantVoiceLines(api, displayText(message))[Number(el.dataset.line)]; if (line) return api.speak(line); return;
      }
    }
  });
  v.back = () => {
    if (mode === 'settings') { settings = null; mode = 'chat'; render().catch(e => ctx.notify(e.message, {error: true})); return true; }
    if (mode === 'threads') { mode = 'chat'; render().catch(e => ctx.notify(e.message, {error: true})); return true; }
    return false;
  };
  v.refresh = render;
  v.onAssistant = event => { if (mode !== 'settings' && (!event.threadId || event.threadId === threadId || mode === 'threads')) return render(); };
  v.showing = () => threadId;
  v.leave = () => { closePreviews(); displayCache.clear(); };
  const dispose = v.dispose;
  v.dispose = () => { composerObserver?.disconnect(); closePreviews(); displayCache.clear(); dispose(); };
  render().catch(error => ctx.notify(error.message, {error: true}));
  return v;
}
