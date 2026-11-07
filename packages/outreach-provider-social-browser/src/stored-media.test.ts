import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProviderContext } from '@splitin/outreach-contracts';
import { loadStoredMedia } from './stored-media';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
const hash=createHash('sha256').update(bytes).digest('hex');
function context():ProviderContext{return{workspaceId:'ws',account:{id:'account',provider:'social-browser',externalAccountId:'profile',sender:{name:'Owner',address:'owner@example.invalid'}},secretRef:'env:SOCIAL',secrets:{get:async()=>''},traceId:'fixture',signal:AbortSignal.timeout(5000),now:()=>1700000000000};}
async function root(){const path=await mkdtemp(join(tmpdir(),'carl-execution-media-'));roots.push(path);return path;}
describe('private execution staging',()=>{
 it('isolates concurrent readers and cleans each temporary download after immutable bytes are loaded',async()=>{const directory=await root();const destinations:string[]=[];const stage=async(_ctx:ProviderContext,actual:string,path:string)=>{expect(actual).toBe(hash);destinations.push(path);await writeFile(path,bytes,{mode:0o600});};const [one,two]=await Promise.all([loadStoredMedia(context(),'outreach-media://'+hash,directory,stage),loadStoredMedia(context(),'outreach-media://'+hash,directory,stage)]);expect(one.buffer.equals(bytes)).toBe(true);expect(two.buffer.equals(bytes)).toBe(true);expect(new Set(destinations).size).toBe(2);expect(await readdir(directory)).toEqual([]);});
 it('rejects corrupt staged bytes and removes the failed execution directory',async()=>{const directory=await root();await expect(loadStoredMedia(context(),'outreach-media://'+hash,directory,async(_ctx,_hash,path)=>{await writeFile(path,Buffer.from('unapproved bytes'),{mode:0o600});})).rejects.toThrow(/approved content hash/);expect(await readdir(directory)).toEqual([]);});
 it('removes partial files when the remote stage operation fails',async()=>{const directory=await root();await expect(loadStoredMedia(context(),'outreach-media://'+hash,directory,async(_ctx,_hash,path)=>{await writeFile(path,bytes.subarray(0,10),{mode:0o600});throw new Error('Cloud receipt unavailable');})).rejects.toThrow(/receipt unavailable/);expect(await readdir(directory)).toEqual([]);});
});
