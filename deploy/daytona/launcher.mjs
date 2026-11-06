import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateJson, runtimeOwner } from './runtime-files.mjs';

function waitChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const aborted = () => finish(null);
    const finish = (code) => { signal?.removeEventListener('abort', aborted); resolve(code); };
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(code ?? 1));
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** PID1 must survive while the controller supplies an ID and while a bootstrap wins ownership. */
export async function runLauncher({
  home = process.env.OUTREACH_HOME ?? '/data/outreach',
  signal,
  configured,
  owner,
  start,
  pollMs = 1_000,
  shutdownMs = 20_000,
} = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  configured ??= () => Boolean(process.env.DAYTONA_SANDBOX_ID || readPrivateJson(`${home}/runtime.env.json`, {}).DAYTONA_SANDBOX_ID);
  owner ??= () => runtimeOwner(home);
  start ??= () => spawn(process.execPath, [fileURLToPath(new URL('./supervisor.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env, stdio: 'inherit',
  });
  let child;
  let failures = 0;
  const terminating = new Set();
  const terminate = (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || terminating.has(pid)) return;
    terminating.add(pid);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  };
  const stop = () => {
    const active = owner();
    if (active) terminate(active.pid);
    if (child?.exitCode === null) terminate(child.pid);
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!signal?.aborted) {
      if (!configured() || owner()) {
        await delay(pollMs, undefined, { signal });
        continue;
      }
      child = start();
      const code = await waitChild(child, signal);
      if (signal?.aborted) break;
      child = undefined;
      // A zero exit can mean another bootstrap owns the supervisor. Stay alive as PID1.
      if (code === 0) failures = 0;
      else {
        failures += 1;
        if (failures > 5) throw new Error('Supervisor restart budget exhausted');
        await delay(Math.min(30_000, 1_000 * 2 ** failures), undefined, { signal });
      }
    }
  } catch (error) { if (!signal?.aborted) throw error; }
  finally {
    signal?.removeEventListener('abort', stop);
    stop();
    const deadline = Date.now() + shutdownMs;
    while (owner() && Date.now() < deadline) await delay(100);
    const remaining = owner();
    if (remaining) { try { process.kill(remaining.pid, 'SIGKILL'); } catch { /* already exited */ } }
    if (child?.exitCode === null) {
      await Promise.race([waitChild(child), delay(Math.max(0, deadline - Date.now()))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const abort = new globalThis.AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  await runLauncher({ signal: abort.signal });
}
