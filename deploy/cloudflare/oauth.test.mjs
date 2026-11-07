/* global Request, Response, Headers */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeMcp } from './oauth.mjs';
import { seal } from './crypto.mjs';
const env = { PUBLIC_ORIGIN: 'https://carl.test', GOOGLE_CLIENT_ID: 'fixture-google-client', WORKSPACE_ID: 'ws', SESSION_SECRET: 'fixture-session-secret-with-at-least-32-characters', CLOUD_GATEWAY_SECRET: 'fixture-gateway-secret-with-at-least-32-characters', DAYTONA_API_URL: 'https://8787-runtime.proxy.daytona.work', DAYTONA_PREVIEW_TOKEN: 'fixture-preview-secret' };
const cookie = async () => '__Host-carl-session=' + await seal({ identityProvider: 'google', sub: '1234', email: 'member@example.invalid', emailVerified: true, workspaceId: 'ws', csrf: 'fixture', exp: Date.now() + 60000 }, env.SESSION_SECRET);
test('MCP consent requires Google sign-in and actual membership before showing client identity and scopes', async () => {
  const anonymous = await authorizeMcp(new Request('https://carl.test/oauth/authorize?client_id=fixture'), env); assert.equal(anonymous.status, 302); assert.match(anonymous.headers.get('location'), /^\/auth\/login/);
  const noMember = await authorizeMcp(new Request('https://carl.test/oauth/authorize', { headers: { cookie: await cookie() } }), env, async () => Response.json({}, { status: 403 })); assert.equal(noMember.status, 403);
  const OAUTH_PROVIDER = { parseAuthRequest: async () => ({}), describeConsent: async () => ({ clientName: '<script>attacker</script>', clientDomain: 'client.test', redirectHost: 'localhost', redirectIsLoopback: true, scope: ['carl:read','carl:prepare'] }), beginConsent: async () => ({ handle: 'fixture-handle', headers: new Headers({ 'x-frame-options': 'DENY' }) }) };
  const response = await authorizeMcp(new Request('https://carl.test/oauth/authorize', { headers: { cookie: await cookie() } }), { ...env, OAUTH_PROVIDER }, async () => Response.json({ roles: ['viewer'] }));
  const html = await response.text(); assert.equal(response.status, 200); assert.match(html, /&#60;script&#62;/); assert.doesNotMatch(html, /<script>/); assert.doesNotMatch(html, /value="carl:prepare"/); assert.match(html, /localhost/); assert.equal(response.headers.get('x-frame-options'), 'DENY');
});
test('MCP consent narrows roles, stores verified Google identity, and never introduces an approval scope', async () => {
  const calls = []; const original = { scope: ['carl:read'] };
  const OAUTH_PROVIDER = { approveConsent: async (_request, _handle, options) => { calls.push(options); return { request: { ...original, scope: options.scope }, headers: new Headers() }; }, completeAuthorization: async value => { calls.push(value); return { redirectTo: 'https://client.test/callback?code=fixture' }; } };
  const request = new Request('https://carl.test/oauth/authorize', { method: 'POST', headers: { cookie: await cookie(), origin: env.PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: 'handle=fixture&decision=approve&scope=carl%3Aread&scope=carl%3Aprepare&scope=approve' });
  const response = await authorizeMcp(request, { ...env, OAUTH_PROVIDER }, async () => Response.json({ roles: ['viewer'] }));
  assert.equal(response.status, 302); assert.deepEqual(calls[0].scope, ['carl:read']); assert.equal(calls[1].props.identityProvider, 'google'); assert.equal(calls[1].props.sub, '1234'); assert.equal(calls[1].userId, 'google-1234'); assert.equal(calls[1].props.emailVerified, true);
  const crossOrigin = new Request('https://carl.test/oauth/authorize', { method: 'POST', headers: { cookie: await cookie(), origin: 'https://evil.test' }, body: '' }); assert.equal((await authorizeMcp(crossOrigin, env, async () => Response.json({ roles: ['operator'] }))).status, 403);
});
