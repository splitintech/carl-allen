import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPool } from './browser-pool.mjs';

test('pool bounds Chrome count, never evicts an active lease and distinguishes inactive', async () => {
  const active = new Set(); const pool = new BrowserPool({start: async k => active.add(k), stop: async k => active.delete(k), alive: k => active.has(k)});
  const a = await pool.acquire('a', {}); const b = await pool.acquire('b', {});
  await assert.rejects(pool.acquire('c', {}), /capacity/); assert.equal(active.size, 2);
  await assert.rejects(pool.acquire('a', {}), /busy/); pool.release(a.leaseId);
  await pool.acquire('c', {}); assert.deepEqual([...active].sort(), ['b','c']);
  assert.equal(pool.snapshot(['a','b'])[0].state,'inactive'); pool.release(b.leaseId);
});
test('pool renews leases and recovers expired ownership without losing profiles', async () => {
  let now = 0; const active = new Set(); const pool = new BrowserPool({limit:1,now:()=>now,leaseMs:100,start:async k=>active.add(k),stop:async k=>active.delete(k)});
  const a=await pool.acquire('a',{});now=80;pool.renew(a.leaseId);now=150;await assert.rejects(pool.acquire('b',{}),/capacity/);
  now=181;await pool.acquire('b',{});assert.deepEqual([...active],['b']);assert.throws(()=>pool.renew(a.leaseId),/expired/);
});
