import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstCommentIssues, probeVideoBytes, publishingVideoIssues } from '@splitin/outreach-contracts';
import { verifyCachedMedia } from './publishing-cache';
import { publishingDirectory } from './publishing-files';
import { ensurePublishingMediaLocal } from './publishing-durable';
import { mediaAsset } from './publishing-media';
import { getPublishingDraft } from './publishing-drafts';
import { getWorkPackage } from './work-packages';
import { ConflictError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import type { MediaRow } from './publishing-types';
import type { ActionRow, ExecutionDeps } from '../execution/types';
export function publicationMediaIssues(env:DomainEnv,ctx:AuthContext,channel:string,mediaIds:readonly string[]):string[]{
 const issues:string[]=[];
 for(const id of mediaIds){const asset=mediaAsset(env,ctx,id);if(!asset.mime.startsWith('video/'))continue;
  try{if(asset.mime!=='video/mp4')throw new Error('Re-export video as MP4 before scheduling.');const path=join(publishingDirectory(ctx.workspaceId),asset.sha256);verifyCachedMedia(path,asset.size,asset.sha256);const metadata=probeVideoBytes(readFileSync(path));verifyCachedMedia(path,asset.size,asset.sha256);issues.push(...publishingVideoIssues(channel,metadata).map(issue=>`${asset.name}: ${issue}`));}
  catch(error){issues.push(`${asset.name}: ${(error as Error).message}`);}
 }
 return issues;
}
/** Cloud copies are staged before synchronous exact-plan validation, outside its DB transaction. */
export async function stagePublishingDraftMedia(env:DomainEnv,ctx:AuthContext,id:string){requireRole(ctx,'operator');const draft=getPublishingDraft(env,ctx,id);for(const mediaId of new Set(draft.posts.flatMap(post=>post.mediaIds)))await ensurePublishingMediaLocal(env,ctx,mediaId);}
export async function stageWorkPackageMedia(env:DomainEnv,ctx:AuthContext,id:string){requireRole(ctx,'operator');const pack=getWorkPackage(env,ctx,id);for(const ref of pack.manifest?.media??[]){const mediaId=pack.mediaMap[ref.id];if(mediaId)await ensurePublishingMediaLocal(env,ctx,mediaId);}}
/** Called before a provider effect; the same immutable bytes are probed again after durable staging. */
export async function validatePublishingActionMedia(deps:ExecutionDeps,action:ActionRow):Promise<string[]>{
 if(action.kind!=='social.publish')return[];
 const payload=JSON.parse(action.payload) as {channel:string;mediaUrls?:string[]};const ids:string[]=[];
 const env:DomainEnv={db:deps.db,now:deps.now,adapters:deps.adapters,exec:deps};const ctx:AuthContext={workspaceId:action.workspace_id,principalId:'media-preflight',roles:['viewer'],source:'system',traceId:action.id};
 for(const ref of payload.mediaUrls??[]){if(!ref.startsWith('outreach-media:'))continue;const match=/^outreach-media:\/\/([a-f0-9]{64})$/.exec(ref);if(!match)return['Invalid immutable media reference; repair this publication.'];const asset=deps.db.prepare('SELECT * FROM publishing_media WHERE workspace_id=? AND sha256=?').get<MediaRow>(action.workspace_id,match[1]!);if(!asset)return['An approved media asset is missing from this workspace. Repair the publication before retrying.'];await ensurePublishingMediaLocal(env,ctx,asset.id);ids.push(asset.id);}
 return publicationMediaIssues(env,ctx,payload.channel,ids);
}
export function assertFirstComment(channel:string,text:string|undefined){const errors=firstCommentIssues(channel,text);if(errors.length)throw new ConflictError(errors.join('; '));}
