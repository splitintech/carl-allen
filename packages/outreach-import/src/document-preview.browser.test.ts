import { expect, it } from 'vitest';
import { chromium } from 'playwright';
import { buildHtmlDocumentPreview } from './document-preview';

it.skipIf(process.env.OUTREACH_DOCUMENT_BROWSER_FIXTURES !== '1' && process.env.OUTREACH_BROWSER_FIXTURES !== '1')('renders the original layout in an opaque sandbox and selects triggers without original effects or requests', async () => {
  const browser = await chromium.launch({ executablePath: process.env.OUTREACH_TEST_CHROME || chromium.executablePath(), headless: true, timeout: 15_000 });
  try {
    const page = await browser.newPage(); const unexpectedRequests: string[] = []; const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', async (route) => {
      if (route.request().url() === 'https://document-preview.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><iframe id="preview" sandbox="allow-scripts"></iframe><script>window.previewMessages=[];window.previewReadyMessages=[];window.previewLoads=0;document.getElementById("preview").addEventListener("load",()=>window.previewLoads++);window.addEventListener("message",event=>{const message={origin:event.origin,data:event.data,sameFrame:event.source===document.getElementById("preview").contentWindow};if(event.data?.type==="carl-allen-document-ready")window.previewReadyMessages.push(message);else window.previewMessages.push(message);});</script></body></html>' });
      unexpectedRequests.push(route.request().url()); return route.abort();
    });
    const preview = buildHtmlDocumentPreview('<!doctype html><html><head><title>Original file</title><style>body{background:#123456}.contact-card{display:grid;grid-template-columns:1fr 2fr}@import "https://example.invalid/style.css";</style></head><body onload="parent.stolen=true"><script>globalThis.__originalScriptExecuted=true;parent.location="https://example.invalid/escape";</script><script>function composeHelper(){window.location.href="mailto:ada@example.invalid?subject=Original%20button";}</script><article class="contact-card"><h1>Original research notes</h1><p>Ada Example, designer in San Francisco.</p><a href="https://example.invalid/profile" target="_top">View profile</a><a href="mailto:ada@example.invalid?subject=Hello">Write email</a><button id="helper-compose" data-carl-trigger-id="html-action-999" onclick="composeHelper()">Compose from original button</button><img src="https://example.invalid/image.png" alt="External portrait"></article><form action="https://example.invalid/submit"><button>Submit</button></form><iframe srcdoc="<script>fetch(\'https://example.invalid/leak\')</script>"></iframe></body></html>');
    await page.goto('https://document-preview.test/');
    await page.evaluate(`document.getElementById('preview').srcdoc=${JSON.stringify(preview.html).replace(/</g, '\\u003c')}`);
    const view = page.frameLocator('#preview');
    await view.getByRole('heading', { name: 'Original research notes' }).waitFor();
    await expect.poll(async () => (await page.evaluate('window.previewReadyMessages') as unknown[]).length).toBe(1);
    expect(await page.evaluate('window.previewReadyMessages[0]')).toMatchObject({ origin: 'null', sameFrame: true, data: { type: preview.policy.readyMessageType, sourceHash: preview.sourceHash } });
    expect(await page.evaluate('window.previewMessages')).toEqual([]);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    expect(await frame.evaluate('getComputedStyle(document.querySelector(".contact-card")).display')).toBe('grid');
    expect(await frame.evaluate('getComputedStyle(document.body).backgroundColor')).toBe('rgb(18, 52, 86)');
    expect(await frame.evaluate('getComputedStyle(document.querySelector("a[data-carl-trigger-id]")).cursor')).toBe('pointer');
    expect(await frame.evaluate('getComputedStyle(document.querySelector("a[data-carl-trigger-id]")).textDecorationLine')).toContain('underline');
    expect(await frame.evaluate('globalThis.__originalScriptExecuted')).toBeUndefined();
    expect(await frame.evaluate('(()=>{try{return !!parent.document.body}catch{return false}})()')).toBe(false);
    await view.getByRole('button', { name: 'View profile' }).click();
    await expect.poll(async () => (await page.evaluate('window.previewMessages') as unknown[]).length).toBe(1);
    expect(await page.evaluate('window.previewMessages[0]')).toMatchObject({ origin: 'null', sameFrame: true, data: { type: 'carl-allen-document-action', sourceHash: preview.sourceHash, actionId: preview.boundActionIds[0] } });
    await view.getByRole('button', { name: 'Write email' }).focus();
    await view.getByRole('button', { name: 'Write email' }).press('Enter');
    await expect.poll(async () => (await page.evaluate('window.previewMessages') as unknown[]).length).toBe(2);
    const helperAction = preview.actions.find((action) => action.source === 'onclick' && action.label === 'Compose from original button')!;
    expect(preview.boundActionIds).toContain(helperAction.id);
    expect(await frame.evaluate('typeof composeHelper')).toBe('undefined');
    await view.getByRole('button', { name: 'Compose from original button' }).click();
    await expect.poll(async () => (await page.evaluate('window.previewMessages') as unknown[]).length).toBe(3);
    expect(await page.evaluate('window.previewMessages[2].data')).toMatchObject({ actionId: helperAction.id, sourceHash: preview.sourceHash });
    await frame.evaluate('document.getElementById("helper-compose").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}))');
    await expect.poll(async () => (await page.evaluate('window.previewMessages') as unknown[]).length).toBe(4);
    expect(await page.evaluate('window.previewMessages[3].data.actionId')).toBe(helperAction.id);
    expect(await frame.evaluate('globalThis.__originalScriptExecuted')).toBeUndefined();
    await view.getByRole('button', { name: 'Submit' }).click();
    await frame.evaluate('document.querySelector("form").requestSubmit()');
    expect(frame.url()).toBe('about:srcdoc'); expect(page.url()).toBe('https://document-preview.test/');
    expect(browser.contexts()[0]?.pages()).toHaveLength(1);
    expect(unexpectedRequests).toEqual([]); expect(pageErrors).toEqual([]);
    const previousLoads = await page.evaluate('window.previewLoads') as number;
    const blockedHtml = preview.html.replace(preview.policy.csp, preview.policy.csp.replace(/script-src '[^']+'/, "script-src 'none'")).replace('Original research notes', 'CSP blocked research');
    await page.evaluate(`window.previewReadyMessages=[];document.getElementById('preview').srcdoc=${JSON.stringify(blockedHtml).replace(/</g, '\\u003c')}`);
    await view.getByRole('heading', { name: 'CSP blocked research' }).waitFor();
    await expect.poll(async () => await page.evaluate('window.previewLoads') as number).toBeGreaterThan(previousLoads);
    expect(await frame.evaluate('document.readyState')).toBe('complete');
    expect(await page.evaluate('window.previewReadyMessages')).toEqual([]);
  } finally { await browser.close(); }
});
