#!/usr/bin/env node
// Encrypted recovery exports are opt-in. Never snapshot a live Chrome profile.
import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const chunkBytes=16*1024*1024;
function key(){const value=Buffer.from(process.env.OUTREACH_RECOVERY_KEY??'','base64');if(value.length!==32)throw new Error('OUTREACH_RECOVERY_KEY must contain32 random bytes encoded as base64');return value;}
function privateDirectory(path){mkdirSync(path,{recursive:true,mode:0o700});const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o077||(process.getuid&&s.uid!==process.getuid()))throw new Error('Recovery destination must be a private owned directory');}
function regular(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw new Error('Recovery source must be a regular file');return s;}
function save(path,data){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,data);}finally{closeSync(fd);}}
export function sealFile(source,destination,kind,id){
  regular(source);const fd=openSync(source,'r');const parts=[];const buffer=Buffer.alloc(chunkBytes);let index=0;
  try{for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(`${id}:${kind}:${index}`));const body=Buffer.concat([cipher.update(buffer.subarray(0,count)),cipher.final()]);const encrypted=Buffer.concat([iv,cipher.getAuthTag(),body]);const sha256=createHash('sha256').update(encrypted).digest('hex');save(join(destination,sha256),encrypted);parts.push({sha256,size:encrypted.length,index});index++;}}
  finally{closeSync(fd);}return{kind,bytes:regular(source).size,parts};
}
export function restoreFile(bundle,entry,output,id){
  if(!Array.isArray(entry.parts)||entry.parts.some((p,i)=>p.index!==i||!/^[a-f0-9]{64}$/.test(p.sha256)||p.size>chunkBytes+28))throw new Error('Invalid recovery manifest');
  const fd=openSync(output,'wx',0o600);let written=0;let complete=false;
  try{for(const p of entry.parts){const source=join(bundle,p.sha256);regular(source);const encrypted=readFileSync(source);if(encrypted.length!==p.size||createHash('sha256').update(encrypted).digest('hex')!==p.sha256)throw new Error('Recovery checksum mismatch');const cipher=createDecipheriv('aes-256-gcm',key(),encrypted.subarray(0,12));cipher.setAuthTag(encrypted.subarray(12,28));cipher.setAAD(Buffer.from(`${id}:${entry.kind}:${p.index}`));const bytes=Buffer.concat([cipher.update(encrypted.subarray(28)),cipher.final()]);writeSync(fd,bytes);written+=bytes.length;}if(written!==entry.bytes)throw new Error('Recovery size mismatch');complete=true;}
  finally{closeSync(fd);if(!complete)rmSync(output,{force:true});}
}
async function upload(workspaceId,path){
  const gateway=new URL(process.env.OUTREACH_MEDIA_GATEWAY??'');const secret=process.env.CLOUD_MEDIA_SECRET;
  if(gateway.protocol!=='https:'||gateway.pathname!=='/'||gateway.search||gateway.hash||gateway.username||gateway.password||!secret||secret.length<32||!/^[A-Za-z0-9_-]{1,200}$/.test(workspaceId))throw new Error('Private recovery storage is not configured');
  const body=readFileSync(path);const sha256=basename(path);gateway.pathname=`/internal/media/${workspaceId}/${sha256}`;const iat=Math.floor(Date.now()/1000);
  const claim=Buffer.from(JSON.stringify({workspaceId,sha256,mime:'application/octet-stream',size:body.length,method:'PUT',path:gateway.pathname,iat,exp:iat+45,jti:randomBytes(18).toString('base64url')})).toString('base64url');
  const response=await fetch(gateway,{method:'PUT',headers:{'content-type':'application/octet-stream','x-carl-media':claim,'x-carl-media-signature':createHmac('sha256',secret).update(claim).digest('hex')},body,redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error('Recovery upload failed');const receipt=await response.json();if(!receipt.stored||receipt.sha256!==sha256||receipt.size!==body.length)throw new Error('Recovery receipt mismatch');
}
export async function exportRecovery({database,output,workspaceId,profileArchive,uploadCloud=false}){
  key();if(existsSync(output))throw new Error('Use a new recovery output directory');privateDirectory(output);const snapshot=join(output,'snapshot.sqlite');const metadata=join(output,'metadata.json');const id=randomBytes(18).toString('hex');
  try{
    const db=new DatabaseSync(database,{readOnly:true});try{db.prepare('VACUUM main INTO ?').run(snapshot);}finally{db.close();}
    const copy=new DatabaseSync(snapshot,{readOnly:true});let refs,migrations;try{if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||copy.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Snapshot integrity failed');refs=copy.prepare('SELECT workspace_id,id,sha256,size,mime,remote_ready FROM publishing_media').all();migrations=copy.prepare('SELECT id,sha256 FROM schema_migrations ORDER BY id').all();}finally{copy.close();}
    if(refs.some(r=>!r.remote_ready)&&uploadCloud)throw new Error('Cloud recovery requires verified R2 copies for all media; local-only media must be migrated first');
    save(metadata,JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),migrations,media:refs}));
    const files=[sealFile(snapshot,output,'database',id),sealFile(metadata,output,'metadata',id)];
    if(profileArchive)files.push(sealFile(profileArchive,output,'browser-profiles',id));
    const manifest={schemaVersion:1,id,files,profileRecovery:profileArchive?'included-separately':'not-included',cloudStored:false};
    if(uploadCloud){for(const f of files)for(const p of f.parts)await upload(workspaceId,join(output,p.sha256));manifest.cloudStored=true;}
    manifest.signature=createHmac('sha256',key()).update(JSON.stringify(manifest)).digest('hex');
    save(join(output,'recovery.json'),JSON.stringify(manifest,null,2));
    if(uploadCloud){const index=sealFile(join(output,'recovery.json'),output,'index',id);for(const p of index.parts)await upload(workspaceId,join(output,p.sha256));save(join(output,'cloud-receipt.json'),JSON.stringify({id,index},null,2));}
    return manifest;
  }finally{rmSync(snapshot,{force:true});rmSync(metadata,{force:true});}
}
async function main(){const [command,...args]=process.argv.slice(2);const flags=Object.fromEntries(args.map((arg,i)=>arg.startsWith('--')?[arg.slice(2),args[i+1]]:null).filter(Boolean));
  if(command==='export'){if(!flags.database||!flags.output)throw new Error('export --database <db> --output <new-private-dir> [--workspace <id> --cloud yes] [--profile-archive <quiesced.tar.gz>]');const result=await exportRecovery({database:resolve(flags.database),output:resolve(flags.output),workspaceId:flags.workspace,profileArchive:flags['profile-archive']?resolve(flags['profile-archive']):undefined,uploadCloud:flags.cloud==='yes'});console.log(JSON.stringify({id:result.id,output:resolve(flags.output),files:result.files.map(f=>({kind:f.kind,bytes:f.bytes,chunks:f.parts.length})),cloudStored:result.cloudStored,profileRecovery:result.profileRecovery}));}
  else if(command==='restore'){if(!flags.bundle||!flags.output)throw new Error('restore --bundle <recovery-dir> --output <new-private-dir>');const bundle=resolve(flags.bundle);const manifest=JSON.parse(readFileSync(join(bundle,'recovery.json'),'utf8'));const signature=manifest.signature;delete manifest.signature;const expected=createHmac('sha256',key()).update(JSON.stringify(manifest)).digest('hex');if(typeof signature!=='string'||signature.length!==64||!timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))throw new Error('Recovery manifest authentication failed');if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||!/^[a-f0-9]{36}$/.test(manifest.id))throw new Error('Invalid recovery manifest');if(existsSync(flags.output))throw new Error('Restore output must not exist');privateDirectory(flags.output);for(const entry of manifest.files){if(!['database','metadata','browser-profiles'].includes(entry.kind))throw new Error('Unknown recovery artifact');restoreFile(bundle,entry,join(flags.output,entry.kind==='database'?'outreach.sqlite':entry.kind==='metadata'?'metadata.json':'browser-profiles.tar.gz'),manifest.id);}console.log(JSON.stringify({restored:true,output:resolve(flags.output),activation:'manual-after-integrity-review'}));}
  else throw new Error('Use export or restore');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
