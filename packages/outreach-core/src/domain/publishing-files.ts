import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConflictError } from './auth';
export const workspaceMediaKey = (workspaceId: string): string => createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
export function publishingDirectory(workspaceId: string, uploads = false): string {
  const root = resolve(process.env.OUTREACH_MEDIA_DIR ?? resolve(process.env.OUTREACH_HOME ?? '.outreach', 'media'));
  const parts = [root, join(root, workspaceMediaKey(workspaceId)), ...(uploads ? [join(root, workspaceMediaKey(workspaceId), '.uploads')] : [])];
  for (const dir of parts) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ConflictError('Media directories must be private, regular directories');
  }
  return parts[parts.length - 1]!;
}
export function verifyMediaFile(file: string, expectedSize?: number): void {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || (expectedSize !== undefined && info.size !== expectedSize)) throw new ConflictError('Media file integrity check failed');
}
export function digestMedia(file: string): { sha256: string; header: Buffer } {
  verifyMediaFile(file);
  const fd = openSync(file, 'r'); const hash = createHash('sha256'); const chunk = Buffer.alloc(128 * 1024); let header = Buffer.alloc(0);
  try { let n; while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) { if (!header.length) header = Buffer.from(chunk.subarray(0, Math.min(n, 32))); hash.update(chunk.subarray(0, n)); } } finally { closeSync(fd); }
  return { sha256: hash.digest('hex'), header };
}
export function signatureMatches(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/mp4') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]));
  return false;
}
