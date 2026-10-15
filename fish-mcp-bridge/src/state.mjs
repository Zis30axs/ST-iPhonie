import {mkdir, readFile, writeFile, rename, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {randomSecret} from './util.mjs';

export const defaultConfig = () => ({
  speech: {tool: '', fields: {}, extra: {}, resultPath: '', pollTool: '', pollIdField: '', pollIdPath: '', pollExtra: {}, pollResultPath: ''},
  voiceTool: '', voiceFields: {}, voiceExtra: {}, voiceResultPath: '', voices: []
});
export class StateStore {
  constructor(dir) { this.dir = dir; this.file = join(dir, 'state.json'); this.tail = Promise.resolve(); }
  async open() {
    await mkdir(this.dir, {recursive: true, mode: 0o700});
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('state.json cannot be read. Preserve it and check permissions/JSON.'); }
    if (!this.data) this.data = {version: 1, bridgeKey: randomSecret(), oauth: {}, config: defaultConfig()};
    if (this.data.version !== 1 || typeof this.data.bridgeKey !== 'string' || this.data.bridgeKey.length < 32)
      throw new Error('Unsupported or corrupt state.json; do not overwrite your authorization data.');
    this.data.config = {...defaultConfig(), ...this.data.config};
    await this.persist();
    return this;
  }
  async persist() {
    const payload = JSON.stringify(this.data, null, 2);
    const action = this.tail.catch(() => {}).then(async () => {
      const tmp = join(this.dir, `.state-${randomUUID()}.tmp`);
      await writeFile(tmp, payload, {encoding: 'utf8', flag: 'wx', mode: 0o600});
      await rename(tmp, this.file);
      if (process.platform !== 'win32') await chmod(this.file, 0o600);
    });
    this.tail = action;
    return action;
  }
  async update(fn) { fn(this.data); await this.persist(); }
}
