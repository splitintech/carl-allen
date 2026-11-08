import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPool } from './browser-pool.mjs';
const desktopPath='websockify?token='+'a'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};

test('pool bounds Chrome count, never evicts an active lease and distinguishes inactive', async () => {
  const active=new Set();const pool=new BrowserPool({start:async k=>active.add(k),stop:async k=>active.delete(k),alive:k=>active.has(k)});
  const a=await pool.acquire('a',{});const b=await pool.acquire('b',{});
  await assert.rejects(pool.acquire('c',{}),/capacity/);assert.equal(active.size,2);
  await assert.rejects(pool.acquire('a',{}),/busy/);await pool.release(a.leaseId);
  await pool.acquire('c',{});assert.deepEqual([...active].sort(),['b','c']);
  assert.equal((await pool.snapshot(['a','b']))[0].state,'inactive');await pool.release(b.leaseId);
});
test('expired automation is terminated before ownership moves; renewed leases remain exclusive',async()=>{
  let now=0;const active=new Set();const events=[];const pool=new BrowserPool({limit:1,now:()=>now,leaseMs:100,start:async k=>{events.push('start:'+k);active.add(k);},stop:async k=>{events.push('stop:'+k);active.delete(k);}});
  const a=await pool.acquire('a',{});now=80;await pool.renew(a.leaseId);now=150;await assert.rejects(pool.acquire('b',{}),/capacity/);
  now=181;await pool.acquire('b',{});assert.deepEqual([...active],['b']);assert.deepEqual(events,['start:a','stop:a','start:b']);await assert.rejects(pool.renew(a.leaseId),/expired/);
});
test('human login isolates the desktop, binds its token to the human owner and excludes effects/removal',async()=>{
  const active=new Set();const pool=new BrowserPool({start:async key=>active.add(key),stop:async key=>active.delete(key),onHumanStart:async()=>({desktopPath})});
  const work=await pool.acquire('work',{});await assert.rejects(pool.withHuman(work.leaseId,()=>assert.fail('automation accessed desktop')),/Human/);
  await assert.rejects(pool.acquire('login',{}, {human:true}),/active browser/);await pool.release(work.leaseId);
  const human=await pool.acquire('login',{}, {human:true});assert.deepEqual([...active],['login']);
  await assert.rejects(pool.acquire('work',{}),/active browser/);await assert.rejects(pool.remove('login'),/reserved/);
  assert.equal(await pool.owner(human.leaseId,{human:true}),'login');
  assert.deepEqual(await pool.withHuman(human.leaseId,value=>value),{connectionId:'login',desktopPath});
  assert.equal(JSON.stringify(await pool.snapshot(['login'])).includes(desktopPath),false);
  await pool.release(human.leaseId);await assert.rejects(pool.withHuman(human.leaseId,()=>{}),/expired/);await pool.remove('login');assert.equal(active.size,0);
});
test('human release awaits token revocation and websocket termination before another profile starts',async()=>{
  const gate=deferred();const entered=deferred();const events=[];const pool=new BrowserPool({start:async k=>events.push('start:'+k),stop:async k=>events.push('stop:'+k),onHumanStart:async()=>({desktopPath}),onHumanEnd:async()=>{events.push('revoke');entered.resolve();await gate.promise;events.push('revoked');}});
  const human=await pool.acquire('login',{}, {human:true});const release=pool.release(human.leaseId);await entered.promise;
  const work=pool.acquire('work',{});await Promise.resolve();assert.deepEqual(events,['start:login','revoke']);
  gate.resolve();await release;await work;assert.deepEqual(events,['start:login','revoke','revoked','start:work']);
});
test('sweep, owner, snapshot and acquire revoke expired human leases rather than silently dropping ownership',async()=>{
  for(const operation of ['sweep','owner','snapshot','acquire']){
    let now=0;let revoked=false;const pool=new BrowserPool({now:()=>now,leaseMs:100,start:async()=>{},stop:async()=>{},onHumanStart:async()=>({desktopPath}),onHumanEnd:async()=>{revoked=true;}});
    const human=await pool.acquire('login',{}, {human:true});now=101;
    if(operation==='owner')await assert.rejects(pool.owner(human.leaseId),/expired/);
    else if(operation==='acquire')await pool.acquire('work',{});
    else await pool[operation](operation==='snapshot'?['login']:undefined);
    assert.equal(revoked,true,operation);assert.equal(pool.leases.has(human.leaseId),false);
  }
});
test('failed teardown retains ownership and blocks execution until a successful cleanup retry',async()=>{
  let fail=true;const started=[];const pool=new BrowserPool({start:async k=>started.push(k),stop:async()=>{},onHumanStart:async()=>({desktopPath}),onHumanEnd:async()=>{if(fail)throw new Error('websocket group still active');}});
  const human=await pool.acquire('login',{}, {human:true});await assert.rejects(pool.release(human.leaseId),/still active/);
  await assert.rejects(pool.acquire('work',{}),/active browser/);assert.deepEqual(started,['login']);
  fail=false;await pool.release(human.leaseId);await pool.acquire('work',{});assert.deepEqual(started,['login','work']);
});
test('inspection holds ownership until it completes; release cannot race a profile change',async()=>{
  const gate=deferred();const entered=deferred();const events=[];const pool=new BrowserPool({start:async()=>{},stop:async()=>{},onHumanStart:async()=>({desktopPath}),onHumanEnd:async()=>events.push('revoke')});
  const human=await pool.acquire('login',{}, {human:true});const inspection=pool.withHuman(human.leaseId,async()=>{entered.resolve();await gate.promise;events.push('inspected');});await entered.promise;
  const release=pool.release(human.leaseId);await Promise.resolve();assert.deepEqual(events,[]);gate.resolve();await inspection;await release;assert.deepEqual(events,['inspected','revoke']);
});
test('a failed view grant is cleaned up and never exposes an unvalidated desktop path',async()=>{
  let revoked=0;const pool=new BrowserPool({start:async()=>{},stop:async()=>{},onHumanStart:async()=>{throw new Error('proxy failed');},onHumanEnd:async()=>{revoked++;}});
  await assert.rejects(pool.acquire('login',{}, {human:true}),/proxy failed/);assert.equal(revoked,1);assert.equal(pool.leases.size,0);
  const invalid=new BrowserPool({start:async()=>{},stop:async()=>{},onHumanStart:async()=>({desktopPath:'websockify?token=wrong'})});const human=await invalid.acquire('login',{}, {human:true});
  await assert.rejects(invalid.withHuman(human.leaseId,()=>assert.fail('unvalidated desktop')),/unavailable/);await invalid.release(human.leaseId);
});
