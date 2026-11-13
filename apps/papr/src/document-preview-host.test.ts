import { once } from 'node:events';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { buildHtmlDocumentPreview, extractWorkPackage, HTML_DOCUMENT_PREVIEW_SCRIPT_HASH } from '@splitin/outreach-import';

const host = await import(pathToFileURL(resolve('apps/papr/preview.mjs')).href) as { createPublishingPreview(options: { handler(action: string): Promise<unknown> }): Server };
it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1')('opens the original document and its selection bridge under the real host CSP', async () => {
  const html = '<html><title>Host policy file</title><body><h1>Original source under host policy</h1><a href="https://example.invalid/reference">Reference</a><script>parent.originalScriptRan=true;fetch("https://never-fetch.invalid/")</script></body></html>';
  const parsed = extractWorkPackage(html); const preview = buildHtmlDocumentPreview(html);
  const pack = { id: 'host-policy-fixture', name: 'Host policy file', revision: 1, status: 'ready_for_review', manifest: parsed.manifest, extractedActions: parsed.actions, cloudReceipt: { sourceHash: parsed.sourceHash, stored: true, originalRemoteReady: false, placement: 'local' } };
  const server = host.createPublishingPreview({ handler: async (action) => {
    if (action === 'work-package-document') return { ok: true, data: { document: { packageId: pack.id, name: pack.name, ...preview } } };
    if (action === 'document-job-list') return { ok: true, data: { jobs: [] } };
    throw new Error('Only read requests are expected in the host fixture');
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.OUTREACH_TEST_CHROME || chromium.executablePath(), headless: true });
  try {
    const page = await browser.newPage(); const errors: string[] = []; const outbound: string[] = []; let policy = '';
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { outbound.push(url.origin); await route.abort(); return; }
      if (url.pathname === '/') {
        const response = await route.fetch(); policy = response.headers()['content-security-policy'] || '';
        await route.fulfill({ response, body: '<!doctype html><html><head><link rel="stylesheet" href="/publishing/base.css"><link rel="stylesheet" href="/publishing/workspace.css"></head><body><div id="studio-toast"></div><script type="module" src="/publishing/host-policy-fixture.js"></script></body></html>' }); return;
      }
      if (url.pathname === '/publishing/host-policy-fixture.js') {
        await route.fulfill({ contentType: 'application/javascript', body: `import {showDocumentWorkspace} from '/publishing/document-workspace.js';showDocumentWorkspace(${JSON.stringify(pack)},{roles:['admin'],accounts:[],media:[]},async()=>{});` }); return;
      }
      await route.continue();
    });
    await page.goto(origin);
    expect(policy).toContain(`'${HTML_DOCUMENT_PREVIEW_SCRIPT_HASH}'`); expect(policy).toContain("frame-src 'self'");
    const frame = page.frameLocator('iframe.document-preview-frame');
    await frame.getByRole('heading', { name: 'Original source under host policy' }).waitFor();
    await page.evaluate("globalThis.documentSelections=[];addEventListener('message',e=>{if(e.data?.type==='carl-allen-document-action')globalThis.documentSelections.push(e.data);});");
    await frame.locator('a').click();
    await expect.poll(async () => (await page.evaluate('globalThis.documentSelections') as unknown[]).length).toBe(1);
    expect(await page.evaluate('globalThis.originalScriptRan')).toBeUndefined();
    expect(await page.getByRole('checkbox', { name: 'Include trigger Reference', exact: true }).isChecked()).toBe(false);
    expect(errors).toEqual([]); expect(outbound).toEqual([]);
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}, 30_000);
