import {createHash} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {ConflictError,ForbiddenError} from '@splitin/outreach-core';
export interface LoginBinding {kind:string;connectionId?:string;expectedProfileUrl?:string;loginProfileUrl?:string;publishingProfileUrl?:string;cdpUrl:string;userDataDir:string}
function file(){const path=process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE??process.env.OUTREACH_SOCIAL_BINDINGS_FILE;if(!path)throw new ConflictError('Browser profile storage is not configured');return path;}
export function readLoginBindings():Record<string,LoginBinding>{
 const path=file();if(!existsSync(path))return{};const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw new ForbiddenError('Browser bindings require an owner-only regular file');
 return JSON.parse(readFileSync(path,'utf8')) as Record<string,LoginBinding>;
}
export function updateLoginBindings<T>(change:(bindings:Record<string,LoginBinding>)=>T):T{
 const path=file();mkdirSync(dirname(path),{recursive:true,mode:0o700});const lock=path+'.lock';let fd:number;
 try{fd=openSync(lock,'wx',0o600);}catch{throw new ConflictError('Another browser connection is being configured; try again');}
 try{const bindings=readLoginBindings();const result=change(bindings);const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(bindings)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path);return result;}
 finally{closeSync(fd);unlinkSync(lock);}
}
export async function updateLoginBindingsAsync<T>(change:(bindings:Record<string,LoginBinding>)=>Promise<T>):Promise<T>{
 const path=file();mkdirSync(dirname(path),{recursive:true,mode:0o700});const lock=path+'.lock';let fd:number;
 try{fd=openSync(lock,'wx',0o600);}catch{throw new ConflictError('Another browser connection is being configured; try again');}
 try{const bindings=readLoginBindings();const result=await change(bindings);const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(bindings)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path);return result;}finally{closeSync(fd);unlinkSync(lock);}
}
export function newLoginBinding(channel:string,key:string):LoginBinding{
 const used=new Set(Object.values(readLoginBindings()).map(b=>new URL(b.cdpUrl).port));let port=9222;while(used.has(String(port))&&port<10000)port++;if(port>=10000)throw new ConflictError('No browser ports available');
 const root=process.env.OUTREACH_CHROME_PROFILE_DIR??process.env.OUTREACH_CHROME_PROFILES_DIR??'/data/chrome-profiles';
 return{kind:channel,connectionId:key,cdpUrl:`http://127.0.0.1:${port}`,userDataDir:join(root,createHash('sha256').update(key).digest('hex').slice(0,24))};
}
export async function supervisedBrowser(path:string,data:unknown):Promise<Record<string,unknown>>{
 if(process.platform!=='linux'||!process.env.DAYTONA_SANDBOX_ID||process.env.OUTREACH_BROWSER_POOL_URL!=='http://127.0.0.1:8788')throw new ConflictError('Connect accounts through the Daytona runtime');
 const response=await fetch('http://127.0.0.1:8788'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(35000)});
 const value=await response.json() as Record<string,unknown>;if(!response.ok)throw new ConflictError(String(value.error??'Browser is busy; finish the other connection first'));return value;
}
