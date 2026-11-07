/* global TextDecoder, Response */
import { decode64, hmac } from './crypto.mjs';
const answer = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const equal = (a, b) => { if (a.length !== b.length) return false; let n = 0; for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i); return n === 0; };
/** Private storage service. Engine owns ACL, quota reservations and reference-protected deletion. */
export async function serviceMediaRoute(request, env) {
  const url = new URL(request.url); const match = /^\/internal\/media\/([A-Za-z0-9_-]{1,200})\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match || url.search || !['GET', 'HEAD', 'PUT', 'DELETE'].includes(request.method)) return answer({ error: 'not_found' }, 404);
  const encoded = request.headers.get('x-carl-media') || ''; const signature = request.headers.get('x-carl-media-signature') || '';
  if (!env.MEDIA || !env.CLOUD_MEDIA_SECRET || encoded.length > 4096 || !/^[a-f0-9]{64}$/.test(signature) || !equal(await hmac(env.CLOUD_MEDIA_SECRET, encoded), signature)) return answer({ error: 'unauthorized' }, 401);
  let claim; try { claim = JSON.parse(new TextDecoder().decode(decode64(encoded))); } catch { return answer({ error: 'unauthorized' }, 401); }
  const now = Math.floor(Date.now() / 1000); const [, workspaceId, sha256] = match;
  const metadataOnly = request.method === 'HEAD' && claim.size === 0 && claim.mime === 'application/octet-stream';
  if (claim.method !== request.method || claim.path !== url.pathname || claim.workspaceId !== workspaceId || claim.sha256 !== sha256 || !Number.isSafeInteger(claim.iat) || !Number.isSafeInteger(claim.exp) || claim.iat > now + 5 || claim.iat < now - 60 || claim.exp < now || claim.exp > claim.iat + 60 || !Number.isSafeInteger(claim.size) || claim.size < 0 || claim.size > 100 * 1024 * 1024 || (!metadataOnly && (claim.size < 1 || !['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'text/html', 'application/json', 'application/octet-stream'].includes(claim.mime)))) return answer({ error: 'unauthorized' }, 401);
  const key = `workspaces/${workspaceId}/media/${sha256}`;
  if (request.method === 'DELETE') { await env.MEDIA.delete(key); return answer({ deleted: true }); }
  if (request.method === 'PUT') {
    if (Number(request.headers.get('content-length')) !== claim.size || request.headers.get('content-type') !== claim.mime || !request.body) return answer({ error: 'invalid_upload' }, 400);
    const existing = await env.MEDIA.head(key);
    if (existing) {
      if (existing.size !== claim.size || existing.customMetadata?.sha256 !== sha256 || existing.httpMetadata?.contentType !== claim.mime) return answer({ error: 'immutable_conflict' }, 409);
    } else {
      const checksum = Uint8Array.from(sha256.match(/../g), value => parseInt(value, 16));
      await env.MEDIA.put(key, request.body, { sha256: checksum.buffer, httpMetadata: { contentType: claim.mime }, customMetadata: { workspaceId, sha256 }, onlyIf: { etagDoesNotMatch: '*' } });
      const check = await env.MEDIA.head(key);
      if (!check || check.size !== claim.size || check.customMetadata?.sha256 !== sha256) return answer({ error: 'storage_verification_failed' }, 502);
    }
    return answer({ stored: true, workspaceId, sha256, size: claim.size });
  }
  const object = request.method === 'HEAD' ? await env.MEDIA.head(key) : await env.MEDIA.get(key);
  if (!object) return answer({ error: 'not_found' }, 404);
  if (object.size < 1 || object.size > 100 * 1024 * 1024 || (!metadataOnly && (object.size !== claim.size || object.httpMetadata?.contentType !== claim.mime)) || object.customMetadata?.sha256 !== sha256 || object.customMetadata?.workspaceId !== workspaceId) return answer({ error: 'storage_verification_failed' }, 409);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers: { 'content-type': object.httpMetadata.contentType, 'content-length': String(object.size), 'x-carl-sha256': sha256, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
export async function mediaRoute() {
  // Browser uploads use authenticated engine reservations/chunks; raw service paths are never browser-authorized.
  return answer({ error: 'Use the authenticated publishing upload endpoints' }, 404);
}
