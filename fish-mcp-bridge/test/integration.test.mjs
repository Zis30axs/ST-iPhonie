import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyTemplate, installTemplate} from '../integration/install-template.mjs';
import {spawnSync} from 'node:child_process';

const fixture = 'export const CUSTOM_TEMPLATES = Object.freeze([\n  {id: "existing", fill: () => ({url:"unchanged"})}\n]);\n';
test('Preset installer adds valid executable config and preserves existing templates', async () => {
  const result = applyTemplate(fixture); assert.equal(result.changed, true);
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.content).toString('base64'));
  assert.equal(module.CUSTOM_TEMPLATES.length, 2);
  const p = module.CUSTOM_TEMPLATES[0].fill('http://127.0.0.1:3789/');
  assert.equal(p.url, 'http://127.0.0.1:3789/v1/audio/speech'); assert.equal(p.listPath, 'voices');
  assert.equal(JSON.parse(p.body).input, '{{text}}'); assert.equal(JSON.parse(p.body).emotion, '{{emotion}}');
  assert.equal(module.CUSTOM_TEMPLATES[1].fill().url, 'unchanged');
  assert.equal(applyTemplate(result.content).changed, false);
});
test('Installer refuses changed upstream structure, preserves CRLF', () => {
  assert.throws(() => applyTemplate('const other = [];'), /structure changed/);
  const result = applyTemplate(fixture.replace(/\n/g,'\r\n'));
  assert.ok(!/(?<!\r)\n/.test(result.content));
});
test('File installer creates backup and is idempotent', async t => {
  const dir = await mkdtemp(join(tmpdir(),'fish-preset-test-')); t.after(() => rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'core')); const file = join(dir,'core','custom-voice.js'); await writeFile(file,fixture);
  assert.equal((await installTemplate(dir)).changed,true);
  assert.equal(await readFile(file+'.before-fish-mcp.bak','utf8'),fixture);
  assert.equal((await installTemplate(dir)).changed,false);
});
test('Fork helper without --publish is a non-mutating dry run', () => {
  const result = spawnSync(process.execPath,['scripts/fork-publish.mjs'],{encoding:'utf8'});
  assert.equal(result.status,0); assert.match(result.stdout,/Dry run/); assert.match(result.stdout,/Zis30axs/);
});

import {relaxSource, relaxNetwork} from '../integration/relax-network.mjs';
import {upstream} from './fixtures/upstream-network.mjs';
const fromSource = source => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('Upstream Fish/NovelAI relay accepts HTTP even when the tavern page uses HTTPS', async () => {
  const original = await fromSource(upstream['core/novelai.js']);
  assert.throws(() => original.relayUrl('http://192.168.10.2:8099', 'https:'), /HTTPS/);
  const changed = relaxSource('core/novelai.js', upstream['core/novelai.js']);
  const module = await fromSource(changed.content);
  for (const base of ['http://192.168.10.2:8099','http://relay.example:8999','http://[::1]:8080']) {
    assert.equal(module.relayUrl(base, 'https:'), base);
    assert.equal(module.relayUrl(base+'/v1/tts', 'https:', module.FISH_PATHS), base);
  }
  assert.equal(relaxSource('core/novelai.js', changed.content).changed, false);
});
test('Upstream GPT relay HTTP protocol and custom port survive normalization', async () => {
  const changed = relaxSource('core/image-engines.js', upstream['core/image-engines.js']);
  const {gptBase} = await fromSource(changed.content);
  assert.equal(gptBase('http://relay.internal:8181/v1/images/generations', 'https:'), 'http://relay.internal:8181/v1');
  assert.equal(gptBase('https://relay.example:9443', 'https:'), 'https://relay.example:9443/v1');
});
test('Upstream music keeps the exact HTTP URL and signed query instead of upgrading HTTPS', async () => {
  const {playable} = await fromSource(relaxSource('core/music.js', upstream['core/music.js']).content);
  const link = 'http://music.example:8090/song.mp3?signature=abc%2Fdef';
  assert.equal(playable(link, 'https:'), link);
});
test('Both upstream cloud queue clients accept HTTP; room authorization remains intact', async () => {
  const {CloudQueue, KeyHashQueue} = await fromSource(relaxSource('core/cloud-queue.js', upstream['core/cloud-queue.js']).content);
  const sent = []; const fetcher = async url => {sent.push(url); return new Response('{"ok":true}', {headers:{'content-type':'application/json'}});};
  const room = new CloudQueue({url:'http://queue.internal:9000',room:'abcdefghijklmnop'}, {fetcher});
  const keyed = new KeyHashQueue({url:'http://queue.internal:9000'}, {fetcher});
  assert.deepEqual(await room.call({op:'status'}),{ok:true}); assert.deepEqual(await keyed.request('/ping'),{ok:true});
  assert.deepEqual(sent,['http://queue.internal:9000/q/abcdefghijklmnop','http://queue.internal:9000/ping']);
  room.room = ''; await assert.rejects(room.call({op:'status'}), /房间码/);
});
test('Network patcher preserves CRLF, backs up all target files and is idempotent', async t => {
  const dir = await mkdtemp(join(tmpdir(),'fish-network-install-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'core'));
  for (const [path, source] of Object.entries(upstream)) await writeFile(join(dir,path),source.replace(/\n/g,'\r\n'));
  const result = await relaxNetwork(dir); assert.equal(result.filter(x=>x.changed).length,4);
  for (const [path, source] of Object.entries(upstream)) {
    assert.equal(await readFile(join(dir,path+'.before-network-unlock.bak'),'utf8'), source.replace(/\n/g,'\r\n'));
    assert.ok(!/(?<!\r)\n/.test(await readFile(join(dir,path),'utf8')));
  }
  assert.equal((await relaxNetwork(dir)).some(x=>x.changed),false);
});
test('Network patcher checks every target before writing, leaving unmatched versions untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(),'fish-network-mismatch-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'core'));
  for (const [path, source] of Object.entries(upstream)) await writeFile(join(dir,path),source);
  await writeFile(join(dir,'core/image-engines.js'),'// unknown version\n');
  await assert.rejects(relaxNetwork(dir), /expected HTTP guard/);
  assert.equal(await readFile(join(dir,'core/novelai.js'),'utf8'),upstream['core/novelai.js']);
});
