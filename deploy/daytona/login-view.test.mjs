import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {LoginView,terminateProcessGroup} from './login-view.mjs';
import {BrowserPool} from './browser-pool.mjs';
const {WebSocket}=globalThis;
const executable=process.env.OUTREACH_TEST_WEBSOCKIFY??'websockify';
const installed=spawnSync(executable,['--help'],{stdio:'ignore'}).status===0;
function fixture(){const root=mkdtempSync(join(tmpdir(),'outreach-login-view-'));const webRoot=join(root,'assets');mkdirSync(webRoot);writeFileSync(join(webRoot,'index.html'),'Private desktop assets');return{root,webRoot,tokenFile:join(root,'private','tokens')};}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function unusedPort(){const server=createServer();const port=await listen(server);await new Promise(resolve=>server.close(resolve));return port;}
async function until(fn,message){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw new Error(message);await delay(20);}}
function connectWebSocket(port,path){const ws=new WebSocket(`ws://127.0.0.1:${port}/${path}`,'binary');ws.binaryType='arraybuffer';const opened=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new Error('Websocket handshake timed out'));},4000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve(ws);},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Websocket authorization rejected'));},{once:true});});return{ws,opened};}
async function denied(port,path){const{ws,opened}=connectWebSocket(port,path);await assert.rejects(opened,/authorization rejected/);assert.notEqual(ws.readyState,WebSocket.OPEN);}
async function echo(ws,value){const received=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No websocket echo')),4000);ws.addEventListener('message',event=>{clearTimeout(timer);resolve(Buffer.from(event.data).toString());},{once:true});});ws.send(Buffer.from(value));assert.equal(await received,value);}

test('token allowlist is private, atomic, single-owner and never under served assets',()=>{
 const f=fixture();try{
  const view=new LoginView({...f});const token='a'.repeat(64);view.write(token);
  assert.equal(readFileSync(f.tokenFile,'utf8'),`${token}: 127.0.0.1:5900\n`);assert.equal(statSync(f.tokenFile).mode&0o777,0o600);assert.equal(statSync(join(f.root,'private')).mode&0o777,0o700);
  view.write('b'.repeat(64));assert.equal(readFileSync(f.tokenFile,'utf8').includes(token),false);view.write();assert.equal(readFileSync(f.tokenFile,'utf8'),'');
  chmodSync(f.tokenFile,0o644);assert.throws(()=>view.write(token),/owner-only/);chmodSync(f.tokenFile,0o600);
  const alias=join(f.root,'private','alias');symlinkSync(f.tokenFile,alias);assert.throws(()=>new LoginView({...f,tokenFile:alias}).write(token),/owner-only/);
  assert.throws(()=>new LoginView({...f,tokenFile:join(f.webRoot,'tokens')}),/outside/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('proxy launch has no fallback VNC target and refuses a preexisting listener',async()=>{
 const f=fixture();let spawnCount=0;try{
  const view=new LoginView({...f,portListening:async()=>true,spawnProcess:()=>{spawnCount++;}});
  await assert.rejects(view.grant(),/already owned/);assert.equal(spawnCount,0);assert.equal(readFileSync(f.tokenFile,'utf8'),'');await view.close();
  let args;let live=false;const child={pid:12345,exitCode:null,killed:false,once(){}};
  const isolated=new LoginView({...f,portListening:async()=>live,spawnProcess:(_exe,values,options)=>{args=values;assert.equal(options.detached,true);live=true;return child;},killGroup:async()=>{live=false;}});
  const grant=await isolated.grant();assert.match(grant.desktopPath,/^websockify\?token=[a-f0-9]{64}$/);assert.ok(args.includes('--token-plugin=TokenFile'));assert.ok(args.includes('--token-source='+f.tokenFile));assert.ok(!args.includes('127.0.0.1:5900'));
  await isolated.close();assert.equal(readFileSync(f.tokenFile,'utf8'),'');await assert.rejects(isolated.grant(),/shutting down/);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('teardown failure clears authorization and retains the child for a later cleanup retry',async()=>{
 const f=fixture();let live=false;let fail=true;let stops=0;try{
  const child={pid:12345,exitCode:null,killed:false,once(){}};
  const view=new LoginView({...f,portListening:async()=>live,spawnProcess:()=>{live=true;return child;},killGroup:async()=>{stops++;if(fail)throw new Error('group active');live=false;}});
  await view.grant();await assert.rejects(view.revoke(),/group active/);assert.equal(readFileSync(f.tokenFile,'utf8'),'');assert.equal(view.child,child);
  fail=false;await view.close();assert.equal(stops,2);assert.equal(view.child,null);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('POSIX teardown kills a detached parent and its forked descendant', {skip:process.platform==='win32'},async()=>{
 const child=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const fork=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(fork.pid);setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','ignore']});
 let descendant;try{
  descendant=await new Promise((resolve,reject)=>{child.stdout.once('data',v=>resolve(Number(v.toString().trim())));child.once('error',reject);});assert.ok(descendant>0);process.kill(descendant,0);
  await terminateProcessGroup(child);assert.throws(()=>process.kill(-child.pid,0),{code:'ESRCH'});assert.throws(()=>process.kill(descendant,0),{code:'ESRCH'});
 }finally{await terminateProcessGroup(child).catch(()=>{});}
});
test('REAL websockify rejects raw/stale tokens and drops existing sockets on release and expiry before future work', {skip:!installed&&'Install websockify or set OUTREACH_TEST_WEBSOCKIFY; this test uses the real executable',timeout:45000},async()=>{
 const f=fixture();const sockets=new Set();let connections=0;const target=createServer(socket=>{connections++;sockets.add(socket);socket.on('data',data=>socket.write(data));socket.on('close',()=>sockets.delete(socket));});let view;let opened=[];
 try{
  const targetPort=await listen(target);const port=await unusedPort();view=new LoginView({...f,port,target:`127.0.0.1:${targetPort}`,executable,logFile:join(f.root,'private','proxy.log')});await view.start();
  assert.equal(view.healthy,true);assert.equal(await (await fetch(`http://127.0.0.1:${port}/index.html`)).text(),'Private desktop assets');
  await denied(port,'websockify');await denied(port,'websockify?token='+'0'.repeat(64));assert.equal(connections,0);
  let now=0;const effects=[];const pool=new BrowserPool({now:()=>now,leaseMs:100,start:async key=>{if(key.startsWith('work')){assert.equal(sockets.size,0,'old websocket must end before future work');assert.equal(readFileSync(f.tokenFile,'utf8'),'');}effects.push(key);},stop:async()=>{},onHumanStart:()=>view.grant(),onHumanEnd:()=>view.revoke()});
  const human=await pool.acquire('login-a',{}, {human:true});const first=await pool.withHuman(human.leaseId,value=>value.desktopPath);const ws=await connectWebSocket(port,first).opened;opened.push(ws);await echo(ws,'first private desktop');assert.equal(sockets.size,1);
  const priorPid=view.child.pid;await pool.release(human.leaseId);await until(()=>ws.readyState===WebSocket.CLOSED&&sockets.size===0,'Released viewer remained connected');assert.throws(()=>process.kill(-priorPid,0),{code:'ESRCH'});
  await denied(port,first);const work=await pool.acquire('work-a',{});await pool.release(work.leaseId);
  const secondHuman=await pool.acquire('login-b',{}, {human:true});const second=await pool.withHuman(secondHuman.leaseId,value=>value.desktopPath);assert.notEqual(second,first);await denied(port,first);
  const secondWs=await connectWebSocket(port,second).opened;opened.push(secondWs);await echo(secondWs,'second private desktop');assert.equal(readFileSync(f.tokenFile,'utf8').split('\n').filter(Boolean).length,1);
  now=101;await pool.acquire('work-b',{});await until(()=>secondWs.readyState===WebSocket.CLOSED&&sockets.size===0,'Expired viewer remained connected');await denied(port,second);assert.deepEqual(effects,['login-a','work-a','login-b','work-b']);
  assert.equal(JSON.stringify(await pool.snapshot(['login-b'])).includes('token='),false);
 }finally{for(const ws of opened)if(ws.readyState!==WebSocket.CLOSED)ws.close();await view?.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>target.close(resolve));rmSync(f.root,{recursive:true,force:true});}
});
