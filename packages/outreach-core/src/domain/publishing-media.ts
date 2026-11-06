import { closeSync, existsSync, ftruncateSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from '@splitin/outreach-contracts';
import { ConflictError, NotFoundError, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { PUBLISHING_LIMITS, assetView, type MediaRow, type PublishingAsset } from './publishing-types';
import { digestMedia, publishingDirectory, signatureMatches, verifyMediaFile } from './publishing-files';
interface UploadRow { id: string; workspace_id: string; name: string; mime: string; size: number; completed_asset_id: string | null; received: number; next_index: number; created_at: number }
const mimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'];
export function mediaAsset(env: DomainEnv, ctx: AuthContext, id: string): MediaRow {
  const row = env.db.prepare('SELECT * FROM publishing_media WHERE workspace_id=? AND id=?').get<MediaRow>(ctx.workspaceId, id);
  if (!row) throw new NotFoundError('media asset');
  return row;
}
export function listPublishingMedia(env: DomainEnv, ctx: AuthContext): PublishingAsset[] {
  requireRole(ctx, 'viewer');
  return env.db.prepare('SELECT * FROM publishing_media WHERE workspace_id=? ORDER BY created_at DESC,id').all<MediaRow>(ctx.workspaceId).map(assetView);
}
function upload(env: DomainEnv, ctx: AuthContext, id: string): UploadRow {
  const row = env.db.prepare('SELECT * FROM publishing_uploads WHERE workspace_id=? AND id=?').get<UploadRow>(ctx.workspaceId, id);
  if (!row) throw new NotFoundError('upload');
  if (row.completed_asset_id) throw new ConflictError('Upload is already complete');
  if (env.now() - row.created_at > 24 * 60 * 60 * 1000) throw new ConflictError('Upload expired; cancel it and start again');
  return row;
}
export function startPublishingUpload(env: DomainEnv, ctx: AuthContext, input: { name: string; mime: string; size: number }): { uploadId: string; chunkBytes: number } {
  requireRole(ctx, 'operator');
  const max = input.mime.startsWith('video/') ? PUBLISHING_LIMITS.videoBytes : PUBLISHING_LIMITS.imageBytes;
  if (!input.name.trim() || input.name.length > 240 || Array.from(input.name).some((c) => c.charCodeAt(0) < 32 || c === '/' || c === '\\') || !mimeTypes.includes(input.mime) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > max) throw new ConflictError('Unsupported media name, type or size (images up to5MB; videos up to100MB)');
  expireUploads(env, ctx);
  return env.db.transaction(() => {
    if (env.db.prepare('SELECT COUNT(*) n FROM publishing_media WHERE workspace_id=?').get<{ n: number }>(ctx.workspaceId)!.n >= 1000) throw new ConflictError('Media library item limit reached');
    const used = env.db.prepare('SELECT COALESCE(SUM(size),0) n FROM publishing_media WHERE workspace_id=?').get<{ n: number }>(ctx.workspaceId)!.n;
    const pending = env.db.prepare('SELECT COALESCE(SUM(size),0) n,COUNT(*) count FROM publishing_uploads WHERE workspace_id=? AND completed_asset_id IS NULL').get<{ n: number; count: number }>(ctx.workspaceId)!;
    if (pending.count >= 10 || used + pending.n + input.size > PUBLISHING_LIMITS.workspaceBytes) throw new ConflictError('Workspace media storage limit reached; remove unused files or cancel unfinished uploads');
    const id = ulid(env.now()); const file = join(publishingDirectory(ctx.workspaceId, true), id);
    closeSync(openSync(file, 'wx', 0o600));
    try { env.db.prepare('INSERT INTO publishing_uploads(id,workspace_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(id, ctx.workspaceId, input.name.trim(), input.mime, input.size, env.now()); }
    catch (error) { unlinkSync(file); throw error; }
    return { uploadId: id, chunkBytes: PUBLISHING_LIMITS.chunkBytes };
  });
}
export function appendPublishingChunk(env: DomainEnv, ctx: AuthContext, id: string, index: number, data: string): { receivedBytes: number } {
  requireRole(ctx, 'operator');
  if (!Number.isSafeInteger(index) || index < 0 || typeof data !== 'string' || data.length > Math.ceil(PUBLISHING_LIMITS.chunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new ConflictError('Invalid upload chunk');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > PUBLISHING_LIMITS.chunkBytes) throw new ConflictError('Upload chunk is empty or too large');
  return env.db.transaction(() => {
    const row = upload(env, ctx, id); const file = join(publishingDirectory(ctx.workspaceId, true), id); verifyMediaFile(file);
    if (index === row.next_index - 1) {
      const current = Buffer.alloc(bytes.length); const readFd = openSync(file, 'r');
      try { readSync(readFd, current, 0, current.length, index * PUBLISHING_LIMITS.chunkBytes); } finally { closeSync(readFd); }
      if (current.equals(bytes) && row.received === index * PUBLISHING_LIMITS.chunkBytes + bytes.length) return { receivedBytes: row.received };
      throw new ConflictError('A different upload chunk already occupies this index');
    }
    if (index !== row.next_index || row.received !== index * PUBLISHING_LIMITS.chunkBytes || row.received + bytes.length > row.size || (row.received + bytes.length < row.size && bytes.length !== PUBLISHING_LIMITS.chunkBytes)) throw new ConflictError('Upload chunks must be complete, ordered and within declared size');
    const fd = openSync(file, 'r+');
    try { ftruncateSync(fd, row.received); writeSync(fd, bytes, 0, bytes.length, row.received); fsyncSync(fd); env.db.prepare('UPDATE publishing_uploads SET received=received+?,next_index=next_index+1 WHERE id=?').run(bytes.length, id); }
    catch (error) { ftruncateSync(fd, row.received); throw error; } finally { closeSync(fd); }
    return { receivedBytes: row.received + bytes.length };
  });
}
export function completePublishingUpload(env: DomainEnv, ctx: AuthContext, id: string): PublishingAsset {
  requireRole(ctx, 'operator');
  return env.db.transaction(() => {
    const completed = env.db.prepare('SELECT completed_asset_id FROM publishing_uploads WHERE workspace_id=? AND id=?').get<{ completed_asset_id: string | null }>(ctx.workspaceId, id);
    if (completed?.completed_asset_id) return assetView(mediaAsset(env, ctx, completed.completed_asset_id));
    const row = upload(env, ctx, id);
    if (row.received !== row.size) throw new ConflictError('Upload is incomplete');
    const file = join(publishingDirectory(ctx.workspaceId, true), id); verifyMediaFile(file, row.size);
    const { sha256, header } = digestMedia(file);
    if (!signatureMatches(row.mime, header)) throw new ConflictError('Media content does not match its declared file type');
    const old = env.db.prepare('SELECT * FROM publishing_media WHERE workspace_id=? AND sha256=?').get<MediaRow>(ctx.workspaceId, sha256);
    if (old && (old.size !== row.size || old.mime !== row.mime)) throw new ConflictError('Stored media metadata conflicts with uploaded content');
    const target = join(publishingDirectory(ctx.workspaceId), sha256);
    if (existsSync(target)) { verifyMediaFile(target, row.size); if (digestMedia(target).sha256 !== sha256) throw new ConflictError('Stored media hash failed verification'); }
    else linkSync(file, target);
    const asset = old ?? { id: ulid(env.now()), workspace_id: ctx.workspaceId, name: row.name, mime: row.mime, size: row.size, sha256, created_at: env.now() };
    if (!old) env.db.prepare('INSERT INTO publishing_media(id,workspace_id,name,mime,size,sha256,created_at) VALUES (?,?,?,?,?,?,?)').run(asset.id, asset.workspace_id, asset.name, asset.mime, asset.size, asset.sha256, asset.created_at);
    env.db.prepare('UPDATE publishing_uploads SET completed_asset_id=? WHERE id=?').run(asset.id, id); unlinkSync(file);
    audit(env.db, ctx, env.now(), 'publishing_media', asset.id, 'uploaded', { sha256, size: asset.size, mime: asset.mime });
    return assetView(asset);
  });
}
export function readPublishingMedia(env: DomainEnv, ctx: AuthContext, id: string, offset = 0, length: number = PUBLISHING_LIMITS.chunkBytes): { data: string; offset: number; total: number; mime: string; name: string } {
  requireRole(ctx, 'viewer'); const row = mediaAsset(env, ctx, id);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= row.size || !Number.isSafeInteger(length) || length < 1 || length > PUBLISHING_LIMITS.chunkBytes) throw new ConflictError('Invalid media read range');
  const file = join(publishingDirectory(ctx.workspaceId), row.sha256); verifyMediaFile(file, row.size);
  const bytes = Buffer.alloc(Math.min(length, row.size - offset)); const fd = openSync(file, 'r');
  try { const read = readSync(fd, bytes, 0, bytes.length, offset); if (read !== bytes.length) throw new ConflictError('Media read was incomplete'); } finally { closeSync(fd); }
  return { data: bytes.toString('base64'), offset, total: row.size, mime: row.mime, name: row.name };
}
export function cancelPublishingUpload(env: DomainEnv, ctx: AuthContext, id: string): void {
  requireRole(ctx, 'operator');
  const row = env.db.prepare('SELECT id FROM publishing_uploads WHERE workspace_id=? AND id=?').get(ctx.workspaceId, id);
  if (!row) throw new NotFoundError('upload');
  const file = join(publishingDirectory(ctx.workspaceId, true), id); if (existsSync(file)) { verifyMediaFile(file); unlinkSync(file); }
  env.db.prepare('DELETE FROM publishing_uploads WHERE workspace_id=? AND id=?').run(ctx.workspaceId, id);
}
export function deletePublishingMedia(env: DomainEnv, ctx: AuthContext, id: string): void {
  requireRole(ctx, 'operator');
  const row = env.db.transaction(() => {
    const asset = mediaAsset(env, ctx, id);
    const drafts = env.db.prepare('SELECT posts FROM publishing_drafts WHERE workspace_id=?').all<{ posts: string }>(ctx.workspaceId);
    if (drafts.some((draft) => (JSON.parse(draft.posts) as { mediaIds: string[] }[]).some((p) => p.mediaIds.includes(id)))) throw new ConflictError('Media is referenced by a publishing draft');
    const actions = env.db.prepare('SELECT payload FROM scheduled_actions WHERE workspace_id=?').all<{ payload: string }>(ctx.workspaceId);
    if (actions.some((action) => (JSON.parse(action.payload) as { mediaUrls?: string[] }).mediaUrls?.includes(`outreach-media://${asset.sha256}`))) throw new ConflictError('Media is referenced by a scheduled action');
    const file = join(publishingDirectory(ctx.workspaceId), asset.sha256); verifyMediaFile(file, asset.size);
    env.db.prepare('DELETE FROM publishing_media WHERE workspace_id=? AND id=?').run(ctx.workspaceId, id);
    audit(env.db, ctx, env.now(), 'publishing_media', id, 'deleted', {});
    return asset;
  });
  // Reclaim only after metadata deletion committed. A second write transaction
  // serializes this check with concurrent completion of an identical upload.
  env.db.transaction(() => {
    if (env.db.prepare('SELECT id FROM publishing_media WHERE workspace_id=? AND sha256=?').get(ctx.workspaceId, row.sha256)) return;
    const file = join(publishingDirectory(ctx.workspaceId), row.sha256);
    if (existsSync(file)) { verifyMediaFile(file, row.size); unlinkSync(file); }
  });
}

function expireUploads(env: DomainEnv, ctx: AuthContext): void {
  const rows = env.db.prepare('SELECT id FROM publishing_uploads WHERE workspace_id=? AND created_at<?').all<{ id: string }>(ctx.workspaceId, env.now() - 24 * 60 * 60 * 1000);
  for (const row of rows) cancelPublishingUpload(env, ctx, row.id);
}
