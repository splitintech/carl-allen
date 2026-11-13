/* global process, console, URL, Buffer */
// Trusted, loopback-only preview host for the same Papr publishing bundle and backend handler.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, extname, sep } from 'node:path';
import { handle } from './bundle/apps/outreach-console/backend/outreach.mjs';
import { HTML_DOCUMENT_PREVIEW_SCRIPT_HASH } from '@splitin/outreach-import';

const bundle = resolve(dirname(fileURLToPath(import.meta.url)), 'bundle/apps/outreach-console');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const standaloneFile = resolve(bundle, '../../../../../dist/publishing-studio.html');
const bodyLimit = 256 * 1024;
function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}
export function createPublishingPreview({ handler = handle, standalone = false } = {}) {
  return createServer(async (request, response) => {
    try {
      const address = request.socket.localAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return send(response, 403, { error: 'Loopback access required' });
      const host = request.headers.host;
      const port = request.socket.localPort;
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return send(response, 403, { error: 'Invalid local host' });
      const origin = `http://${host}`;
      const url = new URL(request.url, origin);
      if(url.pathname==='/browser-login'&&request.method==='GET'){
        const wrapped=await handler('social-login-view',{sessionId:url.searchParams.get('session')});if(wrapped?.ok===false)throw new Error('Private browser access could not be renewed');const result=wrapped?.data??wrapped;
        const view=new URL(result.url);if(view.protocol!=='https:'||view.username||view.password)throw new Error('Invalid private browser link');
        response.writeHead(302,{'location':view.href,'cache-control':'no-store','referrer-policy':'no-referrer'});return response.end();
      }
      const mailboxCallback=/^\/auth\/mailbox\/(gmail|outlook|zoho)\/callback$/.exec(url.pathname);
      if(mailboxCallback&&request.method==='GET'){
        try{const wrapped=await handler('mailbox-oauth-callback',{provider:mailboxCallback[1],query:Object.fromEntries([...url.searchParams].filter(([key])=>['code','state','error','location'].includes(key)))});if(wrapped?.ok===false)throw new Error('Mailbox consent failed');
          response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});return response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Mailbox connected · Carl-Allen</title><body style="background:#171717;color:#eee;font:18px system-ui;padding:10vh 8vw"><h1>Mailbox consent received</h1><p>Return to Carl-Allen to choose and confirm your mailbox.</p><a style="color:#ee7828" href="/?view=accounts">Return to Settings</a></body></html>');
        }catch{return send(response,400,{error:'Mailbox connection failed or expired. Return to Settings and start again.'});}
      }
      if (url.pathname.startsWith('/api/app/backend/')) {
        if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
        if (request.headers.origin !== origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return send(response, 403, { error: 'Same-origin request required' });
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(response, 415, { error: 'JSON required' });
        let bytes = 0; const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > (/work-package-(?:import|repair)$/.test(url.pathname) ? 25 * 1024 * 1024 : bodyLimit)) return send(response, 413, { error: 'Request too large' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(response, 400, { error: 'Invalid JSON' }); }
        if (body?.appId !== 'outreach-console' || !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) return send(response, 400, { error: 'Invalid application request' });
        const action = url.pathname.slice('/api/app/backend/'.length);
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(action)) return send(response, 400, { error: 'Invalid action' });
        const result = await handler(action, body.params);
        return send(response, 200, { stdout: JSON.stringify(result) });
      }
      if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, { error: 'GET required' });
      const single = url.pathname === '/standalone.html' || (standalone && url.pathname === '/');
      const path = decodeURIComponent(url.pathname === '/' ? '/publishing.html' : url.pathname);
      if (path.includes('\0') || path.split('/').some(part => part === '..' || part === 'backend') || !types[extname(path)]) return send(response, 404, { error: 'No such asset' });
      const file = single ? standaloneFile : resolve(bundle, `.${path}`);
      if (!single && !file.startsWith(bundle + sep)) return send(response, 404, { error: 'No such asset' });
      let content;
      try { content = await readFile(file); } catch { return send(response, 404, { error: 'No such asset' }); }
      const hashes = single ? [...content.toString('utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => ` 'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`).join('') : '';
      response.writeHead(200, { 'content-type': types[extname(file)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'self'; script-src 'self' '${HTML_DOCUMENT_PREVIEW_SCRIPT_HASH}'${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { send(response, 500, { error: 'Preview request failed' }); }
  });
}
export function startPublishingPreview() {
  const port = Number(process.env.OUTREACH_STUDIO_PORT ?? 8790);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535');
  const server = createPublishingPreview({ standalone: process.env.OUTREACH_STUDIO_SINGLE_FILE === '1' });
  server.listen(port, '127.0.0.1', () => console.log(`Publishing Studio: http://127.0.0.1:${port}/ (backend credentials remain server-side)`));
  server.once('error', () => { console.error('Cannot start Publishing Studio preview'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
