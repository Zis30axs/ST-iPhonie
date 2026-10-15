import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {StateStore} from './state.mjs';
import {FishOAuth} from './oauth.mjs';
import {McpClient} from './mcp.mjs';
import {SpeechService} from './speech.mjs';
import {createBridgeServer} from './server.mjs';
import {intEnv, publicError} from './util.mjs';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const port = intEnv(process.env.BRIDGE_PORT, 3789, 1, 65535, 'BRIDGE_PORT');
  const host = process.env.BRIDGE_HOST || '127.0.0.1';
  const stateDir = resolve(process.env.FISH_MCP_DATA_DIR || join(homedir(), '.st-iphonie-fish-mcp'));
  const store = await new StateStore(stateDir).open();
  const displayHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  const urlHost = displayHost.includes(':') && !displayHost.startsWith('[') ? `[${displayHost}]` : displayHost;
  const publicURL = (process.env.BRIDGE_PUBLIC_URL || `http://${urlHost}:${port}`).replace(/\/+$/, '');
  const oauth = new FishOAuth(store, {endpoint: process.env.FISH_MCP_ENDPOINT || undefined,
    redirectURI: process.env.FISH_OAUTH_REDIRECT_URI || `${publicURL}/oauth/callback`,
    clientID: process.env.FISH_OAUTH_CLIENT_ID || '', scope: process.env.FISH_OAUTH_SCOPE || ''});
  const mcp = new McpClient(oauth), speech = new SpeechService(mcp, store);
  const server = createBridgeServer({oauth, mcp, speech, store});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  console.log('\nFish MCP → ST-iPhonie  /  实验版 0.1.1');
  console.log('控制台（请勿分享含 #key= 的链接）：');
  console.log(`${publicURL}/#key=${store.data.bridgeKey}`);
  console.log(`TTS: ${publicURL}/v1/audio/speech`);
  console.log('启动与读取工具不会生成音频。点击“生成试听”才会提交配音。');
  console.log('数据目录: ' + stateDir + '（含 OAuth 令牌，勿上传仓库/备份给他人）');
  console.log('网络限制已放宽：HTTP(S)、任意端口和内网地址可用；管理/TTS 仍需桥接密钥。');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) console.log('正在监听 ' + host + '。手机/反代授权请设置 BRIDGE_PUBLIC_URL；仅使用可信网络。');
  const stop = () => { server.close(); server.closeIdleConnections(); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  // Known local startup errors are safe to print; do not dump objects or token-bearing responses.
  console.error(error?.code === 'EADDRINUSE' ? '端口已占用，请关闭旧进程或设置 BRIDGE_PORT。' :
    error?.code === 'EACCES' ? '没有权限读取数据目录或监听端口。' :
    error?.cause ? publicError(error).message : error.message);
  process.exitCode = 1;
}
