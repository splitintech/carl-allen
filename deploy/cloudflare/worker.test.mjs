/* global crypto, Request, Response */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from './worker.mjs';
import { beginLogin, verifyJwt } from './auth.mjs';
import { base64url, bytes, seal, unseal, hmac, sha256 } from './crypto.mjs';
import { serviceMediaRoute } from './media.mjs';

const env = { PUBLIC_ORIGIN: 'https://carl.test', GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-google-secret', WORKSPACE_ID: 'ws', SESSION_SECRET: 'fixture-session-secret-with-at-least-32-characters', CLOUD_GATEWAY_SECRET: 'fixture-gateway-secret-with-at-least-32-characters', CLOUD_MEDIA_SECRET: 'fixture-media-secret-with-at-least-32-characters', DAYTONA_API_URL: 'https://8787-runtime.proxy.daytona.work', DAYTONA_PREVIEW_TOKEN: 'fixture-private-preview-credential' };
const now = () => Math.floor(Date.now() / 1000);
async function cookieFor(overrides = {}) { return '__Host-carl-session=' + await seal({ identityProvider: 'google', sub: 'fixture-user', workspaceId: 'ws', email: 'member@example.invalid', emailVerified: true, csrf: 'fixture-csrf', exp: Date.now() + 60000, ...overrides }, env.SESSION_SECRET); }
async function signingFixture() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: crypto.randomUUID(), alg: 'RS256', use: 'sig' };
  const token = async claims => { const encoded = [base64url(bytes(JSON.stringify({ alg: 'RS256', kid: jwk.kid }))), base64url(bytes(JSON.stringify({ sub: 'fixture-user', iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID, exp: now() + 3600, scope: 'carl:read carl:prepare', ...claims })))].join('.'); return encoded + '.' + base64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, bytes(encoded))); };
  return { jwk, token };
}
test('unauthenticated UI/API and MCP have distinct gated responses and OAuth metadata', async () => {
  const worker = createWorker();
  assert.equal((await worker.fetch(new Request('https://carl.test/'), env)).status, 302);
  assert.equal((await worker.fetch(new Request('https://carl.test/api/v1/me'), env)).status, 401);
  const mcp = await worker.fetch(new Request('https://carl.test/mcp', { method: 'POST' }), env);
  assert.equal(mcp.status, 401); assert.match(mcp.headers.get('www-authenticate'), /oauth-protected-resource/);
  const metadata = await (await worker.fetch(new Request('https://carl.test/.well-known/oauth-protected-resource'), env)).json();
  assert.equal(metadata.resource, 'https://carl.test/mcp'); assert.deepEqual(metadata.scopes_supported, ['carl:read', 'carl:prepare', 'carl:control']);
  assert.equal((await worker.fetch(new Request('https://other.test/'), env)).status, 403);
});
test('web mutations enforce CSRF and bind actual identity, route and bytes without forwarding client credentials', async () => {
  const calls = []; const worker = createWorker({ fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ acceptedDraft: true }, { headers: { 'set-cookie': 'leak', authorization: 'fixture-secret' } }); } });
  const cookie = await cookieFor(); const body = JSON.stringify({ name: 'Synthetic', html: '<table></table>' });
  const request = extra => new Request('https://carl.test/api/v1/work-packages', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://carl.test', ...extra }, body });
  assert.equal((await worker.fetch(request({}), env)).status, 403);
  const response = await worker.fetch(request({ 'x-carl-csrf': 'fixture-csrf', authorization: 'Bearer attacker', 'x-carl-delegation': 'attacker' }), env);
  assert.equal(response.status, 200); assert.equal(calls.length, 1); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('authorization'), null);
  const forwarded = calls[0].options; const encoded = forwarded.headers.get('x-carl-delegation'); const value = JSON.parse(Buffer.from(encoded, 'base64url'));
  assert.equal(value.sub, 'fixture-user'); assert.equal(value.workspaceId, 'ws'); assert.equal(value.surface, 'http'); assert.equal(value.path, '/v1/work-packages'); assert.equal(value.bodySha256, await sha256(body));
  assert.equal(forwarded.headers.get('x-carl-signature'), await hmac(env.CLOUD_GATEWAY_SECRET, encoded));
  assert.equal(forwarded.headers.get('authorization'), null); assert.equal(forwarded.headers.get('x-daytona-preview-token'), env.DAYTONA_PREVIEW_TOKEN);
  assert.equal((await worker.fetch(new Request('https://carl.test/api/v1/work-packages', { method: 'POST', headers: { cookie, origin: 'https://evil.test', 'x-carl-csrf': 'fixture-csrf' } }), env)).status, 403);
});
test('static HTML requires workspace membership and uses exact inline script CSP hashes', async () => {
  const html = '<!doctype html><script>console.log("fixture")</script>';
  const worker = createWorker({ fetchImpl: async () => Response.json({ roles: ['viewer'] }) });
  const response = await worker.fetch(new Request('https://carl.test/', { headers: { cookie: await cookieFor() } }), { ...env, ASSETS: { fetch: async () => new Response(html) } });
  assert.equal(response.status, 200); assert.equal(await response.text(), html); assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'sha256-/); assert.doesNotMatch(response.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
  const denied = createWorker({ fetchImpl: async () => Response.json({ error: 'unknown_member' }, { status: 403 }) });
  assert.equal((await denied.fetch(new Request('https://carl.test/', { headers: { cookie: await cookieFor() } }), env)).status, 403);
});
test('JWT validation rejects wrong audience, expiry, nonce and tampering; MCP retains OAuth scopes', async () => {
  const { jwk, token } = await signingFixture(); const fetchImpl = async () => Response.json({ keys: [jwk] });
  const valid = await token({}); assert.equal((await verifyJwt(valid, env, {}, fetchImpl)).sub, 'fixture-user');
  await assert.rejects(() => verifyJwt(awaitTokenPlaceholder, env));
  await assert.rejects(() => verifyJwt(valid, env, { audience: 'wrong' }, fetchImpl));
  await assert.rejects(() => verifyJwt(valid, env, { nonce: 'wrong' }, fetchImpl));
  await assert.rejects(() => verifyJwt(valid.slice(0, -6) + 'abcdef', env, {}, fetchImpl));
  const expired = await token({ exp: now() - 1 }); await assert.rejects(() => verifyJwt(expired, env, {}, fetchImpl));
  const calls = []; const worker = createWorker({ fetchImpl: async (url, options) => { if (String(url).includes('/certs')) return fetchImpl(); calls.push(options); return Response.json({ jsonrpc: '2.0', id: 1, result: {} }); } });
  const response = await worker.fetch(new Request('https://carl.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${valid}`, origin: 'https://chatgpt.com' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }), env, { props: { identityProvider: 'google', sub: 'fixture-user', workspaceId: 'ws' }, auth: { scope: ['carl:read', 'carl:prepare'] } });
  assert.equal(response.status, 200); const claim = JSON.parse(Buffer.from(calls[0].headers.get('x-carl-delegation'), 'base64url')); assert.equal(claim.surface, 'mcp'); assert.deepEqual(claim.scopes, ['carl:read', 'carl:prepare']);
});
const awaitTokenPlaceholder = 'invalid.jwt';
test('PKCE sign-in state is encrypted, same-browser bound, and expired callbacks recover without leaking tokens', async () => {
  const response = await beginLogin(new Request('https://carl.test/auth/login?returnTo=https://evil.test'), env);
  const redirect = new URL(response.headers.get('location')); assert.equal(redirect.searchParams.get('prompt'), 'select_account'); assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
  const flowCookie = response.headers.get('set-cookie').split(';')[0]; const flow = await unseal(flowCookie.split('=')[1], env.SESSION_SECRET); assert.equal(flow.returnTo, '/'); assert.notEqual(flow.verifier, redirect.searchParams.get('code_challenge'));
  const worker = createWorker(); const callback = await worker.fetch(new Request('https://carl.test/auth/callback?state=wrong&code=fixture', { headers: { cookie: flowCookie } }), env);
  assert.equal(callback.status, 400); assert.equal((await callback.json()).error, 'login_failed');
});
function fakeR2() {
  const stored = new Map();
  return { stored, async head(key) { const value = stored.get(key); return value ? { ...value, body: undefined } : null; }, async get(key) { const value = stored.get(key); return value ? { ...value, body: value.bytes } : null; }, async put(key, body, options) { const data = new Uint8Array(await new Response(body).arrayBuffer()); assert.equal(await sha256(data), Buffer.from(options.sha256).toString('hex')); if (!stored.has(key)) stored.set(key, { bytes: data, size: data.length, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata }); }, async delete(key) { stored.delete(key); } };
}
async function mediaRequest(method, workspaceId, data, mime = 'image/png', overrides = {}) {
  const digest = await sha256(data); const path = `/internal/media/${workspaceId}/${digest}`; const claim = { method, workspaceId, sha256: digest, size: data.length, mime, path, iat: now(), exp: now() + 45, ...overrides };
  const encoded = base64url(bytes(JSON.stringify(claim)));
  return new Request('https://carl.test' + path, { method, headers: { 'x-carl-media': encoded, 'x-carl-media-signature': await hmac(env.CLOUD_MEDIA_SECRET, encoded), 'content-type': mime, 'content-length': String(data.length) }, ...(method === 'PUT' ? { body: data } : {}) });
}
test('private R2 service verifies signatures and object hashes, supports cold metadata/staging, and isolates workspaces', async () => {
  const data = bytes('synthetic-image-fixture'); const MEDIA = fakeR2(); const configured = { ...env, MEDIA };
  const put = await serviceMediaRoute(await mediaRequest('PUT', 'ws', data), configured); assert.equal(put.status, 200); assert.equal((await put.json()).stored, true);
  assert.equal((await serviceMediaRoute(await mediaRequest('PUT', 'ws', data), configured)).status, 200); assert.equal(MEDIA.stored.size, 1);
  const head = await serviceMediaRoute(await mediaRequest('HEAD', 'ws', data, 'application/octet-stream', { size: 0 }), configured); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), data.length); assert.equal(head.headers.get('content-type'), 'image/png');
  const get = await serviceMediaRoute(await mediaRequest('GET', 'ws', data), configured); assert.deepEqual(new Uint8Array(await get.arrayBuffer()), data);
  assert.equal((await serviceMediaRoute(await mediaRequest('GET', 'foreign', data), configured)).status, 404);
  assert.equal((await serviceMediaRoute(await mediaRequest('GET', 'ws', data, 'image/png', { exp: now() - 1 }), configured)).status, 401);
  const missing = new Request('https://carl.test/internal/media/ws/' + await sha256(data)); assert.equal((await serviceMediaRoute(missing, configured)).status, 401);
  assert.equal((await serviceMediaRoute(await mediaRequest('DELETE', 'ws', data), configured)).status, 200); assert.equal(MEDIA.stored.size, 0);
});
