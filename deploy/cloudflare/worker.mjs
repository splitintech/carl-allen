/* global Request, Response, Headers, crypto, TextEncoder, btoa,URLSearchParams */
import { authConfig, beginLogin, finishLogin, webIdentity, mcpIdentity, logout } from './auth.mjs';
import { boundedBody } from './crypto.mjs';
import { delegateRequest, browserLogin } from './proxy.mjs';
import { mediaRoute, serviceMediaRoute } from './media.mjs';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
const unsafe = method => !['GET', 'HEAD'].includes(method);
function sameOrigin(request, env) {
  if (request.headers.get('origin') !== new URL(env.PUBLIC_ORIGIN).origin || (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) throw new Error('Same-origin request required');
}
export function createWorker({ fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env, context) {
      const url = new URL(request.url);
      try {
        const cfg = authConfig(env);
        if (url.origin !== cfg.origin) return json({ error: 'invalid_host' }, 403);
        if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return json({ resource: cfg.origin + '/mcp', authorization_servers: [cfg.origin], scopes_supported: ['carl:read', 'carl:prepare', 'carl:control'], bearer_methods_supported: ['header'], resource_documentation: cfg.origin + '/help/mcp' });
        if (url.pathname.startsWith('/internal/media/')) return await serviceMediaRoute(request, env);
        if (url.pathname === '/health') return json({ service: 'carl-allen-gateway', configured: Boolean(env.SESSION_SECRET && env.CLOUD_GATEWAY_SECRET && (env.DAYTONA_API_KEY || env.DAYTONA_API_URL)), liveAccountAcceptance: 'not_implied' });
        if (url.pathname === '/auth/login' && request.method === 'GET') return await beginLogin(request, env);
        if (url.pathname === '/auth/callback' && request.method === 'GET') return await finishLogin(request, env, fetchImpl);
        if (url.pathname === '/mcp') {
          if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
          let identity; try { identity = mcpIdentity(context, env); } catch { return json({ error: 'unauthorized' }, 401, { 'www-authenticate': `Bearer resource_metadata="${cfg.origin}/.well-known/oauth-protected-resource"` }); }
          const allowed = [cfg.origin, 'https://chatgpt.com', 'https://chat.openai.com', 'https://apps.papr.ai', ...(env.MCP_ALLOWED_ORIGINS ? JSON.parse(env.MCP_ALLOWED_ORIGINS) : [])];
          if (request.headers.get('origin') && !allowed.includes(request.headers.get('origin'))) return json({ error: 'invalid_origin' }, 403);
          const body = await boundedBody(request, 1024 * 1024);
          return await delegateRequest(env, identity, 'POST', '/mcp', body, fetchImpl);
        }
        let identity;
        try { identity = await webIdentity(request, env); } catch {
          if (url.pathname.startsWith('/api/')) return json({ error: 'sign_in_required', loginUrl: '/auth/login' }, 401);
          return new Response(null, { status: 302, headers: { location: '/auth/login?returnTo=' + encodeURIComponent(url.pathname + url.search), 'cache-control': 'no-store' } });
        }
        if(url.pathname==='/browser-login'&&request.method==='GET'){
          const member=await delegateRequest(env,identity,'GET','/v1/me',undefined,fetchImpl);if(!member.ok||!(await member.json()).roles?.includes('admin'))return json({error:'admin_required'},403);
          const session=url.searchParams.get('session');if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(session||''))return json({error:'Select an account connection in Settings first'},400);
          const opened=await delegateRequest(env,identity,'POST',`/v1/social/connections/${session}/open`,new TextEncoder().encode('{}'),fetchImpl);if(!opened.ok)return opened;
          const sessionView=await opened.json();const view=await browserLogin(env,fetchImpl,sessionView.desktopPath);return new Response(null,{status:302,headers:{location:view.url,'cache-control':'no-store','referrer-policy':'no-referrer'}});
        }
        if (url.pathname === '/auth/session') return json({ authenticated: true, csrf: identity.csrf, workspaceId: identity.workspaceId });
        const mailboxCallback=/^\/auth\/mailbox\/(gmail|outlook|zoho)\/callback$/.exec(url.pathname);
        if(mailboxCallback&&request.method==='GET'){
          const query=new URLSearchParams([...url.searchParams].filter(([key])=>['code','state','error','location'].includes(key)));
          const result=await delegateRequest(env,identity,'GET',`/v1/mailboxes/oauth/${mailboxCallback[1]}/callback?${query}`,undefined,fetchImpl);if(!result.ok)return result;
          return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Mailbox connected · Carl-Allen</title><body style="background:#171717;color:#eee;font:18px system-ui;padding:10vh 8vw"><h1>Mailbox consent received</h1><p>Return to Carl-Allen to choose and confirm your mailbox.</p><a style="color:#ee7828" href="/?view=accounts">Return to Settings</a></body></html>',{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"}});
        }
        if (url.pathname === '/auth/logout' && request.method === 'POST') { sameOrigin(request, env); if (request.headers.get('x-carl-csrf') !== identity.csrf) return json({ error: 'invalid_csrf' }, 403); return logout(request, env); }
        if (url.pathname.startsWith('/api/')) {
          if (unsafe(request.method)) {
            sameOrigin(request, env);
            if (request.headers.get('x-carl-csrf') !== identity.csrf) return json({ error: 'invalid_csrf' }, 403);
          }
          if(url.pathname==='/api/v1/browser-login' && request.method==='POST'){const member=await delegateRequest(env,identity,'GET','/v1/me',undefined,fetchImpl);if(!member.ok)return json({error:'forbidden'},403);const data=await member.json();if(!data.roles?.includes('admin'))return json({error:'admin_required'},403);const body=await request.json();if(!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(body.sessionId||''))return json({error:'connection_session_required'},400);const opened=await delegateRequest(env,identity,'POST',`/v1/social/connections/${body.sessionId}/open`,new TextEncoder().encode('{}'),fetchImpl);if(!opened.ok)return opened;const sessionView=await opened.json();return json(await browserLogin(env,fetchImpl,sessionView.desktopPath));}
          if (url.pathname.startsWith('/api/media/')) return await mediaRoute(request, env, identity, fetchImpl);
          if (!url.pathname.startsWith('/api/v1/')) return json({ error: 'not_found' }, 404);
          const path = url.pathname.slice('/api'.length) + url.search;
          if (request.method === 'TRACE' || request.method === 'CONNECT') return json({ error: 'method_not_allowed' }, 405);
          if (unsafe(request.method) && request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'json_required' }, 415);
          return await delegateRequest(env, identity, request.method, path, await boundedBody(request), fetchImpl);
        }
        if (url.pathname === '/' || url.pathname === '/publishing-studio.html') {
          // Asset access is gated by the same engine membership, not just possession of any Google account.
          const member = await delegateRequest(env, identity, 'GET', '/v1/me', undefined, fetchImpl);
          if (!member.ok) return json({ error: 'invitation_required' }, 403);
          const asset = await env.ASSETS.fetch(new Request(cfg.origin + '/publishing-studio.html'));
          const html = await asset.text();
          const hashes = await Promise.all([...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(async match => { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1])); return ` 'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`; }));
          const headers = new Headers(asset.headers); headers.set('cache-control', 'private, no-store'); headers.set('x-frame-options', 'DENY'); headers.set('referrer-policy', 'no-referrer');
          headers.set('content-security-policy', `default-src 'self'; script-src 'self'${hashes.join('')}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`);
          return new Response(html, { status: asset.status, headers });
        }
        return json({ error: 'not_found' }, 404);
      } catch (error) {
        if (error instanceof Error && error.message === 'Same-origin request required') return json({ error: 'invalid_origin' }, 403);
        if (url.pathname === '/auth/callback') return json({ error: 'login_failed', message: 'Start Google sign-in again in this browser.', loginUrl: '/auth/login' }, 400);
        const tooLarge = error instanceof Error && error.message === 'Request too large';
        return json({ error: tooLarge ? 'too_large' : 'gateway_unavailable', message: tooLarge ? 'Request exceeds upload limit' : 'Check connection settings or sign in again' }, tooLarge ? 413 : 503);
      }
    },
  };
}
export default createWorker();
