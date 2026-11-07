import { constants, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { publishingDirectory, digestMedia } from './publishing-files';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function configuredMediaStore(): boolean { return Boolean(process.env.OUTREACH_MEDIA_GATEWAY && process.env.CLOUD_MEDIA_SECRET); }
interface MediaRequest { workspaceId: string; sha256: string; mime: string; size: number }
function requestConfig(method: string, input: MediaRequest): { url: string; headers: Record<string, string> } {
  const gateway = process.env.OUTREACH_MEDIA_GATEWAY; const secret = process.env.CLOUD_MEDIA_SECRET;
  if (!gateway || !secret || secret.length < 32) throw new Error('Private media storage is not configured');
  const url = new URL(gateway);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Media gateway must be an HTTPS origin');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.workspaceId) || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.size) || (input.size < 1 && !(method === 'HEAD' && input.size === 0)) || input.size > 100 * 1024 * 1024) throw new Error('Invalid private media request');
  url.pathname = `/internal/media/${input.workspaceId}/${input.sha256}`;
  const now = Math.floor(Date.now() / 1000);
  const claim = Buffer.from(JSON.stringify({ ...input, method, path: url.pathname, iat: now, exp: now + 45, jti: randomBytes(18).toString('base64url') })).toString('base64url');
  return { url: url.href, headers: { 'x-carl-media': claim, 'x-carl-media-signature': createHmac('sha256', secret).update(claim).digest('hex') } };
}
async function hashFile(path: string): Promise<{ size: number; hash: string }> {
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024) throw new Error('Invalid media file');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { size: stat.size, hash: hash.digest('hex') };
}
export async function putImmutableMedia(workspaceId: string, sha256: string, filePath: string, mime: string): Promise<void> {
  if (!configuredMediaStore()) return;
  const file = await hashFile(filePath); if (file.hash !== sha256) throw new Error('Media checksum mismatch before cloud upload');
  const request = requestConfig('PUT', { workspaceId, sha256, mime, size: file.size });
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  const response = await fetch(request.url, { method: 'PUT', headers: { ...request.headers, 'content-type': mime, 'content-length': String(file.size) }, body, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(180000) } as RequestInit);
  if (!response.ok) throw new Error('Private media upload failed');
  const receipt = await response.json() as {stored?:boolean;sha256?:string;size?:number};
  if (!receipt.stored || receipt.sha256 !== sha256 || receipt.size !== file.size) throw new Error('Private media upload receipt mismatch');
}
export async function stageImmutableMedia(workspaceId: string, sha256: string, filePath: string, mime: string, size: number): Promise<void> {
  if (!configuredMediaStore()) throw new Error('Media is unavailable locally and private storage is not configured');
  const request = requestConfig('GET', { workspaceId, sha256, mime, size });
  const response = await fetch(request.url, { headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body || response.headers.get('content-type') !== mime || Number(response.headers.get('content-length')) !== size || response.headers.get('x-carl-sha256') !== sha256) throw new Error('Private media download metadata mismatch');
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(12).toString('hex')}.partial`;
  const hash = createHash('sha256'); let received = 0;
  async function* bounded(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) { received += chunk.length; if (received > size) throw new Error('Media download exceeds expected size'); hash.update(chunk); yield chunk; }
  }
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), bounded, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (received !== size || hash.digest('hex') !== sha256) throw new Error('Private media download checksum mismatch');
    renameSync(temporary, filePath);
  } finally { rmSync(temporary, { force: true }); }
}
export async function deleteImmutableMedia(workspaceId: string, sha256: string, mime: string, size: number): Promise<void> {
  if (!configuredMediaStore()) return;
  const request = requestConfig('DELETE', { workspaceId, sha256, mime, size });
  const response = await fetch(request.url, { method: 'DELETE', headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Private media deletion failed');
}
/** Small local originals (for work-package recovery) are read through the same owner-only filesystem boundary. */
export function localMediaBytes(path: string): Buffer { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid local asset'); return readFileSync(path); }

export async function stageMediaByHash(workspaceId: string, sha256: string, filePath: string): Promise<void> {
  if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Invalid media hash');
  const local=join(publishingDirectory(workspaceId),sha256);
  if(local!==filePath&&existsSync(local)){if(digestMedia(local).sha256!==sha256)throw new Error('Local media checksum mismatch');copyFileSync(local,filePath,constants.COPYFILE_EXCL);return;}

  const request = requestConfig('HEAD', { workspaceId, sha256, mime: 'application/octet-stream', size: 0 });
  const response = await fetch(request.url, { method: 'HEAD', headers: request.headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const size = Number(response.headers.get('content-length')); const mime = response.headers.get('content-type') || '';
  if (!response.ok || !Number.isSafeInteger(size) || size < 1 || size > 100 * 1024 * 1024 || response.headers.get('x-carl-sha256') !== sha256 || !['image/jpeg','image/png','image/webp','video/mp4','video/webm'].includes(mime)) throw new Error('Private media metadata is unavailable');
  await stageImmutableMedia(workspaceId, sha256, filePath, mime, size);
}

export async function putImmutableDocument(workspaceId: string, sha256: string, content: string | Buffer, mime: 'text/html' | 'application/json' | 'application/octet-stream' = 'text/html'): Promise<void> {
  if (!configuredMediaStore()) return;
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (body.length > 25 * 1024 * 1024 || createHash('sha256').update(body).digest('hex') !== sha256) throw new Error('Invalid document checksum or size');
  const request = requestConfig('PUT', { workspaceId, sha256, mime, size: body.length });
  const response = await fetch(request.url, { method: 'PUT', headers: { ...request.headers, 'content-type': mime, 'content-length': String(body.length) }, body, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Private document upload failed');
  const receipt = await response.json() as {stored?:boolean;sha256?:string;size?:number};
  if (!receipt.stored || receipt.sha256 !== sha256 || receipt.size !== body.length) throw new Error('Private document receipt mismatch');
}
