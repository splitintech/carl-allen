#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const checks = [];
for (const name of ['PUBLIC_ORIGIN','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','WORKSPACE_ID','SESSION_SECRET','CLOUD_GATEWAY_SECRET','CLOUD_MEDIA_SECRET']) {
  const value = process.env[name]; checks.push({ check: name, configured: Boolean(value && !/CONFIGURE_/.test(value)), ...(['SESSION_SECRET','CLOUD_GATEWAY_SECRET','CLOUD_MEDIA_SECRET'].includes(name) ? { sufficientLength: Boolean(value && value.length >= 32) } : {}) });
}
checks.push({ check: 'private_daytona_connection', configured: Boolean((process.env.DAYTONA_API_KEY && process.env.DAYTONA_SANDBOX_ID) || (process.env.DAYTONA_API_URL && process.env.DAYTONA_PREVIEW_TOKEN)) });
const htmlPath = resolve('dist/publishing-studio.html'); checks.push({ check: 'single_html', configured: existsSync(htmlPath) && !/<script[^>]*\bsrc=|<link[^>]*\bhref=/i.test(readFileSync(htmlPath, 'utf8')) });
console.log(JSON.stringify({ ready: checks.every(c => c.configured && c.sufficientLength !== false), checks, credentialsPrinted: false }, null, 2));
if (checks.some(c => !c.configured || c.sufficientLength === false)) process.exitCode = 1;
