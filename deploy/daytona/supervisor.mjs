import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { readPrivateJson, profileSpec, assertLocalStorage, acquireRuntimeLock, ensureConsoleToken } from './runtime-files.mjs';

const home = process.env.OUTREACH_HOME ?? '/data/outreach';
mkdirSync(home, { recursive: true, mode: 0o700 });
const saved = readPrivateJson(`${home}/runtime.env.json`, {});
for (const [key, value] of Object.entries(saved)) {
  if (!/^(OUTREACH_|DAYTONA_SANDBOX_ID$)/.test(key) || typeof value !== 'string') throw new Error('Invalid runtime environment');
  process.env[key] ??= value;
}
if (process.platform !== 'linux' || !process.env.DAYTONA_SANDBOX_ID) throw new Error('Runtime supervisor requires a Linux Daytona sandbox ID');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Runtime requires Node 24');
const singleton = acquireRuntimeLock(home);
if (!singleton.acquired) {
  process.stdout.write('An outreach supervisor already owns this runtime.\n');
  process.exit(0);
}
process.once('exit', () => singleton.release());
process.env.OUTREACH_PRINCIPAL ??= 'runtime:admin';
process.env.DISPLAY ??= ':99';
const db = process.env.OUTREACH_DB ?? `${home}/outreach.db`;
const cli = process.env.OUTREACH_CLI_ENTRY ?? '/opt/outreach/packages/outreach-cli/dist/bin.js';
const config = process.env.OUTREACH_CONFIG ?? '/opt/outreach/outreach.config.mjs';
const profileRoot = process.env.OUTREACH_CHROME_PROFILE_DIR ?? '/data/chrome-profiles';
const bindingsFile = process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE ?? process.env.OUTREACH_SOCIAL_BINDINGS_FILE ?? `${home}/social-bindings.json`;
process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE = bindingsFile;
process.env.OUTREACH_CHROME_PROFILES_DIR = profileRoot;
const baseArgs = ['--config', config, '--db', db, '--json'];
const tokenFile = `${home}/console-token.json`;
const children = new Map();
let stopping = false;
let ready = false;
let lastError = null;
function log(message) { process.stdout.write(`${new Date().toISOString()} ${message}\n`); }
function command(args) { return JSON.parse(execFileSync(process.execPath, [cli, ...baseArgs, ...args], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })); }
function consoleToken() {
  return ensureConsoleToken(tokenFile, (role) => command(['token', 'create', process.env.OUTREACH_PRINCIPAL, '--name', 'Daytona console', '--role', role, '--days', '90']), { role: process.env.OUTREACH_CONSOLE_ROLE ?? 'admin' });
}
function child(name, executable, args) {
  const descriptor = openSync(`${home}/${name}.log`, 'a', 0o600);
  const processChild = spawn(executable, args, { env: process.env, stdio: ['ignore', descriptor, descriptor] });
  closeSync(descriptor);
  const previous = children.get(name);
  const item = { process: processChild, executable, args, failures: previous?.failures ?? 0, stopped: false };
  children.set(name, item);
  processChild.on('error', () => { lastError = `${name} startup failed`; });
  processChild.on('close', async () => {
    if (stopping || item.stopped) return;
    ready = false; item.failures += 1;
    lastError = `${name} exited; restart ${item.failures}`;
    log(lastError);
    if (item.failures > 5) { await shutdown(1); return; }
    await delay(Math.min(30_000, 1_000 * 2 ** item.failures));
    if (!stopping && !item.stopped) child(name, executable, args);
  });
}
async function waitUrl(url, timeout = 30_000, headers = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !stopping) {
    try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) }); if (r.ok) return; } catch { /* startup */ }
    await delay(250);
  }
  throw new Error('Runtime readiness timeout');
}
async function syncBrowsers() {
  const bindings = readPrivateJson(bindingsFile, {});
  const ports = new Set();
  const wanted = new Set();
  for (const [identity, binding] of Object.entries(bindings)) {
    const spec = profileSpec(identity, binding, profileRoot);
    if (ports.has(spec.port)) throw new Error('Duplicate profile CDP port');
    ports.add(spec.port);
    const name = `chrome-${spec.key}`;
    wanted.add(name);
    const previous = children.get(name);
    if (previous && previous.args.includes(`--remote-debugging-port=${spec.port}`)) continue;
    if (previous) { previous.stopped = true; previous.process.kill('SIGTERM'); await delay(1000); }
    mkdirSync(spec.directory, { recursive: true, mode: 0o700 });
    child(name, chromium.executablePath(), [
      `--user-data-dir=${spec.directory}`, `--remote-debugging-port=${spec.port}`, '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--no-sandbox',
      '--disable-session-crashed-bubble', ({ linkedin: 'https://www.linkedin.com', x: 'https://x.com', instagram: 'https://www.instagram.com', tiktok: 'https://www.tiktok.com' })[binding.kind ?? (binding.expectedProfileUrl ? 'linkedin' : 'browser')] ?? 'about:blank',
    ]);
  }
  for (const [name, item] of children) {
    if (name.startsWith('chrome-') && !wanted.has(name)) { item.stopped = true; item.process.kill('SIGTERM'); children.delete(name); }
  }
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true; ready = false;
  clearInterval(monitor);
  const processes = [...children.values()];
  for (const item of processes) { item.stopped = true; item.process.kill('SIGTERM'); }
  await Promise.race([Promise.all(processes.map(({ process: p }) => new Promise(r => { if (p.exitCode !== null) r(); else p.once('exit', r); }))), delay(15_000)]);
  for (const { process: p } of processes) if (p.exitCode === null) p.kill('SIGKILL');
  statusServer.close(); process.exitCode = code;
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
const statusServer = createServer((request, response) => {
  if (request.url !== '/ready') { response.writeHead(404).end(); return; }
  response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ ready, sandboxId: process.env.DAYTONA_SANDBOX_ID, lastError, services: [...children.keys()] }));
});
const statusReady = new Promise((resolve, reject) => {
  statusServer.once('error', reject);
  statusServer.listen(8788, '127.0.0.1', resolve);
});
let checking = false;
const monitor = setInterval(async () => {
  if (checking || stopping) return;
  checking = true;
  try {
    await syncBrowsers();
    const token = consoleToken();
    await waitUrl(`http://127.0.0.1:${process.env.OUTREACH_PORT ?? '8787'}/v1/me`, 3_000, { authorization: `Bearer ${token.token}` });
    for (const binding of Object.values(readPrivateJson(bindingsFile, {}))) await waitUrl(`${binding.cdpUrl}/json/version`, 3_000);
    ready = [...children.values()].every(v => v.process.exitCode === null && !v.process.killed);
    lastError = null;
  } catch { ready = false; lastError = 'service readiness check failed'; }
  finally { checking = false; }
}, 2_000);
try {
  await statusReady;
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  assertLocalStorage(dirname(db)); assertLocalStorage(profileRoot);
  mkdirSync(`${home}/backups`, { recursive: true, mode: 0o700 });
  command(['init', '--name', 'Outreach']);
  consoleToken();
  child('display', 'Xvfb', [process.env.DISPLAY, '-screen', '0', '1440x1000x24', '-nolisten', 'tcp']);
  const displaySocket = `/tmp/.X11-unix/X${process.env.DISPLAY.replace(':', '').split('.')[0]}`;
  for (let i = 0; i < 40 && !existsSync(displaySocket); i++) await delay(250);
  if (!existsSync(displaySocket)) throw new Error('Display failed to start');
  child('window-manager', 'fluxbox', []);
  child('vnc', 'x11vnc', ['-display', process.env.DISPLAY, '-localhost', '-forever', '-shared', '-nopw', '-rfbport', '5900']);
  child('live-view', 'websockify', ['--web=/usr/share/novnc', process.env.OUTREACH_LIVE_VIEW_PORT ?? '6080', '127.0.0.1:5900']);
  await syncBrowsers();
  child('serve', process.execPath, [cli, ...baseArgs, 'serve', '--host', '0.0.0.0', '--port', process.env.OUTREACH_PORT ?? '8787', '--public']);
  child('worker', process.execPath, [cli, ...baseArgs, 'worker', '--loop', '--interval', '15s', '--backup-dir', resolve(home, 'backups'), '--backup-every-hours', process.env.OUTREACH_BACKUP_EVERY_HOURS ?? '24']);
  log('Outreach supervisor started; private preview credentials are held in private files.');
} catch { lastError = 'runtime startup failed; inspect private service logs'; log(lastError); await shutdown(1); }
