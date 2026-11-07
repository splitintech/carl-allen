import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
const enabled = process.env.OUTREACH_BROWSER_FIXTURES === '1';
const executablePath = process.env.OUTREACH_TEST_CHROME || chromium.executablePath();
const artifacts = process.env.OUTREACH_BROWSER_ARTIFACT_DIR || resolve(tmpdir(), 'carl-allen-cloud-ui');
const account = (id: string, name: string) => ({ id, provider: 'social-browser', externalAccountId: `https://www.linkedin.com/in/${id}/`, sender: { name, address: `${id}@example.invalid` }, health: 'ok', capabilities: { socialPublish: true, socialChannels: ['linkedin'], socialMediaTypes: ['image', 'video'], executionPlacement: 'daytona-browser' } });
const manifest = () => ({ schemaVersion: 1, packageId: 'november-plan', revision: 1, name: 'November plan', timezone: 'America/New_York', accountRefs: [{ id: 'owner', channel: 'linkedin', label: 'Founder account' }], contacts: [], media: [], publishingPlans: [{ id: 'post-1', accountRef: 'owner', channel: 'linkedin', text: 'Reviewed content for next month.', media: [], scheduledFor: new Date(Date.now() + 20 * 86400000).toISOString(), format: 'feed', tags: ['launch'] }], outreachSequences: [], replyPlaybooks: [] });
async function fixture(page: Page, arbitrary = false) {
  const accounts = [account('founder', 'Founder'), account('company-owner', 'Company owner')];
  const state = { accounts, drafts: [] as Record<string, unknown>[], media: [], actions: [], approvals: [], roles: ['admin'], sendingStopped: false, liveViewUrl: null };
  const pack: Record<string, unknown> = { id: 'package-1', name: 'November research', revision: 1, status: arbitrary ? 'needs_repair' : 'ready_for_review', manifest: arbitrary ? null : manifest(), issues: arbitrary ? [{ field: 'manifest', message: 'Map this research into a manifest' }] : [], accountMap: {}, mediaMap: {}, cloudReceipt: { accepted: false, placement: 'local' }, extractedTables: arbitrary ? [[{ Name: 'Ada Research', Email: 'ada@example.invalid', Source: 'https://example.invalid/ada' }]] : [] };
  const calls: { action: string; params: Record<string, unknown> }[] = []; const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url()); if (url.origin !== 'https://studio.test') { blocked.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/app/backend/')) {
      const { params } = route.request().postDataJSON() as { params: Record<string, unknown> }; const action = url.pathname.split('/').at(-1)!; calls.push({ action, params }); let data: unknown = {};
      if (action === 'publishing-overview') data = state;
      if (action === 'work-packages-list') data = { packages: calls.some((c) => c.action === 'work-package-import') ? [pack] : [] };
      if (action === 'work-package-import' || action === 'work-package-get') data = { package: pack };
      if (action === 'work-package-repair') { const input = params.input as Record<string, unknown>; Object.assign(pack, input); pack.status = 'ready_for_review'; pack.issues = []; data = { package: pack }; }
      if (action === 'work-package-prepare') { pack.status = 'awaiting_approval'; pack.authorizationId = 'authorization-1'; pack.operationHash = 'a'.repeat(64); const value = pack.manifest as ReturnType<typeof manifest>; data = { package: pack, authorizationId: pack.authorizationId, operationHash: pack.operationHash, preview: { posts: value.publishingPlans, contacts: value.contacts, sequences: [], replyPlaybooks: [], issues: [] } }; }
      if (action === 'plan-approve') { expect(params.authorizationId).toBe('authorization-1'); expect(params.operationHash).toBe('a'.repeat(64)); pack.status = 'scheduled'; data = { approved: true, actionIds: ['publication-1'] }; }
      if (action === 'publishing-draft-save') { const draft = { ...(params.input as Record<string, unknown>), id: 'draft-1', actionIds: [], status: 'draft' }; state.drafts = [draft]; data = { draft }; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: true, data }) }) }); return;
    }
    const path = resolve('apps/papr/bundle/apps/outreach-console', url.pathname === '/' ? 'publishing.html' : url.pathname.slice(1)); const mime = extname(path) === '.html' ? 'text/html' : extname(path) === '.css' ? 'text/css' : 'application/javascript';
    await route.fulfill({ contentType: mime, body: readFileSync(path) });
  });
  return { state, pack, calls, blocked };
}
it.skipIf(!enabled)('imports an inert HTML handoff, maps an account and approves the exact complete plan', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 90000 }); mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const f = await fixture(page); await page.goto('https://studio.test/publishing.html'); await expect.poll(() => page.locator('#runtime-state').textContent()).toBe('Workspace connected');
    await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByRole('button', { name: 'Import HTML & media', exact: true }).first().click();
    await page.getByLabel('HTML plan or research report').setInputFiles({ name: 'monthly-plan.html', mimeType: 'text/html', buffer: Buffer.from('<script>globalThis.uploadExecuted=true</script><img src="https://tracker.invalid/pixel"><script type="application/json" id="carl-allen-manifest">' + JSON.stringify(manifest()) + '</script>') });
    await page.getByRole('button', { name: 'Import and check files', exact: true }).click(); await page.getByLabel('Map account Founder account').selectOption('founder'); expect(await page.evaluate('globalThis.uploadExecuted')).toBeUndefined(); expect(f.blocked).toEqual([]);
    expect(await page.getByText('This receipt is local.', { exact: false }).count()).toBe(1); await page.getByRole('button', { name: 'Prepare exact plan', exact: true }).click();
    await expect.poll(() => page.getByRole('heading', { name: 'Approve the exact plan' }).count()).toBe(1); await expect.poll(() => page.getByText('Reviewed content for next month.', { exact: true }).count()).toBe(1);
    expect(f.calls.filter((c) => c.action === 'plan-approve')).toHaveLength(0); await page.screenshot({ path: resolve(artifacts, 'html-handoff-review-desktop.png') });
    await page.getByRole('button', { name: 'Approve this exact plan', exact: true }).click(); expect(f.pack.status).toBe('scheduled'); expect(f.calls.filter((c) => c.action === 'plan-approve')).toHaveLength(1); expect(f.calls.some((c) => /send|execute/.test(c.action))).toBe(false);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('repairs research columns and preserves two different LinkedIn target captions', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 90000 });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const f = await fixture(page, true); await page.goto('https://studio.test/publishing.html'); await expect.poll(() => page.locator('#runtime-state').textContent()).toBe('Workspace connected');
    await page.getByRole('button', { name: 'Create', exact: true }).click(); await page.getByRole('button', { name: 'Import HTML & media', exact: true }).first().click(); await page.getByLabel('HTML plan or research report').setInputFiles({ name: 'research.html', mimeType: 'text/html', buffer: Buffer.from('<table><tr><th>Name</th><th>Email</th><th>Source</th></tr><tr><td>Ada Research</td><td>ada@example.invalid</td><td>https://example.invalid/ada</td></tr></table>') }); await page.getByRole('button', { name: 'Import and check files', exact: true }).click();
    await page.getByRole('button', { name: 'Map these contacts', exact: true }).click(); await expect.poll(()=>f.pack.manifest).not.toBeNull(); const value = f.pack.manifest as { contacts: { name: string; email: string; sources: string[] }[] }; expect(value.contacts).toEqual([{ id: 'contact-1', name: 'Ada Research', email: 'ada@example.invalid', sources: ['https://example.invalid/ada'], notes: '', consentBasis: 'unknown', jurisdiction: 'unknown' }]); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Create a post', exact: true }).first().click(); await page.getByLabel('Working title').fill('Two LinkedIn targets'); await page.getByLabel('Caption', { exact: true }).fill('Founder caption'); await page.getByRole('button', { name: '＋ Accounts', exact: true }).click(); await page.getByRole('checkbox', { name: 'Use LinkedIn account Company owner', exact: true }).check(); await page.getByRole('button', { name: 'Use selected accounts', exact: true }).click(); await page.getByRole('tab', { name: 'LinkedIn · Company owner', exact: true }).click(); await page.getByLabel('Caption', { exact: true }).fill('Company caption'); await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    const posts = f.state.drafts[0]!.posts as { targetId: string; channel: string; accountId: string; text: string }[]; expect(posts).toHaveLength(2); expect(new Set(posts.map((post) => post.targetId)).size).toBe(2); expect(posts.map((post) => [post.channel, post.accountId, post.text])).toEqual([['linkedin', 'founder', 'Founder caption'], ['linkedin', 'company-owner', 'Company caption']]);
    await page.getByRole('button', { name: 'Calendar', exact: true }).click(); await page.screenshot({ path: resolve(artifacts, 'carl-allen-calendar-desktop.png') }); await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('uses the hosted session CSRF contract without exposing a bearer token to the page', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 90000 });
  try {
    const page = await browser.newPage(); const requests: { path: string; method: string; csrf?: string; authorization?: string }[] = []; const saved: Record<string, unknown>[] = [];
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()); expect(url.origin).toBe('https://carl-allen.splitin.net');
      if (url.pathname === '/auth/session') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: true, csrf: 'test-csrf', workspaceId: 'workspace-1' }) });
      if (url.pathname.startsWith('/api/v1/')) {
        const headers = route.request().headers(); requests.push({ path: url.pathname, method: route.request().method(), csrf: headers['x-carl-csrf'], authorization: headers.authorization }); let data: unknown = {};
        if (url.pathname === '/api/v1/publishing') data = { accounts: [account('founder', 'Founder')], roles: ['admin'], drafts: saved, actions: [], media: [], approvals: [] };
        if (url.pathname === '/api/v1/publishing/drafts' && route.request().method() === 'POST') { const value = route.request().postDataJSON() as Record<string, unknown>; const draft = { ...value, id: 'draft-1', actionIds: [], status: 'draft' }; saved.push(draft); data = { draft }; }
        if (url.pathname === '/api/v1/publishing/drafts' && route.request().method() === 'GET') data = { drafts: saved };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }); return;
      }
      const path = resolve('apps/papr/bundle/apps/outreach-console', url.pathname === '/' ? 'publishing.html' : url.pathname.slice(1)); await route.fulfill({ contentType: extname(path) === '.html' ? 'text/html' : extname(path) === '.css' ? 'text/css' : 'application/javascript', body: readFileSync(path) });
    });
    await page.goto('https://carl-allen.splitin.net/'); await expect.poll(() => page.locator('#runtime-state').textContent()).toBe('Workspace connected'); await page.getByRole('button', { name: 'Create a post', exact: true }).click(); await page.getByLabel('Working title').fill('Hosted draft'); await page.getByLabel('Caption', { exact: true }).fill('Kept private until approval.'); await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect.poll(() => saved.length).toBe(1);
    expect(requests.filter((request) => request.method === 'POST')).toEqual([{ path: '/api/v1/publishing/drafts', method: 'POST', csrf: 'test-csrf', authorization: undefined }]); expect(requests.some((request) => request.authorization)).toBe(false); expect(await page.evaluate('localStorage.length')).toBe(0);
  } finally { await browser.close(); }
}, 90000);
it.skipIf(!enabled)('saves an undated tagged draft, filters it, then drags a dated draft into reviewable edits',async()=>{
 const browser=await chromium.launch({executablePath,headless:true,timeout:90000});
 try{const page=await browser.newPage({viewport:{width:1440,height:1000}});const f=await fixture(page);await page.goto('https://studio.test/publishing.html');await expect.poll(()=>page.locator('#runtime-state').textContent()).toBe('Workspace connected');await page.getByRole('button',{name:'Create a post',exact:true}).click();await page.getByLabel('Working title').fill('Undated launch');await page.getByLabel('Caption',{exact:true}).fill('A private tagged draft');await page.getByLabel('Date & time',{exact:true}).fill('');await page.getByText('Account-specific options',{exact:true}).click();await page.getByLabel('Tags',{exact:true}).fill('launch, november');await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>f.state.drafts.length).toBe(1);expect(f.state.drafts[0]?.scheduledFor).toBe('');expect((f.state.drafts[0]?.posts as {tags:string[]}[])[0]?.tags).toEqual(['launch','november']);await page.getByLabel('Filter by tag').fill('launch');await page.getByLabel('Filter by tag').press('Tab');await expect.poll(()=>page.getByText('No date · 1 drafts',{exact:true}).count()).toBe(1);
 const draft=f.state.drafts[0]!;draft.scheduledFor=new Date(Date.now()+86400000).toISOString();await page.reload();await expect.poll(()=>page.locator('.calendar-post[draggable=true]').count()).toBe(1);const source=page.locator('.calendar-post[draggable=true]').first();const destination=page.locator('.calendar-cell:not(.other)').last();const targetDay=await destination.locator('time').getAttribute('datetime');const transfer=await page.evaluateHandle('new DataTransfer()');await source.dispatchEvent('dragstart',{dataTransfer:transfer});await destination.dispatchEvent('drop',{dataTransfer:transfer});await expect.poll(()=>page.getByRole('heading',{name:'Edit post',exact:true}).count()).toBe(1);await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect.poll(()=>((f.state.drafts[0]?.posts as {scheduledFor?:string}[])[0]?.scheduledFor||'').slice(0,10)).toBe(targetDay);expect(f.calls.some(c=>c.action==='plan-approve')).toBe(false);
 }finally{await browser.close();}
},90000);
