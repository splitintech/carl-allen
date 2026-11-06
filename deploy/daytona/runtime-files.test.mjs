import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, symlinkSync, statSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { privateJson, readPrivateJson, profileSpec, assertLocalStorage, acquireRuntimeLock, ensureConsoleToken } from './runtime-files.mjs';
import { runLauncher } from './launcher.mjs';
test('private state writes are atomic and refuse symlinks or readable files', () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-runtime-'));
  try {
    const file = join(root, 'connection.json'); privateJson(file, { n: 1 });
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.deepEqual(readPrivateJson(file), { n: 1 });
    privateJson(file, { n: 2 }); assert.deepEqual(readPrivateJson(file), { n: 2 });
    chmodSync(file, 0o644); assert.throws(() => readPrivateJson(file), /owner-only/);
    symlinkSync(file, join(root, 'alias')); assert.throws(() => privateJson(join(root, 'alias'), {}), /symlink/);
    assertLocalStorage(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('CDP profiles are bound to identity and sandbox-local loopback', () => {
  const spec = profileSpec('account-a', { cdpUrl: 'http://127.0.0.1:9222' });
  assert.equal(spec.port, 9222); assert.match(spec.directory, /^\/data\/chrome-profiles\/[a-f0-9]{24}$/);
  assert.notEqual(spec.key, profileSpec('account-b', { cdpUrl: 'http://127.0.0.1:9223' }).key);
  for (const cdpUrl of ['https://evil.invalid:9222', 'http://127.0.0.1:80', 'http://localhost:9222/a']) assert.throws(() => profileSpec('a', { cdpUrl }));
  assert.throws(() => profileSpec('account-a', { cdpUrl: 'http://127.0.0.1:9222', userDataDir: '/tmp/shared-profile' }), /identity/);
});
test('singleton ownership refuses a live supervisor and recovers only dead or stale ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-singleton-'));
  try {
    const first = acquireRuntimeLock(root, { pid: 4242, alive: () => false });
    assert.equal(first.acquired, true);
    const duplicate = acquireRuntimeLock(root, { pid: 4343, alive: owner => owner.pid === 4242 });
    assert.equal(duplicate.acquired, false);
    assert.equal(readPrivateJson(`${root}/supervisor.pid.json`).pid, 4242);
    const recovered = acquireRuntimeLock(root, { pid: 4444, alive: () => false });
    assert.equal(recovered.acquired, true);
    first.release();
    assert.equal(readPrivateJson(`${root}/supervisor.lock/owner.json`).pid, 4444);
    recovered.release();
    mkdirSync(`${root}/supervisor.lock`);
    assert.equal(acquireRuntimeLock(root, { alive: () => false }).acquired, false);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(`${root}/supervisor.lock`, stale, stale);
    const emptyRecovered = acquireRuntimeLock(root, { alive: () => false });
    assert.equal(emptyRecovered.acquired, true); emptyRecovered.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('simultaneous bootstrap contenders acquire one supervisor identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-contenders-'));
  const module = new URL('./runtime-files.mjs', import.meta.url).href;
  const code = `import {acquireRuntimeLock} from ${JSON.stringify(module)};
    const lock=acquireRuntimeLock(process.argv[1],{alive:o=>{try{process.kill(o.pid,0);return true}catch{return false}}});
    process.stdout.write(JSON.stringify({acquired:lock.acquired}));
    if(lock.acquired)setTimeout(()=>lock.release(),1000);`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, root]);
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(JSON.parse(output)); else reject(new Error(error)); });
  });
  try {
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter(result => result.acquired).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('console token maintenance rotates near expiry without raising its role or minting repeatedly', () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-rotation-'));
  try {
    const path = `${root}/token.json`; const now = Date.parse('2026-11-05T00:00:00Z');
    privateJson(path, { token: 'old', expiresAt: new Date(now + 1000).toISOString(), role: 'viewer' });
    const roles = [];
    const issue = role => { roles.push(role); return { token: 'renewed', expiresAt: new Date(now + 90 * 86_400_000).toISOString() }; };
    const rotated = ensureConsoleToken(path, issue, { now, role: 'admin' });
    assert.equal(rotated.token, 'renewed'); assert.equal(rotated.role, 'viewer');
    assert.deepEqual(roles, ['viewer']);
    ensureConsoleToken(path, issue, { now: now + 300_000, role: 'admin' });
    assert.deepEqual(roles, ['viewer']);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => ensureConsoleToken(path, () => { throw new Error('issuer unavailable'); }, { now: now + 91 * 86_400_000 }), /issuer unavailable/);
    assert.equal(readPrivateJson(path).token, 'renewed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixtureOwner(root) {
  const value = readPrivateJson(`${root}/supervisor.lock/owner.json`, {});
  try { process.kill(value.pid, 0); return value; } catch { return null; }
}
function fixtureSupervisor(root, ignoreTerm = false) {
  const module = new URL('./runtime-files.mjs', import.meta.url).href;
  const code = `import {acquireRuntimeLock,privateJson,readPrivateJson} from ${JSON.stringify(module)};
    const home=process.argv[1];
    const lock=acquireRuntimeLock(home,{alive:o=>{try{process.kill(o.pid,0);return true}catch{return false}}});
    if(!lock.acquired)process.exit(0);
    const timer=setInterval(()=>{},1000);
    if(${Boolean(ignoreTerm)})process.on('SIGTERM',()=>{});
    else process.once('SIGTERM',()=>{lock.release();clearInterval(timer);process.exit(0)});
    privateJson(home+'/booted.json',{pid:process.pid,sandboxId:readPrivateJson(home+'/runtime.env.json',{}).DAYTONA_SANDBOX_ID});`;
  return spawn(process.execPath, ['--input-type=module', '-e', code, root], { stdio: 'ignore' });
}
async function waitFor(condition) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Fixture supervisor did not become ready');
    await delay(20);
  }
}
test('entrypoint launcher waits for actual controller metadata and restarts from saved identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-launcher-'));
  const abort = new globalThis.AbortController(); let starts = 0;
  let restart; let restarted;
  const start = () => { starts++; return fixtureSupervisor(root); };
  const configured = () => Boolean(readPrivateJson(`${root}/runtime.env.json`, {}).DAYTONA_SANDBOX_ID);
  const launched = runLauncher({ home: root, signal: abort.signal, configured, owner: () => fixtureOwner(root), start, pollMs: 20 });
  try {
    await delay(100); assert.equal(starts, 0);
    privateJson(`${root}/runtime.env.json`, { DAYTONA_SANDBOX_ID: 'actual-created-id' });
    await waitFor(() => Boolean(fixtureOwner(root)));
    await waitFor(() => readPrivateJson(`${root}/booted.json`, {}).sandboxId === 'actual-created-id');
    assert.equal(starts, 1);
    abort.abort(); await launched;
    restart = new globalThis.AbortController();
    restarted = runLauncher({ home: root, signal: restart.signal, configured, owner: () => fixtureOwner(root), start, pollMs: 20 });
    await waitFor(() => Boolean(fixtureOwner(root))); assert.equal(starts, 2);
    await waitFor(() => readPrivateJson(`${root}/booted.json`, {}).pid === fixtureOwner(root)?.pid);
    restart.abort(); await restarted;
  } finally { abort.abort(); restart?.abort(); await Promise.allSettled([launched, restarted]); rmSync(root, { recursive: true, force: true }); }
});
test('PID1 launcher remains alive when its child loses ownership to a detached bootstrap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-launcher-race-'));
  const abort = new globalThis.AbortController(); let winner; let finished = false;
  privateJson(`${root}/runtime.env.json`, { DAYTONA_SANDBOX_ID: 'actual-id' });
  const launched = runLauncher({
    home: root, signal: abort.signal, configured: () => true, owner: () => fixtureOwner(root), pollMs: 20,
    start: () => { winner ??= fixtureSupervisor(root); return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }); },
  }).finally(() => { finished = true; });
  try {
    await waitFor(() => Boolean(fixtureOwner(root)));
    await waitFor(() => readPrivateJson(`${root}/booted.json`, {}).pid === fixtureOwner(root)?.pid);
    await delay(200);
    assert.equal(finished, false); assert.equal(winner.exitCode, null);
    abort.abort(); await launched;
    assert.equal(fixtureOwner(root), null);
  } finally { abort.abort(); await launched; if (winner?.exitCode === null) winner.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
test('launcher termination is bounded even when a supervisor ignores SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outreach-launcher-stop-'));
  const abort = new globalThis.AbortController(); let child;
  const launched = runLauncher({
    home: root, signal: abort.signal, configured: () => true, owner: () => fixtureOwner(root),
    start: () => (child = fixtureSupervisor(root, true)), pollMs: 20, shutdownMs: 100,
  });
  try {
    await waitFor(() => Boolean(fixtureOwner(root)));
    await waitFor(() => readPrivateJson(`${root}/booted.json`, {}).pid === fixtureOwner(root)?.pid);
    abort.abort(); await launched;
    await waitFor(() => child.signalCode !== null);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { abort.abort(); await launched; if (child?.exitCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});
