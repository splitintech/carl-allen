import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { chromium, type Page } from 'playwright';
import { extractWorkPackage } from '@splitin/outreach-import';
import type { WorkManifest } from '@splitin/outreach-contracts';

const publishing = resolve('apps/papr/bundle/apps/outreach-console/publishing');
interface Issue { field: string; message: string; severity?: string }
interface Helpers {
  splitIssues(issues: Issue[]): { blocking: Issue[]; notes: Issue[] };
  safeActionHref(href: string, kind?: string): string | null;
  emailHref(email: string): string | null;
  receiptSummary(pack: unknown): string;
}
const helpers = await import(pathToFileURL(resolve(publishing, 'work-package-state.js')).href) as Helpers;
const model = await import(pathToFileURL(resolve(publishing, 'model.js')).href) as { scheduleInZone(value: string, zone: string): string };

it('keeps malformed manifest failures blocking while recognizing successful legacy inference notes', () => {
  const invalid = { field: 'manifest', message: 'Invalid manifest JSON' };
  const inferred = { field: 'manifest', message: 'Inferred 3 LinkedIn profiles from this report. Map your LinkedIn account, then prepare only the reviewed connect plan.' };
  const intent = { field: 'intent.connect_first', message: 'Two contacts need a connection.' };
  const warning = { field: 'html.actions', message: 'Dynamic action needs review.', severity: 'warning' };
  const result = helpers.splitIssues([invalid, inferred, intent, warning]);
  expect(result.blocking).toEqual([invalid]); expect(result.notes).toEqual([inferred, intent, warning]);
});
it('permits explicit navigation and email drafts while rejecting executable or header-injected links', () => {
  expect(helpers.safeActionHref('https://example.invalid/book')).toBe('https://example.invalid/book');
  expect(helpers.safeActionHref('http://example.invalid/book')).toBe('http://example.invalid/book');
  expect(helpers.safeActionHref('mailto:ada@example.invalid?subject=Hello&body=Line%201%0ALine%202', 'compose_email')).toContain('body=Line%201%0ALine%202');
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.invalid/', 'file:///etc/passwd']) expect(helpers.safeActionHref(href)).toBeNull();
  expect(helpers.safeActionHref('mailto:ada@example.invalid?subject=Hi%0ABcc:other@example.invalid', 'compose_email')).toBeNull();
  expect(helpers.safeActionHref('mailto:ada@example.invalid?attach=/private/file', 'compose_email')).toBeNull();
  expect(helpers.safeActionHref('mailto:?subject=Hello&body=Draft', 'compose_email')).toBe('mailto:?subject=Hello&body=Draft'); expect(helpers.emailHref('')).toBeNull();
  for (const href of ['mailto://example.invalid/?subject=Hello', 'mailto:ada@example.invalid#fragment', 'mailto:ada@example.invalid?subject=%ZZ', 'mailto:ada@example.invalid?CC=bad%0Aheader', 'mailto:ada@example.invalid%0D', 'mailto:ada%00@example.invalid']) expect(helpers.safeActionHref(href, 'compose_email')).toBeNull();
});
it('describes saved original storage independently from preparation and approval', () => {
  expect(helpers.receiptSummary({ cloudReceipt: { stored: true, placement: 'daytona', originalRemoteReady: true, executionReady: false } })).toBe('Original HTML saved in Daytona');
  expect(helpers.receiptSummary({ cloudReceipt: { stored: true, placement: 'daytona', originalRemoteReady: false } })).toContain('cloud file storage needs attention');
  expect(helpers.receiptSummary({ cloudReceipt: { placement: 'local' } })).toBe('HTML saved locally');
});

const html = '<!doctype html><title>HTML action review</title><article class="card"><a href="https://www.linkedin.com/in/ada-example/">Ada Example</a> <span>Connect first</span> <a href="mailto:ada@example.invalid?subject=Hello&body=Draft%20message">Email Ada</a> <a href="https://example.invalid/book">Book a meeting</a></article><button onclick="window.open(\'https://example.invalid/docs\')">Read documentation</button><button onclick="runSomething()">Dynamic action</button>';
async function fixture(page: Page) {
  const account = { id: 'account-linkedin', provider: 'social-browser', externalAccountId: 'https://www.linkedin.com/in/fixture-owner/', sender: { name: 'Fixture owner' }, health: 'reauth_required', capabilities: { socialChannels: ['linkedin'], socialConnect: true } };
  const data = { roles: ['admin'], accounts: [account], media: [] };
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  let pack: Record<string, unknown> = {};
  await page.route('https://review.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      const { params } = route.request().postDataJSON() as { params: Record<string, unknown> }; const action = url.pathname.split('/').at(-1)!; calls.push({ action, params }); let value: unknown;
      if (action === 'work-package-import') {
        const extracted = extractWorkPackage(String(params.html));
        pack = { id: 'fixture-package', revision: 1, name: extracted.manifest?.name || String(params.name), status: extracted.manifest ? 'ready_for_review' : 'needs_repair', manifest: extracted.manifest, issues: extracted.issues, extractedActions: extracted.actions, extractedTables: extracted.tables, accountMap: {}, mediaMap: {}, cloudReceipt: { stored: true, originalRemoteReady: true, executionReady: false, accepted: false, placement: 'daytona' } }; value = { package: pack };
      } else if (action === 'work-package-repair') {
        const input = params.input as { manifest?: WorkManifest; accountMap?: Record<string, string>; mediaMap?: Record<string, string> }; pack = { ...pack, ...input, status: 'ready_for_review' }; value = { package: pack };
      } else if (action === 'work-package-prepare') {
        pack = { ...pack, status: 'awaiting_approval' }; const manifest = pack.manifest as WorkManifest;
        value = { package: pack, authorizationId: 'fixture-authorization', operationHash: 'a'.repeat(64), preview: { posts: manifest.publishingPlans, contacts: manifest.contacts, sequences: manifest.outreachSequences, issues: pack.issues, renderedActions: [{ id: 'fixture-action', payload: { channel: 'linkedin', targetUrl: manifest.contacts[0]?.linkedin } }] } };
      } else if (action === 'account-check') { account.health = 'ok'; value = { status: 'ok' }; }
      else if (action === 'publishing-overview') value = data;
      else throw new Error('Unexpected fixture operation: ' + action);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: true, data: value }) }) }); return;
    }
    if (url.pathname === '/') {
      const body = '<!doctype html><html><head><link rel="stylesheet" href="/publishing/base.css"><link rel="stylesheet" href="/publishing/workspace.css"><link rel="stylesheet" href="/publishing/composer.css"><link rel="stylesheet" href="/publishing/mobile.css"></head><body><button id="import">Import report</button><div id="studio-toast"></div><script type="module">import {openImport} from "/publishing/work-packages.js";document.querySelector("#import").addEventListener("click",()=>openImport(' + JSON.stringify(data) + ',async()=>{}));document.addEventListener("click",event=>{const link=event.target.closest("a");if(link){event.preventDefault();globalThis.clickedLinks||=[];globalThis.clickedLinks.push(link.href);}});</script></body></html>';
      await route.fulfill({ contentType: 'text/html', body }); return;
    }
    const file = resolve('apps/papr/bundle/apps/outreach-console', url.pathname.slice(1));
    await route.fulfill({ contentType: extname(file) === '.css' ? 'text/css' : 'application/javascript', body: readFileSync(file) });
  });
  return { calls, getPack: () => pack };
}
async function uploadReport(page: Page, source: string) {
  await page.getByRole('button', { name: 'Import report', exact: true }).click();
  await page.getByLabel('HTML plan or research report').setInputFiles({ name: 'report.html', mimeType: 'text/html', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Import and check files', exact: true }).click();
}
const browserTest = it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1');
browserTest('uploads a report, opens retained actions, repairs account/schedule and prepares without sending', async () => {
  const browser = await chromium.launch({ executablePath: process.env.OUTREACH_TEST_CHROME || chromium.executablePath(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'America/New_York' }); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message)); const f = await fixture(page);
    await page.goto('https://review.test/?appId=fixture'); await uploadReport(page, html);
    await expect.poll(() => page.locator('dialog h2').allTextContents(), { timeout: 5000 }).toContain('HTML action review');
    expect(await page.getByRole('heading', { name: 'Original HTML saved in Daytona', exact: true }).count()).toBe(1);
    expect(await page.getByText('Cloud handoff is not complete.', { exact: false }).count()).toBe(0);
    expect(await page.getByRole('region', { name: 'Import notes', exact: true }).count()).toBe(1);
    expect(await page.getByRole('alert', { name: 'Resolve before preparing', exact: true }).count()).toBe(0);
    const compose = page.getByRole('link', { name: 'Compose email: Email Ada', exact: true }); expect(await compose.getAttribute('href')).toContain('subject=Hello'); expect(await compose.getAttribute('href')).toContain('body=Draft'); await compose.click();
    const book = page.getByRole('link', { name: 'Open link: Book a meeting', exact: true }); expect(await book.getAttribute('rel')).toContain('noopener'); await book.click();
    expect(await page.evaluate('globalThis.clickedLinks')).toEqual(expect.arrayContaining(['https://example.invalid/book', expect.stringContaining('mailto:ada@example.invalid')]));
    expect(await page.getByRole('link', { name: 'Open LinkedIn profile', exact: true }).count()).toBe(1);
    expect(await page.getByText('Dynamic action', { exact: true }).count()).toBe(1);
    await page.getByLabel('Map account LinkedIn account for connection requests').selectOption('account-linkedin');
    expect(await page.getByText(/You have unsaved changes/).count()).toBe(1); await page.getByRole('button', { name: 'Reconnect LinkedIn', exact: true }).click();
    await page.getByRole('heading', { name: 'Reconnect LinkedIn', exact: true }).waitFor(); expect(await page.getByRole('button', { name: 'Start private sign-in', exact: true }).count()).toBe(1); await page.getByRole('button', { name: 'Finish later', exact: true }).click();
    await page.getByRole('button', { name: 'Check connection', exact: true }).click(); await page.getByText('Account connection is healthy.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Prepare connection requests', exact: true }).click();
    expect(f.calls.filter((call) => call.action === 'work-package-prepare')).toHaveLength(0); expect(await page.getByRole('alert').textContent()).toContain('Choose a future time');
    const scheduled = model.scheduleInZone(new Date(Date.now() + 48 * 3600000).toISOString(), 'America/New_York');
    await page.getByLabel('Start time for Connect first · LinkedIn').fill(scheduled); await page.getByRole('button', { name: 'Save repairs', exact: true }).click();
    await expect.poll(() => f.calls.filter((call) => call.action === 'work-package-repair').length).toBe(1);
    expect(f.getPack().accountMap).toEqual({ 'linkedin-main': 'account-linkedin' }); const saved = f.getPack().manifest as WorkManifest; expect(Date.parse(saved.outreachSequences[0]!.scheduledFor!)).toBeGreaterThan(Date.now());
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    const artifacts = process.env.OUTREACH_BROWSER_ARTIFACT_DIR || resolve(tmpdir(), 'carl-allen-html-ui'); mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: resolve(artifacts, 'html-review-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'Prepare connection requests', exact: true }).click(); await page.getByRole('heading', { name: 'Approve the exact plan', exact: true }).waitFor(); expect(await page.getByRole('button', { name: 'Approve this exact plan', exact: true }).count()).toBe(1);
    expect(f.calls.filter((call) => call.action === 'work-package-prepare')).toHaveLength(1); expect(f.calls.some((call) => /approve|send/.test(call.action))).toBe(false); expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 90000);
browserTest('keeps action-only reports usable and malformed manifests visibly blocking', async () => {
  const browser = await chromium.launch({ executablePath: process.env.OUTREACH_TEST_CHROME || chromium.executablePath(), headless: true });
  try {
    const page = await browser.newPage(); const f = await fixture(page); await page.goto('https://review.test/');
    await uploadReport(page, '<title>Links only</title><a href="https://example.invalid/guide">Guide</a><a href="mailto:ada@example.invalid">Email Ada</a>');
    await expect.poll(() => page.locator('dialog h2').allTextContents(), { timeout: 5000 }).toContain('Links only'); expect(await page.getByRole('link', { name: 'Open link: Guide', exact: true }).count()).toBe(1); expect(await page.getByRole('link', { name: 'Compose email: Email Ada', exact: true }).count()).toBe(1); expect(await page.getByRole('button', { name: /^Prepare / }).count()).toBe(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await uploadReport(page, '<title>Broken manifest</title><script type="application/json" id="carl-allen-manifest">{broken}</script><a href="https://example.invalid/guide">Guide</a>');
    await page.getByRole('heading', { name: 'report.html', exact: true }).waitFor(); expect(await page.getByRole('alert', { name: 'Resolve before preparing', exact: true }).textContent()).toContain('Invalid manifest JSON'); expect(await page.getByRole('link', { name: 'Open link: Guide', exact: true }).count()).toBe(1); expect(f.calls.some((call) => /prepare|approve|send/.test(call.action))).toBe(false);
  } finally { await browser.close(); }
}, 90000);
