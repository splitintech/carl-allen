import { activeMediaReads, trimPublishingCache, verifyCachedMedia } from './publishing-cache';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { completePublishingUpload, deletePublishingMedia, mediaAsset, readPublishingMedia, reclaimPublishingMediaFile } from './publishing-media';
import { publishingDirectory } from './publishing-files';
import { configuredMediaStore, deleteImmutableMedia, putImmutableMedia, stageImmutableMedia } from './r2-storage';
import type { PublishingAsset, MediaRow } from './publishing-types';

export async function ensurePublishingMediaLocal(env: DomainEnv, ctx: AuthContext, id: string): Promise<MediaRow> {
  requireRole(ctx, 'viewer'); const row = mediaAsset(env, ctx, id) as MediaRow & { remote_ready?: number };
  const path = join(publishingDirectory(ctx.workspaceId), row.sha256);
  if (!existsSync(path)) {
    if (!row.remote_ready) throw new Error('Media has no verified cloud copy');
    await stageImmutableMedia(ctx.workspaceId, row.sha256, path, row.mime, row.size);
  }
  verifyCachedMedia(path, row.size, row.sha256);
  return row;
}
/** Completion can be retried after transport/R2 failure; a cloud receipt is issued only after checksum-confirmed storage. */
export async function completePublishingUploadDurable(env: DomainEnv, ctx: AuthContext, id: string): Promise<PublishingAsset & { remoteReady: boolean; durability: 'r2' | 'sandbox' }> {
  const asset = completePublishingUpload(env, ctx, id);
  if (!configuredMediaStore()) return { ...asset, remoteReady: false, durability: 'sandbox' };
  const row = mediaAsset(env, ctx, asset.id) as MediaRow & { remote_ready?: number };
  const path = join(publishingDirectory(ctx.workspaceId), row.sha256);
  if (!existsSync(path) && row.remote_ready) await stageImmutableMedia(ctx.workspaceId, row.sha256, path, row.mime, row.size);
  await putImmutableMedia(ctx.workspaceId, row.sha256, path, row.mime);
  env.db.transaction(() => {
    env.db.prepare('UPDATE publishing_media SET remote_ready=1 WHERE workspace_id=? AND id=? AND sha256=?').run(ctx.workspaceId, row.id, row.sha256);
    audit(env.db, ctx, env.now(), 'publishing_media', row.id, 'cloud_copy_verified', { sha256: row.sha256 });
  });
  trimPublishingCache(env, ctx.workspaceId, row.sha256);
  return { ...asset, remoteReady: true, durability: 'r2' };
}
export async function readPublishingMediaDurable(env: DomainEnv, ctx: AuthContext, id: string, offset?: number, length?: number): Promise<ReturnType<typeof readPublishingMedia>> {
  const row=mediaAsset(env, ctx, id); const path=join(publishingDirectory(ctx.workspaceId),row.sha256);
  activeMediaReads.set(path,(activeMediaReads.get(path)??0)+1);
  try { await ensurePublishingMediaLocal(env, ctx, id); return readPublishingMedia(env, ctx, id, offset, length); }
  finally { const count=activeMediaReads.get(path)!-1;if(count)activeMediaReads.set(path,count);else activeMediaReads.delete(path);trimPublishingCache(env,ctx.workspaceId,row.sha256); }
}
interface Deletion { id: string; sha256: string; mime: string; size: number }
async function finishDeletion(env: DomainEnv, ctx: AuthContext, row: Deletion): Promise<void> {
  await deleteImmutableMedia(ctx.workspaceId, row.sha256, row.mime, row.size);
  reclaimPublishingMediaFile(env, ctx, row);
  env.db.prepare('DELETE FROM media_deletions WHERE workspace_id=? AND id=?').run(ctx.workspaceId, row.id);
}
export async function deletePublishingMediaDurable(env: DomainEnv, ctx: AuthContext, id: string): Promise<void> {
  requireRole(ctx, 'operator');
  const row = env.db.transaction(() => {
    const pending = env.db.prepare('SELECT id,sha256,mime,size FROM media_deletions WHERE workspace_id=? AND id=?').get<Deletion>(ctx.workspaceId, id);
    if (pending) return pending;
    const asset = mediaAsset(env, ctx, id);
    // Remove discoverable metadata first while atomically reserving the hash against reuploads.
    // The legacy function enforces references before deletion and reclaims local bytes after commit.
    deletePublishingMedia(env, ctx, id, true);
    env.db.prepare('INSERT INTO media_deletions(id,workspace_id,sha256,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(id, ctx.workspaceId, asset.sha256, asset.mime, asset.size, env.now());
    return { id, sha256: asset.sha256, mime: asset.mime, size: asset.size };
  });
  await finishDeletion(env, ctx, row);
}
export async function retryPublishingMediaDeletions(env: DomainEnv, ctx: AuthContext): Promise<{ cleaned: number; pending: number }> {
  requireRole(ctx, 'operator'); let cleaned = 0;
  const rows = env.db.prepare('SELECT id,sha256,mime,size FROM media_deletions WHERE workspace_id=? ORDER BY created_at LIMIT 100').all<Deletion>(ctx.workspaceId);
  for (const row of rows) { try { await finishDeletion(env, ctx, row); cleaned++; } catch { /* Keep tombstone for a later authenticated retry. */ } }
  const pending = env.db.prepare('SELECT COUNT(*) n FROM media_deletions WHERE workspace_id=?').get<{ n: number }>(ctx.workspaceId)!.n;
  return { cleaned, pending };
}
