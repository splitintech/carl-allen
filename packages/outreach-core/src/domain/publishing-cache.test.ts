import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, openSync, ftruncateSync, closeSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeDomainEnv, type DomainTestEnv } from './domain.test-util';
import { activeMediaReads, trimPublishingCache, verifyCachedMedia } from './publishing-cache';
import { publishingDirectory } from './publishing-files';
const cleanup:string[]=[];const environments:DomainTestEnv[]=[];
afterEach(()=>{activeMediaReads.clear();vi.unstubAllEnvs();for(const e of environments.splice(0))e.engine.db.close();for(const path of cleanup.splice(0))rmSync(path,{recursive:true,force:true});});
function directory(){const root=mkdtempSync(join(tmpdir(),'carl-media-cache-'));cleanup.push(root);vi.stubEnv('OUTREACH_MEDIA_DIR',root);return publishingDirectory('ws');}
describe('bounded private media cache',()=>{
 it('evicts only verified remote-ready assets while protecting local-only and active readers',async()=>{const f=await makeDomainEnv();environments.push(f);const root=directory();const bytes=100*1024*1024;const paths:string[]=[];
  for(let index=0;index<7;index++){const sha=String(index+1).padStart(64,'0');const path=join(root,sha);paths.push(path);const fd=openSync(path,'wx',0o600);ftruncateSync(fd,bytes);closeSync(fd);utimesSync(path,1000+index,1000+index);f.engine.db.prepare('INSERT INTO publishing_media(id,workspace_id,name,mime,size,sha256,created_at,remote_ready) VALUES (?,\'ws\',?,\'video/mp4\',?,?,?,?)').run('asset-'+index,'video-'+index,bytes,sha,f.now(),index===0?0:1);}
  activeMediaReads.set(paths[1]!,1);trimPublishingCache(f.engine,'ws','7'.padStart(64,'0'));
  expect(existsSync(paths[0]!)).toBe(true);expect(existsSync(paths[1]!)).toBe(true);expect(existsSync(paths[2]!)).toBe(false);expect(existsSync(paths[6]!)).toBe(true);expect(paths.slice(1).filter(existsSync)).toHaveLength(5);
 });
 it('invalidates its verification stamp when immutable local bytes change',()=>{const root=directory();const bytes=Buffer.from('approved bytes');const path=join(root,'asset');writeFileSync(path,bytes,{mode:0o600});const hash=createHash('sha256').update(bytes).digest('hex');verifyCachedMedia(path,bytes.length,hash);verifyCachedMedia(path,bytes.length,hash);writeFileSync(path,Buffer.from('tampered bytes'),{mode:0o600});expect(()=>verifyCachedMedia(path,bytes.length,hash)).toThrow(/checksum/);});
});
