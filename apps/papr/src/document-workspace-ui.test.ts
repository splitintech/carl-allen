import { mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { it, expect } from 'vitest';
import { chromium, type Page } from 'playwright';
import { extractWorkPackage, buildHtmlDocumentPreview } from '@splitin/outreach-import';
import type { HtmlImportAction } from '@splitin/outreach-contracts';

const enabled = process.env.OUTREACH_BROWSER_FIXTURES === '1';
const executablePath = process.env.OUTREACH_TEST_CHROME || chromium.executablePath();
const model = await import(pathToFileURL(resolve('apps/papr/bundle/apps/outreach-console/publishing/model.js')).href) as { scheduleInZone(value: string, zone: string): string };
const source = '<!doctype html><html><head><title>My campaign file</title><style>body{font-family:Georgia;padding:28px;background:#fff8ef;color:#30291f}h1{color:#aa4d12}.original-card{padding:24px;border:2px solid #ee7828;border-radius:12px}a{display:block;margin:14px 0}</style></head><body><h1>Research notebook</h1><section class="original-card"><h2>Project research</h2><p>The original document stays visible here.</p><a href="https://example.invalid/project">Project page</a><a href="mailto:ada@example.invalid?subject=Research&body=Hello%20Ada">Email contact</a><button onclick="window.open(\'https://example.invalid/docs\')">Read docs</button><button onclick="dynamicFunction()">Dynamic control</button></section><script>parent.sourceExecuted=true;fetch("https://tracker.invalid/script")</script><img src="https://tracker.invalid/pixel"><form action="https://tracker.invalid/form"><input name="secret" value="never"><button>Submit form</button></form></body></html>';
interface Job {
  id: string; packageId: string; sourceHash: string; name: string; selectedActionIds: string[]; actions: HtmlImportAction[]; scheduledFor: string | null; timezone: string; status: string; revision: number; results: Record<string, unknown>[]; detail: string; createdAt: number; updatedAt: number;
}
async function fixture(page: Page, options: { delayDocument?: boolean; wrongHash?: boolean; failCreate?: boolean; blockFirstBridge?: boolean; blockReloadBridge?: boolean; legacyEmptyDraft?: boolean; savedPausedJob?: boolean } = {}) {
  const parsed = extractWorkPackage(source); const preview = buildHtmlDocumentPreview(source);
  const pack = { id: 'fixture-file', name: 'My campaign file', revision: 1, status: 'ready_for_review', manifest: parsed.manifest, extractedActions: parsed.actions, extractedTables: parsed.tables, issues: parsed.issues, accountMap: {}, mediaMap: {}, cloudReceipt: { stored: true, originalRemoteReady: true, executionReady: false, placement: 'daytona', sourceHash: parsed.sourceHash } };
  const calls: { action: string; params: Record<string, unknown> }[] = []; const blocked: string[] = []; let jobs: Job[] = []; let failCreate = options.failCreate; let releaseDocument = () => {}; let blockFirstBridge = options.blockFirstBridge; let documentLoads = 0;
  if (options.legacyEmptyDraft) jobs.push({ id: 'legacy-empty', packageId: pack.id, sourceHash: preview.sourceHash, name: 'Legacy empty draft', selectedActionIds: [], actions: [], scheduledFor: null, timezone: 'UTC', status: 'paused', revision: 1, results: [], detail: 'Previously saved without triggers.', createdAt: Date.now(), updatedAt: Date.now() });
  if (options.savedPausedJob) { const actions = preview.actions.filter((action) => action.kind !== 'unsupported').slice(0, 1); jobs.push({ id: 'saved-paused', packageId: pack.id, sourceHash: preview.sourceHash, name: 'Previously selected job', selectedActionIds: actions.map((action) => action.id), actions, scheduledFor: new Date(Date.now() + 86400000).toISOString(), timezone: 'UTC', status: 'paused', revision: 1, results: [], detail: 'Paused with a frozen selection.', createdAt: Date.now(), updatedAt: Date.now() }); }
  const documentReady = new Promise<void>((release) => { releaseDocument = release; });
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url()); if (url.origin !== 'https://file.test') { blocked.push(url.href); await route.abort(); return; }
    if (url.pathname.startsWith('/api/')) {
      const { params } = route.request().postDataJSON() as { params: Record<string, unknown> }; const action = url.pathname.split('/').at(-1)!; calls.push({ action, params }); let value: unknown;
      if (action === 'work-package-import') { expect(params.html).toBe(source); value = { package: pack }; }
      else if (action === 'work-package-document') { if (options.delayDocument) await documentReady; documentLoads++; const html = blockFirstBridge || options.blockReloadBridge && documentLoads > 1 ? preview.html.replaceAll('carl-allen-document-ready', 'blocked-document-ready') : preview.html; blockFirstBridge = false; value = { document: { ...preview, html, sourceHash: options.wrongHash ? 'b'.repeat(64) : preview.sourceHash, packageId: pack.id, name: pack.name } }; }
      else if (action === 'document-job-list') value = { jobs };
      else if (action === 'document-job-create') {
        if (failCreate) { failCreate = false; await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: false, error: 'Fixture job storage unavailable' }) }) }); return; }
        const input = params.input as { name: string; sourceHash: string; selectedActionIds: string[]; scheduledFor: string | null; timezone: string; paused: boolean };
        expect(input.sourceHash).toBe(parsed.sourceHash); const actions = parsed.actions.filter((item) => input.selectedActionIds.includes(item.id)); expect(actions.every((item) => item.kind !== 'unsupported')).toBe(true);
        const now = Date.now(); const job: Job = { ...input, id: 'job-' + (jobs.length + 1), packageId: pack.id, actions, status: input.scheduledFor ? input.paused ? 'paused' : 'scheduled' : 'draft', revision: 1, results: [], detail: 'Saved by the fixture server.', createdAt: now, updatedAt: now }; jobs.unshift(job); value = { job };
      } else if (action === 'document-job-update') {
        const job = jobs.find((item) => item.id === params.jobId)!; const input = params.input as { expectedRevision: number; paused?: boolean; scheduledFor?: string | null; cancel?: boolean }; expect(input.expectedRevision).toBe(job.revision);
        if (input.scheduledFor !== undefined) job.scheduledFor = input.scheduledFor; job.status = input.cancel ? 'cancelled' : input.paused === true ? 'paused' : input.paused === false ? 'scheduled' : job.status; job.revision++; value = { job };
      } else throw new Error('Unexpected document-workspace operation: ' + action);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: true, data: value }) }) }); return;
    }
    if (url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/publishing/base.css"><link rel="stylesheet" href="/publishing/workspace.css"><link rel="stylesheet" href="/publishing/composer.css"><link rel="stylesheet" href="/publishing/mobile.css"></head><body><button id="upload">Upload file</button><div id="studio-toast"></div><script type="module">import{openImport}from"/publishing/work-packages.js";document.querySelector("#upload").addEventListener("click",()=>openImport({roles:["admin"],accounts:[],media:[]},async()=>new Promise(()=>{})));</script></body></html>' }); return;
    }
    const file = resolve('apps/papr/bundle/apps/outreach-console', url.pathname.slice(1)); await route.fulfill({ contentType: extname(file) === '.css' ? 'text/css' : 'application/javascript', body: readFileSync(file) });
  });
  return { pack, preview, calls, blocked, releaseDocument, jobs: () => jobs, complete() {
    jobs = jobs.map((job) => ({ ...job, status: 'completed', revision: job.revision + 1, results: job.actions.map((action) => action.kind === 'compose_email' ? { actionId: action.id, kind: action.kind, status: 'completed', draft: action.email, detail: 'Draft saved inside Carl-Allen.' } : { actionId: action.id, kind: action.kind, status: 'completed', title: 'Project reference', requestedUrl: action.kind === 'open_url' ? action.href : '', httpStatus: 200 }), detail: 'Synthetic worker results returned by the fixture server.' }));
  } };
}
async function upload(page: Page) {
  await page.goto('https://file.test/?appId=fixture'); await page.getByRole('button', { name: 'Upload file', exact: true }).click(); await page.getByLabel('HTML plan or research report').setInputFiles({ name: 'campaign.html', mimeType: 'text/html', buffer: Buffer.from(source) }); await page.getByRole('button', { name: 'Import and check files', exact: true }).click();
  await page.getByRole('heading', { name: 'My campaign file', exact: true }).waitFor();
}
it.skipIf(!enabled)('opens the stored original independently, inspects in-app triggers and schedules only explicit selections', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1050 }, timezoneId: 'America/New_York' }); const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message)); const f = await fixture(page, { delayDocument: true, failCreate: true }); await upload(page);
    expect(await page.getByText('Loading your uploaded document in the background…', { exact: true }).count()).toBe(1); expect(await page.getByRole('button', { name: 'Schedule background job', exact: true }).isDisabled()).toBe(true);
    expect(f.calls.some((call) => call.action === 'document-job-list')).toBe(true); f.releaseDocument();
    const iframe = page.frameLocator('iframe[title="Original document: My campaign file"]'); await iframe.getByRole('heading', { name: 'Research notebook', exact: true }).waitFor();
    expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts'); expect(await page.locator('iframe').getAttribute('referrerpolicy')).toBe('no-referrer'); expect(await page.evaluate('globalThis.sourceExecuted')).toBeUndefined();
    expect(await iframe.locator('body').evaluate(() => { const browser = globalThis as unknown as { parent: { document: { body: unknown } } }; try { return Boolean(browser.parent.document.body); } catch { return 'opaque'; } })).toBe('opaque');
    await iframe.getByText('Project page', { exact: true }).click(); await page.locator('.document-trigger-detail').getByRole('heading', { name: 'Project page', exact: true }).waitFor();
    expect(await page.getByLabel('Include trigger Project page').isChecked()).toBe(false); expect(page.context().pages()).toHaveLength(1); expect(page.url()).toContain('https://file.test/'); expect(await page.locator('.document-workspace a').count()).toBe(0);
    const emailAction = f.preview.actions.find((action) => action.kind === 'compose_email')!;
    await page.evaluate((message) => { const browser = globalThis as unknown as { postMessage(value: unknown, target: string): void }; browser.postMessage(message, '*'); }, { type: 'carl-allen-document-action', sourceHash: f.preview.sourceHash, actionId: emailAction.id });
    expect(await page.getByLabel('Include trigger Email contact').isChecked()).toBe(false);
    await page.getByLabel('Include trigger Project page').check(); await page.getByLabel('Include trigger Email contact').check(); await page.getByRole('button', { name: 'Inspect trigger Email contact', exact: true }).click(); expect(await page.locator('.document-trigger-detail').textContent()).toContain('Subject: Research');
    const unsupported = page.getByLabel('Include trigger Dynamic control'); expect(await unsupported.isDisabled()).toBe(true);
    const artifacts = process.env.OUTREACH_BROWSER_ARTIFACT_DIR || resolve(tmpdir(), 'carl-allen-document-ui'); mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: resolve(artifacts, 'file-workspace-document-desktop.png'), fullPage: false });
    await page.getByRole('button', { name: 'Set up job', exact: true }).click(); expect(await page.locator(':focus').getAttribute('aria-label')).toBe('Job start time'); expect(f.calls.some((call) => call.action === 'document-job-create')).toBe(false);
    const due = model.scheduleInZone(new Date(Date.now() + 24 * 3600000).toISOString(), 'America/New_York'); await page.getByLabel('Job start time', { exact: true }).fill(due); await page.getByRole('button', { name: 'Schedule background job', exact: true }).click();
    await page.getByText('Fixture job storage unavailable', { exact: true }).waitFor(); expect(f.jobs()).toHaveLength(0); expect(await page.locator('.document-job-card').count()).toBe(0);
    await page.getByRole('button', { name: 'Schedule background job', exact: true }).click(); await expect.poll(() => f.jobs().length).toBe(1); await expect.poll(() => page.locator('.document-job-card .badge').textContent()).toBe('Scheduled');
    const attempts = f.calls.filter((call) => call.action === 'document-job-create'); expect((attempts[0]!.params.input as Record<string, unknown>).idempotencyKey).toBe((attempts[1]!.params.input as Record<string, unknown>).idempotencyKey); expect(f.jobs()[0]!.selectedActionIds).toHaveLength(2);
    await page.getByRole('button', { name: 'Pause job', exact: true }).click(); await expect.poll(() => f.jobs()[0]!.status).toBe('paused'); await page.getByRole('button', { name: 'Schedule this job', exact: true }).click(); await expect.poll(() => f.jobs()[0]!.status).toBe('scheduled');
    f.complete(); await page.getByRole('button', { name: 'Refresh jobs', exact: true }).click(); await expect.poll(() => page.locator('.document-job-card .badge').first().textContent()).toBe('Completed'); await page.getByText('Run results · 2', { exact: true }).click();
    expect(await page.getByLabel('Saved email draft', { exact: true }).inputValue()).toBe('Hello Ada'); expect(await page.getByText('Project reference', { exact: true }).count()).toBe(1);
    await page.screenshot({ path: resolve(artifacts, 'file-workspace-desktop.png'), fullPage: false }); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.dialog-body').evaluate((node) => { node.scrollTop = 0; }); expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true); await page.screenshot({ path: resolve(artifacts, 'file-workspace-mobile.png'), fullPage: false });
    expect(f.calls.some((call) => /approve|work-package-prepare|account-|login|outreach-/.test(call.action))).toBe(false); expect(f.blocked).toEqual([]); expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('saves a real undated job draft, then schedules and cancels it using revision-checked updates', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ timezoneId: 'UTC' }); const f = await fixture(page); await upload(page); await page.getByText('Original file open inside Carl-Allen. Uploaded scripts and external resources remain inactive.', { exact: true }).waitFor(); expect(await page.getByRole('button', { name: 'Save job draft', exact: true }).isDisabled()).toBe(true); await page.getByLabel('Include trigger Email contact').check();
    await page.getByRole('button', { name: 'Save job draft', exact: true }).click(); await expect.poll(() => f.jobs().length).toBe(1); expect(f.jobs()[0]).toMatchObject({ status: 'draft', scheduledFor: null });
    await page.getByLabel('Run time for job My campaign file', { exact: true }).fill(model.scheduleInZone(new Date(Date.now() + 48 * 3600000).toISOString(), 'UTC')); await page.getByRole('button', { name: 'Schedule this job', exact: true }).click(); await expect.poll(() => f.jobs()[0]!.status).toBe('scheduled');
    await page.getByRole('button', { name: 'Cancel job', exact: true }).click(); await expect.poll(() => f.jobs()[0]!.status).toBe('cancelled'); expect(f.calls.some((call) => /approve|send|resume/.test(call.action))).toBe(false);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('requires the trusted iframe readiness acknowledgement and offers retry when the bridge is blocked', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(); await page.clock.install(); const f = await fixture(page, { blockFirstBridge: true, savedPausedJob: true }); await upload(page);
    const frame = page.frameLocator('iframe[title="Original document: My campaign file"]'); await frame.getByRole('heading', { name: 'Research notebook', exact: true }).waitFor();
    await page.getByLabel('Include trigger Email contact').check(); await page.locator('iframe').dispatchEvent('load');
    await page.evaluate((sourceHash) => { const browser = globalThis as unknown as { postMessage(value: unknown, target: string): void }; browser.postMessage({ type: 'carl-allen-document-ready', sourceHash }, '*'); }, f.preview.sourceHash);
    await frame.locator('body').evaluate(() => { const browser = globalThis as unknown as { parent: { postMessage(value: unknown, target: string): void } }; browser.parent.postMessage({ type: 'carl-allen-document-ready', sourceHash: 'b'.repeat(64) }, '*'); });
    expect(await page.getByRole('button', { name: 'Schedule background job', exact: true }).isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Save job draft', exact: true }).isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Schedule this job', exact: true }).isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Save job time', exact: true }).isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Cancel job', exact: true }).isEnabled()).toBe(true);
    await page.clock.fastForward(12001); await page.getByText('The file preview did not initialize its trusted controls. Choose Reload file to retry. Scheduling remains unavailable.', { exact: true }).waitFor();
    expect(f.calls.some((call) => call.action === 'document-job-create')).toBe(false); await page.getByRole('button', { name: 'Reload file', exact: true }).click();
    await page.getByText('Original file open inside Carl-Allen. Uploaded scripts and external resources remain inactive.', { exact: true }).waitFor(); expect(await page.getByRole('button', { name: 'Save job draft', exact: true }).isEnabled()).toBe(true); expect(await page.getByRole('button', { name: 'Schedule this job', exact: true }).isEnabled()).toBe(true);
    await page.getByRole('button', { name: 'Close file', exact: true }).click(); await page.clock.fastForward(12001); expect(await page.locator('dialog').count()).toBe(0); expect(f.calls.some((call) => call.action === 'document-job-create')).toBe(false);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('rejects a delayed readiness acknowledgement from the previous same-source iframe after reload', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(); const f = await fixture(page, { blockReloadBridge: true, savedPausedJob: true }); await upload(page);
    await page.getByText('Original file open inside Carl-Allen. Uploaded scripts and external resources remain inactive.', { exact: true }).waitFor();
    await page.getByLabel('Include trigger Email contact').check(); expect(await page.getByRole('button', { name: 'Save job draft', exact: true }).isEnabled()).toBe(true);
    await page.evaluate("globalThis.previousDocumentWindow=document.querySelector('iframe').contentWindow");
    await page.getByRole('button', { name: 'Reload file', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Original document: My campaign file"]'); await frame.getByRole('heading', { name: 'Research notebook', exact: true }).waitFor();
    expect(await page.evaluate("globalThis.previousDocumentWindow===document.querySelector('iframe').contentWindow")).toBe(false);
    await page.evaluate(`dispatchEvent(new MessageEvent('message',{origin:'null',source:globalThis.previousDocumentWindow,data:{type:'carl-allen-document-ready',sourceHash:${JSON.stringify(f.preview.sourceHash)}}}))`);
    expect(await page.getByRole('button', { name: 'Save job draft', exact: true }).isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Schedule background job', exact: true }).isDisabled()).toBe(true); expect(await page.getByRole('button', { name: 'Schedule this job', exact: true }).isDisabled()).toBe(true);
    expect(f.calls.some((call) => call.action === 'document-job-create' || call.action === 'document-job-update')).toBe(false);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('keeps legacy empty frozen drafts unschedulable and requires a fresh selected-trigger job', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(); const f = await fixture(page, { legacyEmptyDraft: true }); await upload(page); await page.getByText('Original file open inside Carl-Allen. Uploaded scripts and external resources remain inactive.', { exact: true }).waitFor();
    const legacy = page.locator('.document-job-card').filter({ hasText: 'Legacy empty draft' }); await legacy.getByText('This saved job has no frozen trigger selection and cannot be scheduled. Select triggers above and create a new job.', { exact: true }).waitFor();
    expect(await legacy.getByRole('button', { name: 'Schedule this job', exact: true }).isDisabled()).toBe(true); expect(await legacy.getByRole('button', { name: 'Save job time', exact: true }).count()).toBe(0); expect(await page.getByRole('button', { name: 'Save job draft', exact: true }).isDisabled()).toBe(true);
    await page.getByLabel('Include trigger Email contact').check(); await page.getByRole('button', { name: 'Save job draft', exact: true }).click(); await expect.poll(() => f.jobs().length).toBe(2); expect(f.jobs().find((job) => job.id === 'legacy-empty')?.selectedActionIds).toEqual([]); expect(f.jobs().find((job) => job.id !== 'legacy-empty')?.selectedActionIds).toHaveLength(1); expect(f.calls.some((call) => call.action === 'document-job-update')).toBe(false);
    await legacy.getByRole('button', { name: 'Cancel job', exact: true }).click(); await expect.poll(() => f.jobs().find((job) => job.id === 'legacy-empty')?.status).toBe('cancelled');
    expect(f.calls.filter((call) => call.action === 'document-job-update').map((call) => call.params.input)).toEqual([{ expectedRevision: 1, cancel: true }]);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('keeps scheduling unavailable when the original file hash does not match the stored upload', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(); const f = await fixture(page, { wrongHash: true }); await upload(page); await page.getByText(/The original file could not open: The stored file could not be matched/).waitFor(); await page.getByLabel('Include trigger Email contact').check(); expect(await page.getByRole('button', { name: 'Schedule background job', exact: true }).isDisabled()).toBe(true); expect(f.calls.some((call) => call.action === 'document-job-create')).toBe(false);
  } finally { await browser.close(); }
}, 90000);
