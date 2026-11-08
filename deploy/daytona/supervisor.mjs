import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync,rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BrowserPool } from './browser-pool.mjs';
import { loginBrowser } from './login-browser.mjs';
import {LoginView,terminateProcessGroup} from './login-view.mjs';
import { readPrivateJson, profileSpec, assertLocalStorage, acquireRuntimeLock, ensureConsoleToken } from './runtime-files.mjs';

const home = process.env.OUTREACH_HOME ?? '/data/outreach';
mkdirSync(home, { recursive: true, mode: 0o700 });
const saved = readPrivateJson(`${home}/runtime.env.json`, {});
for (const [key, value] of Object.entries(saved)) {
  if (!/^(OUTREACH_|DAYTONA_SANDBOX_ID$|CLOUD_GATEWAY_SECRET$|CLOUD_MEDIA_SECRET$|CARL_PUBLIC_ORIGIN$)/.test(key) || typeof value !== 'string') throw new Error('Invalid runtime environment');
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
process.env.OUTREACH_BROWSER_POOL_URL = 'http://127.0.0.1:8788';
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
  const detached=name.startsWith('chrome-');
  const processChild = spawn(executable, args, { detached, env: process.env, stdio: ['ignore', descriptor, descriptor] });
  closeSync(descriptor);
  const previous = children.get(name);
  const item = { process: processChild, executable, args, failures: previous?.failures ?? 0, stopped: false, detached };
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
function connectionBindings() {
  const bindings = readPrivateJson(bindingsFile, {}); const result = new Map(); const ports = new Map();
  for (const [identity, binding] of Object.entries(bindings)) {
    const key = binding.connectionId || identity; const spec = profileSpec(key, binding, profileRoot);
    if (ports.has(spec.port) && ports.get(spec.port) !== key) throw new Error('Duplicate profile CDP port');
    ports.set(spec.port, key);
    const login = {kind:binding.kind,expectedProfileUrl:binding.loginProfileUrl??binding.expectedProfileUrl,cdpUrl:binding.cdpUrl,userDataDir:binding.userDataDir};
    if (result.has(key) && JSON.stringify(result.get(key)) !== JSON.stringify(login)) throw new Error('Conflicting login connection bindings');
    result.set(key, login);
  }
  return result;
}
const loginView=new LoginView({tokenFile:`${home}/live-view-tokens`,port:Number(process.env.OUTREACH_LIVE_VIEW_PORT??6080),logFile:`${home}/live-view.log`});
const browserPool = new BrowserPool({
  onHumanStart:()=>loginView.grant(),onHumanEnd:()=>loginView.revoke(),
  limit: Number(process.env.OUTREACH_MAX_ACTIVE_BROWSERS ?? '2'),
  alive(key) { const item = children.get(`chrome-${createHash('sha256').update(key).digest('hex').slice(0,24)}`); return Boolean(item && item.process.exitCode === null && !item.process.killed); },
  async start(key, binding) {
    const spec = profileSpec(key, binding, profileRoot); mkdirSync(spec.directory, { recursive: true, mode: 0o700 });
    child(`chrome-${spec.key}`, chromium.executablePath(), [
      `--user-data-dir=${spec.directory}`, `--remote-debugging-port=${spec.port}`, '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--no-sandbox', '--disable-session-crashed-bubble',
      ({ linkedin: 'https://www.linkedin.com', x: 'https://x.com', instagram: 'https://www.instagram.com', tiktok: 'https://www.tiktok.com' })[binding.kind ?? 'linkedin'] ?? 'about:blank',
    ]);
    await waitUrl(`${binding.cdpUrl}/json/version`);
  },
  async stop(key) {
    const name = `chrome-${createHash('sha256').update(key).digest('hex').slice(0,24)}`; const item = children.get(name);
    if (!item) return; item.stopped = true;
    await terminateProcessGroup(item.process);children.delete(name);
  },
});
async function syncBrowsers() {await browserPool.prune([...connectionBindings().keys()]);}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true; ready = false;
  clearInterval(monitor);
  await loginView.close().catch(()=>{lastError='Private desktop teardown failed';});
  const processes = [...children.values()];
  for (const item of processes) { item.stopped = true; item.process.kill('SIGTERM'); }
  await Promise.race([Promise.all(processes.map(({ process: p }) => new Promise(r => { if (p.exitCode !== null) r(); else p.once('exit', r); }))), delay(15_000)]);
  for (const item of processes)if(item.detached)await terminateProcessGroup(item.process).catch(()=>undefined);else if(item.process.exitCode===null)item.process.kill('SIGKILL');
  statusServer.close(); process.exitCode = code;
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
const statusServer = createServer(async (request, response) => {
  if (request.url === '/ready') {
    const headers={'content-type':'application/json','cache-control':'no-store'};
    try{const browsers=await browserPool.snapshot([...connectionBindings().keys()]);const healthy=ready&&loginView.healthy;response.writeHead(healthy?200:503,headers).end(JSON.stringify({ready:healthy,sandboxId:process.env.DAYTONA_SANDBOX_ID,lastError,services:[...children.keys(),'live-view'],browsers}));}catch{response.writeHead(503,headers).end(JSON.stringify({ready:false,lastError:'Private desktop teardown is pending'}));}return;
  }
  if(stopping){response.writeHead(503).end();return;}
  if (!['/browser/acquire','/browser/renew','/browser/release','/browser/remove','/browser/login/focus','/browser/login/inspect'].includes(request.url) || request.method !== 'POST') { response.writeHead(404).end(); return; }
  if(request.headers.origin || request.headers.host !== '127.0.0.1:8788' || request.headers['content-type']?.split(';')[0] !== 'application/json'){response.writeHead(403).end();return;}
  try {
    let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 4096) throw new Error('Request too large'); }
    const value = JSON.parse(text); let result = { ok: true };
    if (request.url === '/browser/acquire') {
      const binding = connectionBindings().get(value.connectionId); if (!binding) throw new Error('Unknown login connection');
      result = await browserPool.acquire(value.connectionId, binding,{human:value.human===true});
    } else if(request.url==='/browser/remove'){
      const bindings=readPrivateJson(bindingsFile,{});const entries=Object.entries(bindings).filter(([key,b])=>(b.connectionId||key)===value.connectionId);if(entries.length!==1)throw new Error('Shared or missing browser profile; retained');
      const spec=profileSpec(value.connectionId,entries[0][1],profileRoot);await browserPool.remove(value.connectionId);rmSync(spec.directory,{recursive:true,force:true});result={removed:true};
    } else if (request.url.startsWith('/browser/login/')) {
      result=await browserPool.withHuman(value.leaseId,async({connectionId,desktopPath})=>{const binding=connectionBindings().get(connectionId);if(!binding)throw new Error('Login binding no longer exists');return{...await loginBrowser(binding,request.url.endsWith('/focus')?'focus':'inspect'),desktopPath};});
    } else if (request.url === '/browser/renew') await browserPool.renew(value.leaseId);
    else await browserPool.release(value.leaseId);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) { response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error.message).slice(0,100) })); }
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
    for (const entry of (await browserPool.snapshot([...connectionBindings().keys()])).filter(v => v.state === 'active')) await waitUrl(`${connectionBindings().get(entry.connectionId).cdpUrl}/json/version`, 3_000);
    ready = loginView.healthy&&[...children.values()].every(v => v.process.exitCode === null && !v.process.killed);
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
  await loginView.start();
  await syncBrowsers();
  child('serve', process.execPath, [cli, ...baseArgs, 'serve', '--host', '0.0.0.0', '--port', process.env.OUTREACH_PORT ?? '8787', '--public']);
  child('worker', process.execPath, [cli, ...baseArgs, 'worker', '--loop', '--interval', '15s', '--backup-dir', resolve(home, 'backups'), '--backup-every-hours', process.env.OUTREACH_BACKUP_EVERY_HOURS ?? '24']);
  log('Outreach supervisor started; private preview credentials are held in private files.');
} catch { lastError = 'runtime startup failed; inspect private service logs'; log(lastError); await shutdown(1); }
