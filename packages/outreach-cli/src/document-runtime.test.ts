import { describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { sha256Hex } from '@splitin/outreach-contracts';
import { extractWorkPackage } from '@splitin/outreach-import';
import { createDocumentJobRunner } from './document-runtime';

const html = '<html><title>Automatic file fixture</title><body><a href="https://example.test/start">Open site</a><a href="mailto:fixture@example.invalid?subject=Draft&body=One%0ATwo">Open email</a><script>fetch("https://never-execute.invalid")</script></body></html>';
const actions = () => extractWorkPackage(html).actions.filter((action) => action.kind !== 'unsupported');
function fakeBrowser() {
  const loaded: string[] = []; const clicked: string[] = []; let closed = false;
  const context = { route: async () => {}, newPage: async () => ({ setContent: async (value: string) => { loaded.push(value); }, locator: (selector: string) => ({ dispatchEvent: async () => { clicked.push(selector); } }), title: async () => 'Rendered linked page', close: async () => {} }) };
  return { browser: { newContext: async () => context, close: async () => { closed = true; } } as unknown as Browser, loaded, clicked, isClosed: () => closed };
}
describe('automatic document runner', () => {
  it('loads the original first, activates selected triggers, and retains in-app drafts without provider sends', async () => {
    const browser = fakeBrowser(); let navigated = false;
    const runner = createDocumentJobRunner({ enabled: true }, { launch: async () => browser.browser, readUrl: async (url) => { navigated = true; expect(browser.loaded).toHaveLength(1); return { requestedUrl: url, finalUrl: 'https://example.test/final', httpStatus: 200, html: '<title>Rendered linked page</title><script>secret()</script>' }; } });
    const result = await runner.run({ jobId: 'fixture', html, sourceHash: sha256Hex(html), actions: actions(), signal: new AbortController().signal });
    expect(navigated).toBe(true); expect(browser.loaded).toHaveLength(2); expect(browser.clicked).toHaveLength(2); expect(browser.isClosed()).toBe(true);
    expect(result.results.map((entry) => entry.status)).toEqual(['completed', 'completed']);
    expect(result.results[0]).toMatchObject({ kind: 'open_url', title: 'Rendered linked page', finalUrl: 'https://example.test/final', httpStatus: 200 });
    expect(result.results[1]).toMatchObject({ kind: 'compose_email', draft: { to: ['fixture@example.invalid'], subject: 'Draft', body: 'One\nTwo' } });
    expect(browser.loaded.join('')).not.toContain('fetch("https://never-execute.invalid")');
  });
  it('rejects source changes and altered trigger meanings before launching a browser', async () => {
    const runner = createDocumentJobRunner({ enabled: true }, { launch: async () => { throw new Error('Browser must not launch'); } });
    await expect(runner.run({ jobId: 'fixture', html, sourceHash: '0'.repeat(64), actions: actions(), signal: new AbortController().signal })).rejects.toThrow('saved original');
    const selected = actions(); if (selected[0]?.kind === 'open_url') selected[0].href = 'https://changed.test/';
    await expect(runner.run({ jobId: 'fixture', html, sourceHash: sha256Hex(html), actions: selected, signal: new AbortController().signal })).rejects.toThrow('trigger changed');
  });
  it('records navigation failure separately while preserving the email-draft result', async () => {
    const browser = fakeBrowser(); const runner = createDocumentJobRunner({ enabled: true }, { launch: async () => browser.browser, readUrl: async () => { throw new Error('Destination unavailable'); } });
    const result = await runner.run({ jobId: 'fixture', html, sourceHash: sha256Hex(html), actions: actions(), signal: new AbortController().signal });
    expect(result.results[0]).toMatchObject({ kind: 'open_url', status: 'failed', detail: 'Destination unavailable' }); expect(result.results[1]?.status).toBe('completed');
  });
  it('does not start disabled or already-cancelled jobs', async () => {
    const input = { jobId: 'fixture', html, sourceHash: sha256Hex(html), actions: actions(), signal: AbortSignal.abort() };
    await expect(createDocumentJobRunner({ enabled: false }).run(input)).rejects.toThrow('disabled');
    await expect(createDocumentJobRunner({ enabled: true }).run(input)).rejects.toThrow();
  });
});

it.skipIf(process.env.OUTREACH_DOCUMENT_BROWSER_TESTS !== '1' && process.env.OUTREACH_BROWSER_FIXTURES !== '1')('renders the original and destination with real isolated Chromium while activating draft/link triggers', async () => {
  const requests: string[] = [];
  const runner = createDocumentJobRunner({ enabled: true }, { launch: async () => {
    const browser = await chromium.launch({ executablePath: process.env.OUTREACH_TEST_CHROME, headless: true });
    const newContext = browser.newContext.bind(browser); browser.newContext = async (options) => { const context = await newContext(options); context.on('request', (request) => requests.push(request.url())); return context; };
    return browser;
  }, readUrl: async (url) => ({ requestedUrl: url, finalUrl: url, httpStatus: 200, html: '<title>Real background render</title><p>Loaded</p>' }) });
  const result = await runner.run({ jobId: 'real-browser-fixture', html, sourceHash: sha256Hex(html), actions: actions(), signal: new AbortController().signal });
  expect(result.results[0]).toMatchObject({ kind: 'open_url', status: 'completed', title: 'Real background render' }); expect(result.results[1]?.status).toBe('completed'); expect(requests).toEqual([]);
}, 30_000);
