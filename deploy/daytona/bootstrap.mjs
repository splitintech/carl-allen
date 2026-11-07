import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { privateJson, readPrivateJson, runtimeOwner } from './runtime-files.mjs';
const home = process.env.OUTREACH_HOME ?? '/data/outreach';
if (!process.env.DAYTONA_SANDBOX_ID || process.platform !== 'linux') throw new Error('Daytona Linux runtime required');
privateJson(`${home}/runtime.env.json`, {
  ...readPrivateJson(`${home}/runtime.env.json`, {}),
  ...Object.fromEntries(Object.entries(process.env).filter(([key,value]) => /^(OUTREACH_[A-Z0-9_]+|CLOUD_GATEWAY_SECRET|CLOUD_MEDIA_SECRET|CARL_PUBLIC_ORIGIN)$/.test(key) && typeof value === 'string')),
  DAYTONA_SANDBOX_ID: process.env.DAYTONA_SANDBOX_ID,
  OUTREACH_WORKSPACE: process.env.OUTREACH_WORKSPACE ?? 'default',
  OUTREACH_PRINCIPAL: 'runtime:admin',
});
const prior = runtimeOwner(home);
if (!prior) {
  const log = openSync(`${home}/supervisor.log`, 'a', 0o600);
  const child = spawn(process.execPath, ['deploy/daytona/supervisor.mjs'], { cwd: '/opt/outreach', env: process.env, detached: true, stdio: ['ignore', log, log] });
  let failed = false;
  child.once('error', () => { failed = true; });
  closeSync(log); child.unref();
  // Only the winning supervisor writes ownership. Two simultaneous bootstraps cannot
  // overwrite the live PID with that of a losing duplicate process.
  let owner;
  for (let i = 0; i < 80 && !owner && !failed; i++) { owner = runtimeOwner(home); if (!owner) await delay(250); }
  if (!owner) throw new Error('Supervisor did not acquire runtime ownership');
  process.stdout.write(JSON.stringify({ started: owner.pid === child.pid, pid: owner.pid }));
} else process.stdout.write(JSON.stringify({ started: false, pid: prior.pid }));
