import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from './runtime';
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
describe('trusted publishing execution configuration', () => {
  async function runtime(budget: number) {
    const directory = mkdtempSync(join(tmpdir(), 'publishing-budget-')); folders.push(directory);
    const config = join(directory, 'outreach.config.mjs');
    writeFileSync(config, `export default {adapters:[],execution:{publishingMediaTimeoutMs:${budget}}};`);
    return openRuntime({ db: join(directory, 'runtime.db'), workspace: 'test', config, fake: false, json: true });
  }
  it('passes the configured media budget from the CLI into the engine', async () => {
    const rt = await runtime(240000);
    try { expect(rt.engine.exec.config?.publishingMediaTimeoutMs).toBe(240000); } finally { rt.close(); }
  });
  it('refuses an out-of-bounds media budget when the worker resolves execution settings', async () => {
    const rt = await runtime(300001);
    try { await expect(rt.engine.runOnce()).rejects.toThrow(/300000/); } finally { rt.close(); }
  });
});
