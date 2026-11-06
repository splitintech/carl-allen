import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import type { ProviderContext } from '@splitin/outreach-contracts';
export interface MediaAttachment { readonly name: string; readonly mimeType: string; readonly buffer: Buffer }
export function sniffMedia(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null;
}
/** Workspace-scoped immutable asset; no user path, symlink, or unbounded file read. */
export async function loadStoredMedia(ctx: ProviderContext, ref: string, root?: string): Promise<MediaAttachment> {
  const match = /^outreach-media:\/\/([a-f0-9]{64})$/.exec(ref);
  if (!match) throw new Error('Invalid immutable media reference');
  ctx.signal.throwIfAborted();
  const hash = match[1]!;
  const directory = resolve(root ?? process.env.OUTREACH_MEDIA_DIR ?? resolve(process.env.OUTREACH_HOME ?? '.outreach', 'media'));
  const workspace = createHash('sha256').update(ctx.workspaceId).digest('hex').slice(0, 24);
  for (const path of [directory, join(directory, workspace)]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) throw new Error('Media storage must be private directories');
  }
  const file = await open(join(directory, workspace, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()) || info.size < 1 || info.size > 100 * 1024 * 1024) throw new Error('Media asset has invalid permissions or size');
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      ctx.signal.throwIfAborted(); const chunk = Buffer.alloc(1024 * 1024); const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead; if (total > 100 * 1024 * 1024) throw new Error('Media asset exceeded its allowed size');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const buffer = Buffer.concat(chunks);
    ctx.signal.throwIfAborted();
    if (createHash('sha256').update(buffer).digest('hex') !== hash) throw new Error('Media asset no longer matches its approved content hash');
    const mimeType = sniffMedia(buffer);
    if (!mimeType || (mimeType.startsWith('image/') && buffer.length > 5 * 1024 * 1024)) throw new Error('Unsupported media bytes or image size');
    return { name: `${hash}.${mimeType.split('/')[1]}`, mimeType, buffer };
  } finally { await file.close(); }
}
