import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { exportRecovery, restoreFile, sealFile } from './cloud-recovery.mjs';
process.env.OUTREACH_RECOVERY_KEY=Buffer.alloc(32,7).toString('base64');
test('consistent encrypted database+media metadata restores; a changed manifest cannot activate',async()=>{
 const root=mkdtempSync(join(tmpdir(),'carl-recovery-'));try{
 const database=join(root,'live.sqlite');const db=new DatabaseSync(database);db.exec("PRAGMA journal_mode=WAL;CREATE TABLE schema_migrations(id TEXT,sha256 TEXT);INSERT INTO schema_migrations VALUES('test','hash');CREATE TABLE publishing_media(workspace_id TEXT,id TEXT,sha256 TEXT,size INTEGER,mime TEXT,remote_ready INTEGER);INSERT INTO publishing_media VALUES('ws','asset','approved-hash',42,'image/png',1)");
 const bundle=join(root,'bundle');const result=await exportRecovery({database,output:bundle,workspaceId:'ws'});db.close();assert.equal(result.files.length,2);assert.equal(result.profileRecovery,'not-included');
 const ciphertext=readFileSync(join(bundle,result.files[0].parts[0].sha256));assert.equal(ciphertext.includes(Buffer.from('approved-hash')),false);
 execFileSync(process.execPath,['scripts/cloud-recovery.mjs','restore','--bundle',bundle,'--output',join(root,'restored')]);const restored=new DatabaseSync(join(root,'restored','outreach.sqlite'),{readOnly:true});assert.equal(restored.prepare('SELECT sha256 FROM publishing_media').get().sha256,'approved-hash');restored.close();
 const manifest=JSON.parse(readFileSync(join(bundle,'recovery.json'),'utf8'));manifest.files=[];writeFileSync(join(bundle,'recovery.json'),JSON.stringify(manifest));assert.throws(()=>execFileSync(process.execPath,['scripts/cloud-recovery.mjs','restore','--bundle',bundle,'--output',join(root,'invalid')],{stdio:'pipe'}));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('recovery chunks authenticate order, wrong keys and corruption across16MB boundaries',()=>{
 const root=mkdtempSync(join(tmpdir(),'carl-recovery-parts-'));try{const source=join(root,'profiles.tar');const bytes=Buffer.alloc(17*1024*1024,35);writeFileSync(source,bytes);const bundle=join(root,'parts');mkdirSync(bundle,{mode:0o700});const entry=sealFile(source,bundle,'browser-profiles','fixture');assert.equal(entry.parts.length,2);restoreFile(bundle,entry,join(root,'recovered.tar'),'fixture');assert.deepEqual(readFileSync(join(root,'recovered.tar')),bytes);
 const original=process.env.OUTREACH_RECOVERY_KEY;process.env.OUTREACH_RECOVERY_KEY=Buffer.alloc(32,8).toString('base64');assert.throws(()=>restoreFile(bundle,entry,join(root,'wrong.tar'),'fixture'));process.env.OUTREACH_RECOVERY_KEY=original;const part=join(bundle,entry.parts[0].sha256);const changed=readFileSync(part);changed[40]^=1;writeFileSync(part,changed);assert.throws(()=>restoreFile(bundle,entry,join(root,'bad.tar'),'fixture'),/checksum/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
