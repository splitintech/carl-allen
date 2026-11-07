import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageMediaByHash, stageImmutableMedia, putImmutableMedia } from './r2-storage';
const roots:string[]=[];const secret='fixture-private-media-secret-at-least32characters';
const bytes=Buffer.from('immutable fixture media bytes');const hash=createHash('sha256').update(bytes).digest('hex');
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function directory(){const root=mkdtempSync(join(tmpdir(),'carl-r2-stage-'));roots.push(root);vi.stubEnv('OUTREACH_MEDIA_GATEWAY','https://carl.example.invalid');vi.stubEnv('CLOUD_MEDIA_SECRET',secret);return root;}
function metadata(){return{'content-type':'image/png','content-length':String(bytes.length),'x-carl-sha256':hash};}
describe('private immutable R2 staging',()=>{
 it('binds every metadata/download request to its workspace, method, content and private service signature',async()=>{const root=directory();const methods:string[]=[];vi.stubGlobal('fetch',async(url:string,options:RequestInit)=>{const headers=options.headers as Record<string,string>;const claim=JSON.parse(Buffer.from(headers['x-carl-media']!,'base64url').toString());expect(createHmac('sha256',secret).update(headers['x-carl-media']!).digest('hex')).toBe(headers['x-carl-media-signature']);expect(claim).toMatchObject({workspaceId:'ws',sha256:hash,method:options.method??'GET',path:'/internal/media/ws/'+hash});expect(url).toBe('https://carl.example.invalid/internal/media/ws/'+hash);methods.push(claim.method);return new Response(claim.method==='HEAD'?null:bytes,{headers:metadata()});});const path=join(root,hash);await stageMediaByHash('ws',hash,path);expect(methods).toEqual(['HEAD','GET']);expect(existsSync(path)).toBe(true);expect(readdirSync(root)).toEqual([hash]);});
 it('rejects corrupted cloud bytes without finalizing a file or leaving partial downloads',async()=>{const root=directory();const corrupted=Buffer.from(bytes);corrupted[0]=corrupted[0]!^1;vi.stubGlobal('fetch',async()=>new Response(corrupted,{headers:metadata()}));await expect(stageImmutableMedia('ws',hash,join(root,hash),'image/png',bytes.length)).rejects.toThrow(/checksum/);expect(readdirSync(root)).toEqual([]);});
 it('does not accept a successful HTTP response as an immutable upload receipt',async()=>{const root=directory();const path=join(root,hash);writeFileSync(path,bytes,{mode:0o600});vi.stubGlobal('fetch',async()=>Response.json({stored:true,sha256:hash,size:bytes.length+1}));await expect(putImmutableMedia('ws',hash,path,'image/png')).rejects.toThrow(/receipt mismatch/);});
 it('supports simultaneous verified downloads without temporary-file collisions',async()=>{const root=directory();vi.stubGlobal('fetch',async()=>new Response(bytes,{headers:metadata()}));const path=join(root,hash);await Promise.all([stageImmutableMedia('ws',hash,path,'image/png',bytes.length),stageImmutableMedia('ws',hash,path,'image/png',bytes.length)]);expect(readdirSync(root)).toEqual([hash]);});
});
