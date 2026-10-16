const $ = id => document.getElementById(id);
let apiKey = new URLSearchParams(location.hash.slice(1)).get('key') || sessionStorage.getItem('fish-bridge-key') || '';
if (apiKey) sessionStorage.setItem('fish-bridge-key', apiKey);
if (location.hash) history.replaceState(null, '', location.pathname);
$('key').value = apiKey; $('endpoint').value = location.origin + '/v1/audio/speech';
$('template').textContent = JSON.stringify({input: '{{text}}', voice: '{{voice}}', language: '{{lang}}', emotion: '{{emotion}}'}, null, 2);
let audioURL = '';
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
async function call(path, data) {
  const res = await fetch(path, {method: data === undefined ? 'GET' : 'POST',
    headers: {Authorization: 'Bearer ' + apiKey, ...(data === undefined ? {} : {'Content-Type': 'application/json'})},
    ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  if (!res.ok) { const e = await res.json().catch(() => null); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
  return res;
}
function on(id, handler) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await handler(); } catch (e) { message(e.message, true); }
    finally { $(id).disabled = false; }
  });
}
async function refresh() {
  const state = await (await call('/admin/status')).json();
  $('status').textContent = state.authorized ? (state.connected ? '已授权 · MCP 已连接' : '已保存授权 · 尚未检查 MCP') : '尚未授权';
  $('stats').textContent = `排队 ${state.queued} · 音频缓存 ${state.cached} · 待解析结果/任务 ${state.pendingJobs}`;
  if (document.activeElement !== $('config')) $('config').value = JSON.stringify(state.config, null, 2);
  message(state.authorized ? '下一步：读取真实工具，再点击生成试听。保存授权不代表已经生成过音频。' : '先点击登录，在 Fish 官方页面选择 Plus 所在的团队。');
}
on('refresh', refresh);
on('login', async () => { message('正在发现 Fish 官方授权服务…'); const data = await (await call('/admin/login', {})).json(); location.assign(data.url); });
function clearEdgeLogin() { $('edge-login').hidden = true; $('open-edge').removeAttribute('href'); }
on('prepare-edge', async () => {
  clearEdgeLogin(); message('正在准备 Fish 官方授权入口…');
  const data = await (await call('/admin/login', {})).json();
  const url = new URL(data.url);
  if (url.protocol !== 'https:' || !['fish.audio', 'api.fish.audio'].includes(url.hostname) || url.username || url.password)
    throw new Error('授权入口不是可识别的 Fish 官方 HTTPS 地址，已停止打开。');
  $('open-edge').href = 'microsoft-edge:' + url.href;
  $('edge-login').hidden = false;
  message('入口已准备好。请点击“在 Edge 中继续授权”；完成后回到本页点击“刷新状态”。');
});
on('logout', async () => { clearEdgeLogin(); await call('/admin/logout', {}); await refresh(); });
on('tools', async () => {
  message('正在读取真实 MCP 工具，不提交配音…'); const result = await (await call('/admin/tools?refresh=1')).json();
  $('catalog').textContent = JSON.stringify(result.tools, null, 2); $('detected').textContent = JSON.stringify(result.detected, null, 2);
  message(result.detected?.error || '已读取真实工具列表。现在可以手动试听。', !!result.detected?.error);
});
on('save', async () => { await call('/admin/config', JSON.parse($('config').value)); message('配置已保存。尚未提交任何生成请求。'); });
on('copy', async () => { await navigator.clipboard.writeText(apiKey); message('已复制桥接密钥，请填到“自己的接口”。'); });
on('generate', async () => {
  message('已提交试听；不会自动重发生成请求。');
  const res = await call('/v1/audio/speech', {input: $('text').value, voice: $('voice').value, language: $('language').value, model: $('model').value, emotion: $('emotion').value});
  const blob = await res.blob(); if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(blob); $('audio').src = audioURL; $('audio').hidden = false;
  $('audio-info').textContent = `${blob.type} · ${(blob.size / 1024).toFixed(1)} KiB · ${res.headers.get('x-bridge-cache') === 'hit' ? '来自缓存' : '首次生成'}。可点击播放试听。`;
  message('已收到并识别音频。是否确实扣除赠送 Plus 的额度，请在 Fish 所选团队中核对。');
});
if (!apiKey) message('请使用终端显示的完整本机控制台链接，其中带 #key=。密钥不会发送到 Fish。', true);
else refresh().catch(e => message(e.message, true));
