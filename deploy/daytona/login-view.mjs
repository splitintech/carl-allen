import {randomBytes,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
const gone=pid=>{try{process.kill(-pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}};
/** Kill the entire detached POSIX process group, including websockify forked websocket handlers. */
export async function terminateProcessGroup(child,{graceMs=1000,killWaitMs=3000}={}){
 if(!child?.pid)return;
 const signal=name=>{try{process.kill(-child.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}};
 signal('SIGTERM');let end=Date.now()+graceMs;while(!gone(child.pid)&&Date.now()<end)await delay(20);
 if(gone(child.pid))return;signal('SIGKILL');end=Date.now()+killWaitMs;
 while(!gone(child.pid)&&Date.now()<end)await delay(20);
 if(!gone(child.pid))throw new Error('Private desktop process group is still active; browser work remains held');
}
function listening(port){return new Promise(resolve=>{const socket=connect({host:'127.0.0.1',port:Number(port)});const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(250,()=>done(false));});}
/** TokenFile reloads a private `token: host:port` allowlist on every websocket handshake. */
export class LoginView {
 constructor({tokenFile,port=6080,target='127.0.0.1:5900',webRoot='/usr/share/novnc',executable='websockify',logFile,spawnProcess=spawn,killGroup=terminateProcessGroup,portListening=listening}){
  if(!/^127\.0\.0\.1:\d+$/.test(target)||!Number.isInteger(Number(port))||Number(port)<1024||Number(port)>65535)throw new Error('Invalid private desktop listener');
  if(typeof tokenFile!=='string'||resolve(tokenFile)===resolve(webRoot)||resolve(tokenFile).startsWith(resolve(webRoot)+sep))throw new Error('Private desktop token file must be outside the static web root');
  Object.assign(this,{tokenFile,port:Number(port),target,webRoot,executable,logFile,spawnProcess,killGroup,portListening});this.child=null;this.failed=false;this.tail=Promise.resolve();this.closed=false;
 }
 write(token=''){
  const directory=dirname(this.tokenFile);mkdirSync(directory,{recursive:true,mode:0o700});const parent=lstatSync(directory);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077)throw new Error('Private desktop token directory must be owner-only');
  if(existsSync(this.tokenFile)){const info=lstatSync(this.tokenFile);if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw new Error('Private desktop token file must be owner-only');}
  const temporary=this.tokenFile+'.'+randomUUID();writeFileSync(temporary,token?`${token}: ${this.target}\n`:'',{mode:0o600,flag:'wx'});renameSync(temporary,this.tokenFile);
 }
 get healthy(){return Boolean(this.child&&this.child.exitCode===null&&!this.child.killed&&!this.failed);}
 async stop(){if(!this.child)return;const child=this.child;await this.killGroup(child);this.child=null;}
 async launch(){
  if(await this.portListening(this.port))throw new Error('Private desktop port is already owned; no browser work was started');
  // Debian's older websockify has TokenFile but lacks the optional listing flag.
  // Authorization always comes from TokenFile, whose file stays outside webRoot.
  const help=spawnSync(this.executable,['--help'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000,maxBuffer:131072});
  const args=[`--web=${this.webRoot}`,...(help.stdout?.includes('--file-only')?['--file-only']:[]),'--token-plugin=TokenFile',`--token-source=${this.tokenFile}`,String(this.port)];
  const descriptor=this.logFile?openSync(this.logFile,'a',0o600):null;
  try{this.child=this.spawnProcess(this.executable,args,{detached:true,stdio:descriptor===null?'ignore':['ignore',descriptor,descriptor]});}finally{if(descriptor!==null)closeSync(descriptor);}
  this.failed=false;const child=this.child;child.once('error',()=>{if(this.child===child)this.failed=true;});
  const end=Date.now()+20000;while(Date.now()<end){if(this.failed||child.exitCode!==null)throw new Error('Private desktop proxy did not start');if(await this.portListening(this.port))return;await delay(50);}
  throw new Error('Private desktop proxy readiness timed out');
 }
 async reset(token=''){
  this.write();await this.stop();this.write(token);
  try{await this.launch();}catch(error){this.write();await this.stop();throw error;}
 }
 run(task){const next=this.tail.then(task,task);this.tail=next.catch(()=>undefined);return next;}
 start(){return this.run(()=>{if(this.closed)throw new Error('Private desktop is shutting down');return this.reset();});}
 grant(){return this.run(async()=>{if(this.closed)throw new Error('Private desktop is shutting down');const token=randomBytes(32).toString('hex');await this.reset(token);return{desktopPath:'websockify?token='+token};});}
 revoke(){return this.run(async()=>{if(this.closed){this.write();await this.stop();return;}await this.reset();});}
 close(){this.closed=true;return this.run(async()=>{this.write();await this.stop();});}
}
