import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeVideoBytes } from './media-probe';
import { firstCommentIssues, publishingVideoIssues } from './publishing';
const root=mkdtempSync(join(tmpdir(),'actual-ffprobe-'));const clips=new Map<string,Buffer>();
beforeAll(()=>{
 for(const[name,size,duration,codec,rate]of[['valid','320x320','3','libx264','25'],['codec','320x320','3','mpeg4','25'],['dimensions','16x16','3','libx264','25'],['duration','320x320','141','libx264','1'],['large','640x640','3','libx264','25']]){
  const path=join(root,name+'.mp4');execFileSync(process.env.OUTREACH_FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i',name==='large'?`testsrc2=s=${size}:r=${rate}:d=${duration}`:`color=c=black:s=${size}:r=${rate}:d=${duration}`,'-c:v',codec!,...(name==='large'?['-preset','ultrafast','-crf','0']:[]),'-pix_fmt','yuv420p','-threads','1','-movflags','+faststart','-an','-y',path],{timeout:30000});clips.set(name!,readFileSync(path));
 }
},60000);
afterAll(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
it('probes actual generated MP4 bytes for duration, dimensions, codec and frame rate without changing their hash',()=>{
 const bytes=clips.get('valid')!;const before=createHash('sha256').update(bytes).digest('hex');const metadata=probeVideoBytes(bytes);
 expect(metadata).toMatchObject({width:320,height:320,videoCodec:'h264',pixelFormat:'yuv420p',durationSeconds:3,frameRate:25,audioCodecs:[]});expect(publishingVideoIssues('linkedin',metadata)).toEqual([]);expect(createHash('sha256').update(bytes).digest('hex')).toBe(before);
});
it('rejects real MP4 codec, duration and dimension incompatibilities with explicit repair advice',()=>{
 expect(publishingVideoIssues('linkedin',probeVideoBytes(clips.get('codec')!)).join(' ')).toContain('H.264');expect(publishingVideoIssues('linkedin',probeVideoBytes(clips.get('dimensions')!)).join(' ')).toContain('dimensions');expect(publishingVideoIssues('x',probeVideoBytes(clips.get('duration')!)).join(' ')).toContain('0.5–140 seconds');
});
it('fails closed for malformed bytes and a missing ffprobe installation instead of fabricating metadata',()=>{
 expect(()=>probeVideoBytes(Buffer.alloc(64))).toThrow('inspection failed');vi.stubEnv('OUTREACH_FFPROBE_PATH',join(root,'not-installed'));expect(()=>probeVideoBytes(clips.get('valid')!)).toThrow('Install ffprobe');vi.unstubAllEnvs();
});
it('uses one platform comment policy for exact boundaries, whitespace, UTF-16 units and unsupported platforms',()=>{
 expect(firstCommentIssues('linkedin','a'.repeat(1000))).toEqual([]);expect(firstCommentIssues('linkedin','a'.repeat(1001)).join(' ')).toContain('1000');expect(firstCommentIssues('instagram','a'.repeat(2200))).toEqual([]);expect(firstCommentIssues('instagram','a'.repeat(2201)).join(' ')).toContain('2200');expect(firstCommentIssues('linkedin','🙂'.repeat(501))).not.toEqual([]);expect(firstCommentIssues('linkedin','   ')).not.toEqual([]);expect(firstCommentIssues('x','No comment')).not.toEqual([]);expect(firstCommentIssues('x',undefined)).toEqual([]);
});

it('accepts a real multi-megabyte video when ffprobe closes its input after a complete successful metadata read',()=>{const bytes=clips.get('large')!;expect(bytes.length).toBeGreaterThan(1024*1024);expect(probeVideoBytes(bytes)).toMatchObject({width:640,height:640,durationSeconds:3,videoCodec:'h264'});});
