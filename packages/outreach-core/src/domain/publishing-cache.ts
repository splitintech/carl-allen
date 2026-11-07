import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainEnv } from './env';
import { publishingDirectory, digestMedia, verifyMediaFile } from './publishing-files';
/** Only verified remote assets may be evicted. Uploads and local-only legacy assets are retained. */
const verified = new Map<string, string>();
export const activeMediaReads = new Map<string, number>();
export function verifyCachedMedia(path: string, size: number, hash: string): void {
  verifyMediaFile(path, size); const info=lstatSync(path);
  const stamp=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
  if(verified.get(path)===stamp)return;
  if(digestMedia(path).sha256!==hash)throw new Error('Stored media checksum mismatch');
  if(verified.size>=1000)verified.delete(verified.keys().next().value!);
  verified.set(path,stamp);
}
export function trimPublishingCache(env: DomainEnv, workspaceId: string, keep?: string): void {
  const root=publishingDirectory(workspaceId); const cap=512*1024*1024;
  const files=env.db.prepare('SELECT sha256,size FROM publishing_media WHERE workspace_id=? AND remote_ready=1 GROUP BY sha256').all<{sha256:string;size:number}>(workspaceId).flatMap(row=>{
    const path=join(root,row.sha256); if(!existsSync(path))return[];
    verifyMediaFile(path,row.size); return [{...row,path,used:lstatSync(path).mtimeMs}];
  }).sort((a,b)=>a.used-b.used);
  let total=files.reduce((n,f)=>n+f.size,0);
  for(const file of files){if(total<=cap)break;if(file.sha256===keep||activeMediaReads.has(file.path))continue;unlinkSync(file.path);verified.delete(file.path);total-=file.size;}
}
