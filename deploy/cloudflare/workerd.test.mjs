/* global Response, crypto, URLSearchParams */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { bytes, base64url, seal } from './crypto.mjs';
const configured = { PUBLIC_ORIGIN: 'https://carl.test', GOOGLE_CLIENT_ID: 'fixture-google-client', WORKSPACE_ID: 'ws', SESSION_SECRET: 'fixture-session-secret-with-at-least-32-characters', CLOUD_GATEWAY_SECRET: 'fixture-gateway-secret-with-at-least-32-characters', DAYTONA_API_URL: 'https://8787-runtime.proxy.daytona.work', DAYTONA_PREVIEW_TOKEN: 'fixture-preview-secret' };
test('actual workerd OAuth provider completes DCR + PKCE consent/token/refresh/resource access and rejects a forged token', { timeout: 90000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'carl-cloud-oauth-')); let runtime;
  try {
    const file = join(temporary, 'worker.mjs');
    await build({ entryPoints: [new URL('./index.mjs', import.meta.url).pathname], outfile: file, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:*'], logLevel: 'silent' });
    const outboundService = async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, configured.DAYTONA_API_URL);
      if (url.pathname === '/v1/me') return Response.json({ principalId: 'fixture-member', roles: ['operator'] });
      if (url.pathname === '/mcp') return Response.json({ jsonrpc: '2.0', id: 1, result: { fixture: true } });
      throw new Error('Unexpected network access: ' + url.pathname);
    };
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: await readFile(file, 'utf8'), compatibilityDate: '2026-11-07', compatibilityFlags: ['global_fetch_strictly_public'], bindings: configured, kvNamespaces: ['OAUTH_KV'], r2Buckets: ['MEDIA'], outboundService }));
    const fetchWorker = (path, options) => runtime.dispatchFetch('https://carl.test' + path, { redirect: 'manual', ...options });
    const metadata = await (await fetchWorker('/.well-known/oauth-authorization-server')).json();
    assert.equal(metadata.authorization_endpoint, 'https://carl.test/oauth/authorize'); assert.equal(metadata.token_endpoint, 'https://carl.test/oauth/token');
    const registered = await fetchWorker('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Fixture ChatGPT connector', redirect_uris: ['https://client.test/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] }) });
    assert.equal(registered.status, 201); const client = await registered.json(); assert.ok(client.client_id);
    const verifier = 'fixture-pkce-verifier-012345678901234567890123456789'; const challenge = base64url(await crypto.subtle.digest('SHA-256', bytes(verifier)));
    const authorization = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.test/callback', response_type: 'code', scope: 'carl:read carl:prepare offline_access', resource: 'https://carl.test/mcp', state: 'fixture-client-state', code_challenge: challenge, code_challenge_method: 'S256' });
    const session = '__Host-carl-session=' + await seal({ identityProvider: 'google', sub: '1234', email: 'member@example.invalid', emailVerified: true, workspaceId: 'ws', csrf: 'fixture', exp: Date.now() + 60000 }, configured.SESSION_SECRET);
    const consent = await fetchWorker('/oauth/authorize?' + authorization, { headers: { cookie: session } });
    assert.equal(consent.status, 200, await consent.clone().text()); const consentHtml = await consent.text(); const handle = /name="handle" value="([^"]+)"/.exec(consentHtml)?.[1]; assert.ok(handle);
    const bindingCookies = consent.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const approve = await fetchWorker('/oauth/authorize', { method: 'POST', headers: { cookie: session + '; ' + bindingCookies, origin: configured.PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams([['handle', handle], ['decision','approve'], ['scope','carl:read'], ['scope','carl:prepare'], ['scope','offline_access']]) });
    assert.equal(approve.status, 302); const redirect = new URL(approve.headers.get('location')); assert.equal(redirect.searchParams.get('state'), 'fixture-client-state'); const code = redirect.searchParams.get('code'); assert.ok(code);
    const tokenResponse = await fetchWorker('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://client.test/callback', code_verifier: verifier, resource: 'https://carl.test/mcp' }) });
    assert.equal(tokenResponse.status, 200); const tokens = await tokenResponse.json(); assert.ok(tokens.access_token); assert.ok(tokens.refresh_token);
    const accessed = await fetchWorker('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }); assert.equal(accessed.status, 200); assert.equal((await accessed.json()).result.fixture, true);
    const forged = await fetchWorker('/mcp', { method: 'POST', headers: { authorization: 'Bearer forged-google-jwt-or-token', 'content-type': 'application/json' }, body: '{}' }); assert.equal(forged.status, 401);
    const refreshed = await fetchWorker('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: 'https://carl.test/mcp' }) }); assert.equal(refreshed.status, 200); assert.ok((await refreshed.json()).access_token);
    const replay = await fetchWorker('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://client.test/callback', code_verifier: verifier, resource: 'https://carl.test/mcp' }) }); assert.notEqual(replay.status, 200);
  } finally { if (runtime) await runtime.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
