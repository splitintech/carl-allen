/* global crypto, TextDecoder, Headers, Response, URLSearchParams */
import { base64url, decode64, bytes, random, seal, unseal } from './crypto.mjs';
const SESSION = '__Host-carl-session'; const FLOW = '__Host-carl-flow';
const jwtKeys = new Map();
export function authConfig(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  const issuer = new URL('https://accounts.google.com/');
  if (origin.protocol !== 'https:' || issuer.protocol !== 'https:' || issuer.search || issuer.hash || !env.GOOGLE_CLIENT_ID || !env.WORKSPACE_ID) throw new Error('Authentication is not configured');
  return { origin: origin.origin, issuer: issuer.href.replace(/\/?$/, '/'), audience: env.GOOGLE_CLIENT_ID, workspaceId: env.WORKSPACE_ID };
}
export const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
export function readCookie(request, name) {
  const values = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
export async function verifyJwt(token, env, options = {}, fetchImpl = fetch) {
  const cfg = authConfig(env); const parts = token.split('.'); if (parts.length !== 3 || token.length > 16000) throw new Error('Invalid identity');
  const json = p => JSON.parse(new TextDecoder().decode(decode64(p)));
  const header = json(parts[0]); const claims = json(parts[1]); const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || ![claims.aud].flat().includes(options.audience || cfg.audience) || !Number.isSafeInteger(claims.exp) || claims.exp <= now || (claims.nbf && claims.nbf > now + 5) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 200) throw new Error('Invalid identity');
  if (options.nonce && claims.nonce !== options.nonce) throw new Error('Invalid sign-in nonce');
  const cacheKey = cfg.issuer + header.kid;
  let cached = jwtKeys.get(cacheKey);
  if (!cached || cached.until < Date.now()) {
    const response = await fetchImpl(new URL('https://www.googleapis.com/oauth2/v3/certs'), { signal: AbortSignal.timeout(10000), redirect: 'manual' });
    if (!response.ok) throw new Error('Identity verification unavailable');
    const body = await response.json(); const match = body.keys?.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
    if (!match) throw new Error('Unknown signing key');
    cached = { key: await crypto.subtle.importKey('jwk', match, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']), until: Date.now() + 300000 };
    if (jwtKeys.size > 64) jwtKeys.clear(); jwtKeys.set(cacheKey, cached);
  }
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cached.key, decode64(parts[2]), bytes(parts[0] + '.' + parts[1]))) throw new Error('Invalid identity');
  return claims;
}
export async function beginLogin(request, env) {
  const cfg = authConfig(env); const input = new URL(request.url); const target = input.searchParams.get('returnTo') || '/';
  const returnTo = target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? target : '/';
  const state = random(); const nonce = random(); const verifier = random();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', bytes(verifier)));
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, response_type: 'code', redirect_uri: cfg.origin + '/auth/callback', scope: 'openid profile email', prompt: 'select_account', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return new Response(null, { status: 302, headers: { location: url.href, 'set-cookie': cookie(FLOW, await seal({ state, nonce, verifier, returnTo, exp: Date.now() + 600000 }, env.SESSION_SECRET), 600), 'cache-control': 'no-store' } });
}
export async function finishLogin(request, env, fetchImpl = fetch) {
  const cfg = authConfig(env); const url = new URL(request.url);
  const flow = await unseal(readCookie(request, FLOW), env.SESSION_SECRET);
  if (flow.exp < Date.now() || flow.state !== url.searchParams.get('state') || !url.searchParams.get('code') || url.searchParams.get('error')) throw new Error('Sign-in expired; start Google sign-in again');
  const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.GOOGLE_CLIENT_ID, code: url.searchParams.get('code'), redirect_uri: cfg.origin + '/auth/callback', code_verifier: flow.verifier });
  if (env.GOOGLE_CLIENT_SECRET) params.set('client_secret', env.GOOGLE_CLIENT_SECRET);
  const response = await fetchImpl(new URL('https://oauth2.googleapis.com/token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Google sign-in failed; try again');
  const tokens = await response.json(); const identity = await verifyJwt(tokens.id_token, env, { audience: env.GOOGLE_CLIENT_ID, nonce: flow.nonce }, fetchImpl);
  if (!identity.email || identity.email_verified !== true) throw new Error('Verified email required');
  const exp = Math.min(identity.exp * 1000, Date.now() + 8 * 3600000);
  const session = { identityProvider: 'google', sub: identity.sub, email: identity.email, emailVerified: true, csrf: random(), exp, workspaceId: cfg.workspaceId };
  const headers = new Headers({ location: flow.returnTo, 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie(SESSION, await seal(session, env.SESSION_SECRET), Math.max(1, Math.floor((exp - Date.now()) / 1000)))); headers.append('set-cookie', cookie(FLOW, '', 0));
  return new Response(null, { status: 302, headers });
}
export async function webIdentity(request, env) {
  const session = await unseal(readCookie(request, SESSION), env.SESSION_SECRET);
  if (!session.sub || session.exp <= Date.now() || session.workspaceId !== env.WORKSPACE_ID) throw new Error('Sign-in required');
  if (session.identityProvider !== 'google') throw new Error('Google sign-in required');
  return { ...session, surface: 'http', scopes: [] };
}
export function mcpIdentity(context, env) {
  const props = context?.props; const scopes = context?.auth?.scope;
  if (!props || props.identityProvider !== 'google' || typeof props.sub !== 'string' || props.workspaceId !== env.WORKSPACE_ID || !Array.isArray(scopes) || !scopes.includes('carl:read')) throw new Error('MCP authorization required');
  return { sub: props.sub, identityProvider: 'google', workspaceId: env.WORKSPACE_ID, surface: 'mcp', scopes: scopes.filter(s => typeof s === 'string'), email: props.email, emailVerified: props.emailVerified === true };
}
export function logout() {
  return new Response(null, { status: 302, headers: { location: '/auth/login', 'set-cookie': cookie(SESSION, '', 0), 'cache-control': 'no-store' } });
}
