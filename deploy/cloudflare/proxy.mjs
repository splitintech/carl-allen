/* global Headers, Response */
import { base64url, bytes, random, sha256, hmac } from './crypto.mjs';
export async function privateConnection(env, fetchImpl = fetch) {
  if (env.DAYTONA_API_KEY && env.DAYTONA_SANDBOX_ID) {
    const base = new URL(env.DAYTONA_API_BASE || 'https://app.daytona.io/api/');
    if (base.protocol !== 'https:' || base.hostname !== 'app.daytona.io') throw new Error('Invalid Daytona API origin');
    const url = new URL(`sandbox/${encodeURIComponent(env.DAYTONA_SANDBOX_ID)}/ports/${encodeURIComponent(env.DAYTONA_ENGINE_PORT || '8787')}/preview-url`, base);
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${env.DAYTONA_API_KEY}` }, signal: AbortSignal.timeout(10000), redirect: 'manual' });
    if (!response.ok) throw new Error('Private runtime connection unavailable');
    const value = await response.json();
    return validateConnection(value.url, value.token);
  }
  // Explicit fixed connection supports private deployments with an independently rotated preview token.
  return validateConnection(env.DAYTONA_API_URL, env.DAYTONA_PREVIEW_TOKEN);
}
function validateConnection(apiUrl, previewToken) {
  if (!apiUrl || !previewToken) throw new Error('Private runtime connection is not configured');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Invalid private runtime URL');
  return { apiUrl: url.href.replace(/\/$/, ''), previewToken };
}
export async function delegateRequest(env, identity, method, path, body = new Uint8Array(), fetchImpl = fetch, connection) {
  if (!/^\/(?:v1\/|mcp$)/.test(path) || path.includes('..') || path.includes('\\') || /%2f|%5c|%2e/i.test(path)) throw new Error('Invalid engine route');
  const runtime = connection || await privateConnection(env, fetchImpl);
  const now = Math.floor(Date.now() / 1000);
  const delegation = { identityProvider: identity.identityProvider || 'google', sub: identity.sub, workspaceId: identity.workspaceId, surface: identity.surface, scopes: identity.scopes, ...(identity.email ? { email: identity.email, emailVerified: identity.emailVerified === true } : {}), iat: now, exp: now + 45, jti: random(), method, path, bodySha256: await sha256(body) };
  const encoded = base64url(bytes(JSON.stringify(delegation)));
  const headers = new Headers({ 'content-type': 'application/json', 'x-daytona-preview-token': runtime.previewToken, 'x-carl-delegation': encoded, 'x-carl-signature': await hmac(env.CLOUD_GATEWAY_SECRET, encoded), accept: 'application/json, text/event-stream' });
  const response = await fetchImpl(runtime.apiUrl + path, { method, headers, ...(body.length ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  // Upstream credential-bearing headers and redirects never reach the client.
  const safe = new Headers({ 'content-type': response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  if (response.headers.get('x-trace-id')) safe.set('x-trace-id', response.headers.get('x-trace-id'));
  return new Response(response.body, { status: response.status, headers: safe });
}
/** Admin-only short-lived browser view; never expose the sandbox-wide preview token. */
export async function browserLogin(env, fetchImpl = fetch) {
  if (!env.DAYTONA_API_KEY || !env.DAYTONA_SANDBOX_ID) throw new Error('Cloud browser login requires a Daytona API key');
  const base=new URL(env.DAYTONA_API_BASE || 'https://app.daytona.io/api/');
  if(base.protocol!=='https:'||base.hostname!=='app.daytona.io')throw new Error('Invalid Daytona origin');
  const endpoint=new URL(`sandbox/${encodeURIComponent(env.DAYTONA_SANDBOX_ID)}/ports/6080/signed-preview-url?expiresInSeconds=900`,base);
  const response=await fetchImpl(endpoint,{headers:{authorization:`Bearer ${env.DAYTONA_API_KEY}`},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Private browser view unavailable');
  const value=await response.json();const url=new URL(value.url);
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('Invalid browser view');
  url.pathname=url.pathname.replace(/\/$/,'')+'/vnc.html';url.searchParams.set('autoconnect','true');url.searchParams.set('resize','scale');
  return {url:url.href,expiresAt:Date.now()+900000};
}
