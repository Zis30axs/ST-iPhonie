import {spawnSync} from 'node:child_process';
import {access, cp, readFile, appendFile} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installTemplate} from '../integration/install-template.mjs';
import {relaxNetwork, TARGETS} from '../integration/relax-network.mjs';

// Run only on your own machine, using YOUR authenticated GitHub CLI. No token is
// requested, embedded, read from other apps, or committed by this script.
const UPSTREAM = 'hey8v0/ST-iPhonie';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedOwner = 'Zis30axs';
const publish = process.argv.includes('--publish');
const featureBranch = 'feature/fish-mcp-integration';
const targetArg = process.argv.find(x => x.startsWith('--destination='));
const target = resolve(targetArg ? targetArg.slice('--destination='.length) : join(process.cwd(), 'ST-iPhonie-fish-mcp-fork'));
const INCLUDE = ['src', 'public', 'test', 'integration', 'scripts', 'package.json', '.gitignore', '.env.example', 'README.md', 'TEST-REPORT.md', 'start.cmd'];
function run(command, args, {capture = false, cwd} = {}) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false});
  if (result.error?.code === 'ENOENT') throw new Error(`${command} is not installed or not on PATH.`);
  if (result.error || result.status !== 0) throw new Error(`${command} failed. No force push or automatic deletion was performed.`);
  return capture ? result.stdout.trim() : '';
}
try {
  if (!publish) {
    console.log('Dry run. No GitHub or filesystem mutation.');
    console.log(`Planned account: ${expectedOwner}; upstream: ${UPSTREAM}`);
    console.log('Plan: create/reuse a verified fork, clone it, add fish-mcp-bridge and a custom TTS preset, remove strict HTTP network gates, test, commit, push only feature/fish-mcp-integration (not main).');
    console.log('Does NOT change the upstream repository or create an upstream pull request.');
    console.log('To execute using your own gh login: node scripts/fork-publish.mjs --publish');
  } else {
    run('gh', ['--version'], {capture: true}); run('git', ['--version'], {capture: true});
    const user = JSON.parse(run('gh', ['api', 'user'], {capture: true}));
    if (user.login !== expectedOwner) throw new Error(`Your gh account is ${user.login}, not ${expectedOwner}. Switch accounts with gh auth switch; nothing was forked.`);
    try { await access(target); throw new Error('Destination already exists. Choose a new --destination=PATH to avoid overwriting files.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    run('gh', ['repo', 'fork', UPSTREAM, '--clone=false']);
    const repoName = `${user.login}/ST-iPhonie`;
    const repo = JSON.parse(run('gh', ['api', `repos/${repoName}`], {capture: true}));
    if (!repo.fork || repo.parent?.full_name !== UPSTREAM) throw new Error('The destination is not a verified fork of the expected upstream. Refusing to modify it.');
    run('gh', ['repo', 'clone', repoName, target, '--', '--depth=1']);
    run('git', ['checkout', '-b', featureBranch], {cwd: target});
    const bridgeDir = join(target, 'fish-mcp-bridge');
    try { await access(bridgeDir); throw new Error('Fork already contains fish-mcp-bridge; refusing to overwrite an existing implementation.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of INCLUDE) await cp(join(source, name), join(bridgeDir, name), {recursive: true, errorOnExist: true, force: false});
    await installTemplate(target, {backup: false});
    const networkEdits = await relaxNetwork(target, {backup: false});
    const readme = await readFile(join(target, 'README.md'), 'utf8');
    if (!readme.includes('fish-mcp-bridge/README.md')) await appendFile(join(target, 'README.md'),
      '\n\n## Fish Audio MCP 网页积分实验接入\n\n本 Fork 附带本机 OAuth MCP → HTTP TTS 适配器与「自己的接口」预设。参见 [安装、授权与验证边界](fish-mcp-bridge/README.md)。这不是上游原生功能；真实账号端到端仍需本人授权验证。\n', 'utf8');
    // Explicit test paths avoid shell glob expansion and work on Windows.
    run(process.execPath, ['--test', 'test/bridge.test.mjs', 'test/logic.test.mjs', 'test/integration.test.mjs', 'test/network.test.mjs'], {cwd: bridgeDir});
    run('git', ['add', '--', 'fish-mcp-bridge', 'core/custom-voice.js', 'README.md', ...networkEdits.filter(x => x.changed).map(x => x.path)], {cwd: target});
    run('git', ['diff', '--cached', '--check'], {cwd: target});
    run('git', ['-c', `user.name=${user.login}`, '-c', `user.email=${user.id}+${user.login}@users.noreply.github.com`,
      'commit', '-m', 'Add experimental OAuth Fish MCP TTS bridge and relax iPhonie HTTP restrictions'], {cwd: target});
    run('git', ['push', 'origin', `HEAD:refs/heads/${featureBranch}`], {cwd: target});
    console.log(`Published to ${repo.html_url}/tree/${featureBranch}. Upstream unchanged. No provider tokens were included.`);
    console.log(`Start adapter: cd "${bridgeDir}" ; node src/main.mjs`);
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
