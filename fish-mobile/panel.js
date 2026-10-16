import {MobileFishClient, mapFields, buildArguments, errorText} from './client.js';

let client, dialog, observer, button, stopTimer, lastError = '', blobURL = '';
const STYLE = `
#sttts-fish-mobile{box-sizing:border-box;width:min(620px,96vw);max-width:96vw;max-height:90dvh;padding:20px;border:1px solid #777;border-radius:14px;background:var(--SmartThemeBlurTintColor,#202126);color:var(--SmartThemeBodyColor,#eee);overflow:auto;overscroll-behavior:contain;text-align:left;z-index:100000;}
#sttts-fish-mobile::backdrop{background:#0009}#sttts-fish-mobile *{box-sizing:border-box}
#sttts-fish-mobile header{display:flex;justify-content:space-between;align-items:center;gap:8px}#sttts-fish-mobile h2{font-size:20px;margin:0}#sttts-fish-mobile h3{font-size:16px;margin:20px 0 8px}
#sttts-fish-mobile label{display:block;margin:10px 0}#sttts-fish-mobile input,#sttts-fish-mobile textarea,#sttts-fish-mobile select{display:block;width:100%;padding:9px;font-size:16px;border:1px solid #777;border-radius:6px;background:var(--SmartThemeBlurTintColor,#202126);color:inherit;}
#sttts-fish-mobile button{padding:9px 12px;margin:4px 4px 4px 0;min-height:42px;font:inherit;border:1px solid #888;border-radius:6px;background:var(--SmartThemeBlurTintColor,#282a31);color:inherit;cursor:pointer}#sttts-fish-mobile button:disabled{opacity:.5}
#sttts-fish-mobile p,#sttts-fish-mobile summary{line-height:1.5}#sttts-fish-mobile .fm-note{font-size:13px;opacity:.85}#sttts-fish-mobile [data-fm=status]{white-space:pre-wrap;border-left:3px solid #888;padding:10px}#sttts-fish-mobile pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:230px;overflow:auto;font-size:12px}#sttts-fish-mobile audio{width:100%;margin-top:10px}
`;
const getClient = () => client ??= new MobileFishClient();
async function copy(text, doc) {
  try { await doc.defaultView.navigator.clipboard.writeText(text); return; } catch {}
  const box = doc.createElement('textarea'); box.value = text; doc.body.append(box); box.select();
  const ok = doc.execCommand('copy'); box.remove(); if (!ok) throw new Error('Clipboard unavailable');
}
export function openMobilePanel(doc = document) {
  if (dialog?.isConnected) { dialog.focus(); return; }
  let c; try { c = getClient(); } catch (e) { globalThis.toastr?.error(errorText(e)); return; }
  if (!doc.getElementById('sttts-fish-mobile-style')) { const style = doc.createElement('style'); style.id = 'sttts-fish-mobile-style'; style.textContent = STYLE; doc.head.append(style); }
  const d = doc.createElement('dialog'); dialog = d; d.id = 'sttts-fish-mobile'; d.setAttribute('aria-label', 'Fish MCP iPhone 直连实验');
  d.innerHTML = `<header><h2>Fish · iPhone 直连实验</h2><button data-fm="close" aria-label="关闭">关闭</button></header>
<p class="fm-note">手机端 OAuth + MCP 实验 v0.1.1。不运行 Node、不需要电脑或自建中转。是否能连接，取决于实际 Fish 授权策略和 WebView 网络能力。</p>
<p data-fm="status" role="status" aria-live="polite"></p>
<h3>1. 生成登录链接</h3><details><summary>连接参数（一般不用改）</summary>
<label>MCP 地址<input data-fm="endpoint" type="url" autocomplete="off"></label><label>注册的回调地址<input data-fm="redirect" type="url" autocomplete="off"></label>
<label>Client ID（留空自动注册）<input data-fm="client" autocomplete="off"></label><label>Scope（可留空）<input data-fm="scope" autocomplete="off"></label>
<p class="fm-note">只填写你信任的服务；HTTP 是明文。更改连接参数会清除旧授权。这里的回调地址只是注册给 Fish 的目标，不会在手机上启动监听服务。</p></details>
<button data-fm="login">生成登录链接</button><label>登录链接<input data-fm="link" readonly aria-label="登录链接"></label>
<button data-fm="copy-link" disabled>复制登录链接</button><button data-fm="open-link" disabled>在浏览器打开</button>
<p class="fm-note">用 Safari 登录并选择 Plus 所在团队。跳转后复制包含 code 和 state 的完整回调 URL。若 Safari 显示无法连接，先查看地址栏；没有回调参数就不能继续。</p>
<h3>2. 粘贴回调</h3><label>完整回调 URL<textarea data-fm="callback" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="http://127.0.0.1:3789/oauth/callback?code=…&state=…"></textarea></label>
<button data-fm="finish">交换令牌</button><p class="fm-note">只能粘贴回发起登录的这个 App；不要把回调、令牌或登录记录发给别人。</p>
<h3>3. 读取真实 MCP 工具</h3><button data-fm="tools">读取工具（不生成语音）</button>
<label>语音合成工具<select data-fm="tool"><option value="">先读取工具</option></select></label>
<details><summary>真实工具 Schema 与参数映射</summary><pre data-fm="schema">尚未读取。</pre>
<label>字段映射（名称 → 实际参数路径）<textarea data-fm="mapping" rows="5" spellcheck="false">{}</textarea></label>
<label>固定参数（服务要求的额外字段）<textarea data-fm="extra" rows="3" spellcheck="false">{}</textarea></label></details>
<h3>4. 单句试听</h3><label>音色 ID<input data-fm="voice" value="default"></label><label>语言<input data-fm="language" value="zh"></label>
<label>模型（留空让服务决定）<input data-fm="model" placeholder="不是 Plus 套餐名"></label><label>情绪（可留空）<input data-fm="emotion"></label>
<label>文字<textarea data-fm="text" rows="3">你好，这是 iPhone 上的 Fish 语音测试。</textarea></label>
<button data-fm="generate">生成试听（消耗套餐积分）</button><audio data-fm="audio" controls hidden></audio>
<p class="fm-note">本页用于先验证登录、MCP 和音频。不会自动替换角色配音设置；原来的 Node 桥接预设仍保留。</p>
<details><summary>诊断与本机授权</summary><button data-fm="diagnostics">复制脱敏诊断</button><button data-fm="unlock">清除未完成生成标记</button><button data-fm="logout">清除本机授权</button>
<p class="fm-note">登录状态保存在这个 App 的网站存储中，不是系统钥匙串；同源扩展脚本可能读到。不会复制进本插件常规设置，也不导出令牌。完整 App 数据备份仍可能包含它。清除本机授权不等于在 Fish 撤销授权。</p></details>`;
  doc.body.append(d);
  const $ = name => d.querySelector(`[data-fm="${name}"]`);
  const message = (text, error = false) => { $('status').textContent = text; if (error) lastError = text; };
  const status = () => { const s = c.status(); message(s.authorized ? '已保存授权。读取工具成功后再试听；登录成功不等于配音成功。' : s.pending ? '已有待完成登录，可继续粘贴这次的回调。' : '尚未授权。先生成登录链接。'); };
  $('endpoint').value = c.config.endpoint; $('redirect').value = c.config.redirectURI; $('client').value = c.config.clientId; $('scope').value = c.config.scope;
  let tools = [], busy = false;
  const on = (name, handler, lock = true) => $(name).addEventListener('click', async () => {
    if (lock && busy) return;
    if (lock) { busy = true; $(name).disabled = true; }
    try { await handler(); } catch (e) { message(errorText(e), true); }
    finally { if (lock) { busy = false; $(name).disabled = false; } }
  });
  function close() { if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = ''; } $('audio').pause(); d.remove(); dialog = null; }
  on('close', close, false); d.addEventListener('cancel', e => { e.preventDefault(); close(); });
  on('login', async () => {
    if ((c.status().pending || c.status().authorized) && !doc.defaultView.confirm('重新开始登录会替换待完成回调；修改连接参数还会清除旧授权。继续？')) return;
    c.configure({endpoint: $('endpoint').value.trim(), redirectURI: $('redirect').value.trim(), clientId: $('client').value.trim(), scope: $('scope').value.trim()});
    $('link').value = ''; $('copy-link').disabled = $('open-link').disabled = true;
    message('正在读取授权元数据并注册客户端，没有提交语音生成。');
    const link = await c.startLogin(); $('link').value = link; $('copy-link').disabled = $('open-link').disabled = false;
    message('登录链接已生成。复制到 Safari 或点击“在浏览器打开”，授权后带回完整回调。');
  });
  on('copy-link', async () => { await copy($('link').value, doc); message('登录链接已复制。'); });
  // A separate user gesture avoids iOS blocking a window opened after await.
  on('open-link', () => { doc.defaultView.open($('link').value, '_blank', 'noopener,noreferrer'); message('已请求系统打开链接。若没有打开，请复制链接到 Safari。'); }, false);
  on('finish', async () => { const callback = $('callback').value; $('callback').value = ''; message('正在交换令牌；未自动重试。'); await c.finishLogin(callback); $('link').value = ''; $('copy-link').disabled = $('open-link').disabled = true; status(); });
  function selected() {
    const t = tools.find(t => t.name === $('tool').value);
    $('schema').textContent = t ? JSON.stringify(t.inputSchema || {}, null, 2) : '请选择真实语音合成工具。';
    $('mapping').value = JSON.stringify(t ? mapFields(t) : {}, null, 2);
  }
  $('tool').addEventListener('change', selected);
  on('tools', async () => {
    message('正在读取真实 tools/list，没有调用生成工具。'); tools = await c.listTools();
    $('tool').replaceChildren(new Option('选择语音合成工具', ''));
    for (const t of tools) { if (typeof t.name === 'string') $('tool').append(new Option(t.name, t.name)); }
    const candidates = tools.filter(t => /tts|text.to.speech|generate.speech|synthesize.speech/i.test(t.name || '') && !/list|search|delete|clone|history|status|estimate/i.test(t.name));
    if (candidates.length === 1) $('tool').value = candidates[0].name;
    selected(); message(`MCP 已连接，读到 ${tools.length} 个真实工具。请选择语音合成工具后试听。`);
  });
  on('generate', async () => {
    const name = $('tool').value; if (!name) { message('先选择真实语音合成工具。', true); return; }
    let mapping, extra; try { mapping = JSON.parse($('mapping').value); extra = JSON.parse($('extra').value); } catch { message('字段映射或固定参数不是有效 JSON。', true); return; }
    const args = buildArguments({text: $('text').value, voice: $('voice').value, language: $('language').value, model: $('model').value, emotion: $('emotion').value}, mapping, extra);
    message('正在请求语音；失败或超时不会自动重复生成。');
    const audio = await c.generate(name, args); if (!d.isConnected) return; const player = $('audio');
    if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = ''; }
    if (audio.url) player.src = audio.url;
    else {
      if (audio.base64.length > 44 * 1024 * 1024) throw new Error('Audio too large');
      const bytes = Uint8Array.from(atob(audio.base64), c => c.charCodeAt(0));
      blobURL = URL.createObjectURL(new Blob([bytes], {type: audio.mime})); player.src = blobURL;
    }
    player.hidden = false; player.load(); message('已取得音频结果。点播放器确认能否出声；套餐扣费请到 Fish 团队后台核对。');
  });
  $('audio').addEventListener('error', () => message('音频播放：浏览器无法获取或解码音频；没有把拿到链接当作已经播出。', true));
  on('unlock', () => { if (doc.defaultView.confirm('上一笔请求可能已执行并扣费。先核对 Fish 历史；清除标记后再次生成可能重复扣费。继续？')) { c.forgetPendingGeneration(); message('已清除标记；没有自动生成。'); } });
  on('logout', () => { if (doc.defaultView.confirm('清除这台设备里的 Fish 登录状态？不删除角色和聊天记录。')) { c.logout(); tools = []; $('tool').replaceChildren(new Option('先读取工具', '')); selected(); status(); } });
  on('diagnostics', async () => { const report = {version: 'fish-mobile/0.1.0', tauriHost: !!globalThis.__TAURITAVERN__, webCrypto: !!globalThis.crypto?.subtle, state: c.status(), stageError: lastError, toolNames: tools.map(t => t.name)}; await copy(JSON.stringify(report, null, 2), doc); message('已复制脱敏诊断，不含令牌、回调、登录链接和试听文字。'); });
  status();
  try { d.showModal(); } catch { d.setAttribute('open', ''); }
}
export function installMobilePanel(doc = document) {
  if (button?.isConnected || observer) return;
  const mount = () => {
    const target = doc.querySelector('#sttts-extension-entry .inline-drawer-content');
    if (!target || button?.isConnected) return false;
    button = doc.createElement('button'); button.id = 'sttts-fish-mobile-open'; button.className = 'menu_button'; button.type = 'button'; button.textContent = 'Fish iPhone 直连实验';
    button.addEventListener('click', () => openMobilePanel(doc)); target.append(button);
    observer?.disconnect(); observer = null; clearTimeout(stopTimer); return true;
  };
  if (!mount()) {
    observer = new MutationObserver(mount); observer.observe(doc.documentElement, {childList: true, subtree: true});
    stopTimer = setTimeout(() => { observer?.disconnect(); observer = null; }, 30000);
  }
}
export function removeMobilePanel() {
  observer?.disconnect(); observer = null; clearTimeout(stopTimer); button?.remove(); button = null;
  if (dialog) { dialog.querySelector('audio')?.pause(); dialog.remove(); dialog = null; }
  if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = ''; }
}
