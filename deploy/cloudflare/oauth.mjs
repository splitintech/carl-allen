/* global Response, URLSearchParams, TextDecoder */
import { webIdentity } from './auth.mjs';
import { boundedBody, bytes } from './crypto.mjs';
import { delegateRequest } from './proxy.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function consentPage(details, handle, allowed) {
  const scopes = details.scope.filter(s => allowed.includes(s));
  if (!scopes.includes('carl:read')) scopes.unshift('carl:read');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Carl-Allen</title><body><main><h1>Connect ${escape(details.clientName)} to Carl-Allen?</h1><p>${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'This client registered its own name.'} Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? '<p>This connects an application on your computer. Continue only if you started that connection.</p>' : ''}<p>Final publishing and outreach approvals remain in Carl-Allen. Your workspace role still limits every action.</p><form method="post"><input type="hidden" name="handle" value="${escape(handle)}">${scopes.map(scope => `<label><input type="checkbox" name="scope" value="${escape(scope)}" checked> ${escape(scope)}</label><br>`).join('')}<button name="decision" value="approve">Allow connection</button> <button name="decision" value="deny">Deny</button></form></main></body></html>`;
}
/** Sign-in is Google-only. The established OAuth provider owns grants, PKCE, metadata and tokens. */
export async function authorizeMcp(request, env, fetchImpl = fetch) {
  const origin = new URL(env.PUBLIC_ORIGIN).origin; const url = new URL(request.url);
  if (url.origin !== origin) return new Response('Invalid host', { status: 403 });
  let identity;
  try { identity = await webIdentity(request, env); } catch { return new Response(null, { status: 302, headers: { location: '/auth/login?returnTo=' + encodeURIComponent(url.pathname + url.search), 'cache-control': 'no-store' } }); }
  const memberResponse = await delegateRequest(env, identity, 'GET', '/v1/me', undefined, fetchImpl);
  if (!memberResponse.ok) return new Response('A workspace invitation is required.', { status: 403 });
  const member = await memberResponse.json(); const canPrepare = (member.roles || []).some(r => ['operator', 'approver', 'admin'].includes(r));
  const allowed = canPrepare ? ['carl:read', 'carl:prepare', 'carl:control', 'offline_access'] : ['carl:read', 'offline_access'];
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const parsed = await oauth.parseAuthRequest(request); const details = await oauth.describeConsent(parsed); const consent = await oauth.beginConsent(parsed);
      consent.headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle, allowed), { headers: consent.headers });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
    if (request.headers.get('origin') !== origin) return new Response('Invalid origin', { status: 403 });
    const body = await boundedBody(request.clone(), 16384);
    const form = new URLSearchParams(new TextDecoder().decode(body)); const handle = form.get('handle') || '';
    if (form.get('decision') !== 'approve') { const denied = await oauth.denyConsent(request, handle); return new Response(null, { status: 302, headers: denied.headers }); }
    const scopes = form.getAll('scope').filter(s => allowed.includes(s));
    if (!scopes.includes('carl:read')) return new Response('Read access is required for this connection.', { status: 400 });
    const approved = await oauth.approveConsent(request, handle, { scope: scopes });
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: 'google-' + identity.sub, metadata: { workspaceId: identity.workspaceId }, scope: approved.request.scope, props: { identityProvider: 'google', sub: identity.sub, email: identity.email, emailVerified: identity.emailVerified, workspaceId: identity.workspaceId } });
    approved.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error?.name === 'AuthorizationError' && error.redirectTo) return new Response(null, { status: 302, headers: { location: error.redirectTo } });
    return new Response(bytes('Connection request expired or could not be verified. Start the connection again.'), { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
}
