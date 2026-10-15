import {homedir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from './state.mjs';
import {FishOAuth} from './oauth.mjs';
import {McpClient} from './mcp.mjs';
import {publicError} from './util.mjs';

const report = {time: new Date().toISOString(), node: process.version, generationAttempted: false, steps: []};
try {
  const store = await new StateStore(process.env.FISH_MCP_DATA_DIR || join(homedir(), '.st-iphonie-fish-mcp')).open();
  const oauth = new FishOAuth(store, {endpoint: process.env.FISH_MCP_ENDPOINT || undefined});
  try {
    const d = await oauth.discover();
    report.steps.push({step: 'oauth_metadata', ok: true, issuer: d.issuer, pkce: d.metadata.code_challenge_methods_supported || 'not advertised', dynamicRegistration: !!d.metadata.registration_endpoint});
  } catch (e) { report.steps.push({step: 'oauth_metadata', ok: false, ...publicError(e)}); }
  if (oauth.status().authorized) {
    try { const tools = await new McpClient(oauth).tools(); report.steps.push({step: 'mcp_tools', ok: true, tools: tools.map(t => t.name)}); }
    catch (e) { report.steps.push({step: 'mcp_tools', ok: false, ...publicError(e)}); }
  } else report.steps.push({step: 'mcp_tools', ok: false, skipped: 'not authorized; open local console to sign in'});
} catch (e) { report.steps.push({step: 'local_state', ok: false, message: 'Cannot open local state directory. Check permissions.'}); }
console.log(JSON.stringify(report, null, 2));
if (report.steps.some(s => s.ok === false)) process.exitCode = 1;
