import { constants, closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function privateJson(path, value) {
  if (!isAbsolute(path)) throw new Error('Private runtime file path must be absolute');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('Private runtime file cannot be a symlink'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); chmodSync(path, 0o600);
}
export function readPrivateJson(path, fallback) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Runtime state must be an owner-only regular file');
    if (process.getuid && stat.uid !== process.getuid()) throw new Error('Runtime state must belong to the current user');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export function profileSpec(externalId, binding, root = '/data/chrome-profiles') {
  if (!externalId || typeof binding !== 'object' || !binding) throw new Error('Invalid account binding');
  const endpoint = new URL(binding.cdpUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('CDP endpoint must be a plain loopback HTTP endpoint');
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 9222 || port > 9999) throw new Error('CDP port must be 9222..9999');
  const key = createHash('sha256').update(externalId).digest('hex').slice(0, 24);
  const directory = resolve(root, key);
  if (binding.userDataDir && resolve(binding.userDataDir) !== directory) throw new Error('Profile path must match the account identity');
  return { key, port, directory };
}

export function assertLocalStorage(path) {
  const type = Number(statfsSync(path).type) >>> 0;
  if ([0x65735546, 0x6969, 0x517B, 0xFF534D42, 0x01021997].includes(type)) {
    throw new Error('SQLite and Chrome profiles require sandbox-local disk, not FUSE/network storage');
  }
}

function supervisorAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return readFileSync(`/proc/${owner.pid}/cmdline`, 'utf8').includes('deploy/daytona/supervisor.mjs');
  } catch { return false; }
}

export function runtimeOwner(home, alive = supervisorAlive) {
  const owner = readPrivateJson(`${home}/supervisor.lock/owner.json`, {});
  return alive(owner) ? owner : null;
}

/** mkdir arbitrates even simultaneous bootstrap/entrypoint starts; a dead owner is recoverable. */
export function acquireRuntimeLock(home, { pid = process.pid, alive = supervisorAlive, now = Date.now() } = {}) {
  const directory = `${home}/supervisor.lock`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      const owner = { pid, token: randomUUID() };
      privateJson(`${directory}/owner.json`, owner);
      privateJson(`${home}/supervisor.pid.json`, { pid });
      return { acquired: true, owner, release() {
        const current = readPrivateJson(`${directory}/owner.json`, {});
        if (current.token === owner.token) rmSync(directory, { recursive: true });
      } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid supervisor lock directory');
      const owner = readPrivateJson(`${directory}/owner.json`, {});
      if (alive(owner)) return { acquired: false, owner };
      // Allow a just-starting owner to publish its PID before considering an empty lock stale.
      if (!owner.pid && now - info.mtimeMs < 30_000) return { acquired: false, owner: null };
      const stale = `${directory}.stale-${randomUUID()}`;
      try { renameSync(directory, stale); } catch (race) { if (race.code === 'ENOENT') continue; throw race; }
      rmSync(stale, { recursive: true });
    }
  }
  throw new Error('Supervisor lock ownership changed repeatedly');
}

/** Keep a valid token stable; rotate near expiry while preserving its recorded role ceiling. */
export function ensureConsoleToken(path, issue, { now = Date.now(), role = 'admin', renewBeforeMs = 86_400_000 } = {}) {
  const previous = readPrivateJson(path, {});
  const expires = Date.parse(previous.expiresAt);
  if (previous.token && Number.isFinite(expires) && expires > now + renewBeforeMs) return previous;
  const ceiling = previous.role ?? role;
  if (!['viewer', 'operator', 'approver', 'admin'].includes(ceiling)) throw new Error('Invalid console token role ceiling');
  const token = { ...issue(ceiling), role: ceiling };
  if (!token.token || !Number.isFinite(Date.parse(token.expiresAt))) throw new Error('Token issuer did not return a credential with expiry');
  privateJson(path, token);
  return token;
}
