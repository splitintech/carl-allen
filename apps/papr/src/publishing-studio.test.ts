import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { chromium, type Page } from 'playwright';
import { ulid } from '@splitin/outreach-contracts';
import { STUDIO_VIDEO } from './publishing-fixtures';
type Post = { channel: string; text: string; accountId?: string; mediaIds: string[] };
type Draft = { id: string; name: string; timezone: string; scheduledFor: string; posts: Post[]; status: string; actionIds: string[]; blocked: { channel: string; reason: string }[]; updatedAt: number; createdAt: number };
type Asset = { id: string; name: string; mime: string; size: number; sha256: string; mediaUrl: string; createdAt: number };
type Action = { id: string; kind: string; state: string; channel: string; text: string; dueAt: number; providerAccountId: string; approvalId: string; operationHash: string; mediaIds: string[]; draftId: string; reason: null };
const artifacts = process.env.OUTREACH_BROWSER_ARTIFACT_DIR || resolve(tmpdir(), 'outreach-publishing-ui-artifacts');
const executablePath = process.env.OUTREACH_TEST_CHROME || chromium.executablePath();
async function fixture(page: Page) {
  const names = ['linkedin', 'x', 'instagram', 'tiktok']; const accounts = names.map((channel) => ({ id: ulid(), provider: 'social-browser', externalAccountId: `https://${channel === 'linkedin' ? 'www.linkedin.com/in/' : `${channel}.com/`}${channel === 'tiktok' ? '@' : ''}studio-fixture/`, sender: { name: 'Studio fixture', address: 'fixture@example.invalid' }, health: 'ok', capabilities: { socialPublish: true, socialChannels: [channel], socialMediaTypes: channel === 'tiktok' ? ['video'] : ['image', 'video'], executionPlacement: 'daytona-browser' } }));
  const state = { accounts, drafts: [] as Draft[], media: [] as Asset[], actions: [] as Action[], approvals: [], roles: ['admin'], liveViewUrl: null, sendingStopped: false };
  const uploads = new Map<string, { name: string; mime: string; size: number; chunks: Buffer[] }>(); const bytes = new Map<string, Buffer>(); const calls: { action: string; params: Record<string, unknown> }[] = []; let disconnected = false;
  await page.route('https://studio.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      const { params } = route.request().postDataJSON() as { params: Record<string, unknown> }; const action = url.pathname.split('/').at(-1)!; calls.push({ action, params });
      if (disconnected) { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: false, error: 'Fixture runtime unavailable' }) }) }); return; }
      let data: unknown = {};
      if (action === 'publishing-overview') data = state;
      if (action === 'publishing-upload-start') { const input = params.input as { name: string; mime: string; size: number }; const uploadId = ulid(); uploads.set(uploadId, { ...input, chunks: [] }); data = { uploadId, chunkBytes: 65536 }; }
      if (action === 'publishing-upload-chunk') { const upload = uploads.get(params.uploadId as string)!; const chunk = Buffer.from(params.data as string, 'base64'); expect(chunk.length).toBeLessThanOrEqual(65536); upload.chunks[params.index as number] = chunk; data = { receivedBytes: upload.chunks.reduce((total, entry) => total + entry.length, 0) }; }
      if (action === 'publishing-upload-complete') { const upload = uploads.get(params.uploadId as string)!; const buffer = Buffer.concat(upload.chunks); expect(buffer.length).toBe(upload.size); const sha256 = createHash('sha256').update(buffer).digest('hex'); const asset = { id: ulid(), name: upload.name, mime: upload.mime, size: buffer.length, sha256, mediaUrl: `outreach-media://${sha256}`, createdAt: Date.now() }; state.media.push(asset); bytes.set(asset.id, buffer); data = { asset }; }
      if (action === 'publishing-media-read') { const asset = state.media.find((a) => a.id === params.assetId)!; const offset = Number(params.offset || 0); const length = Number(params.length || 65536); expect(length).toBeLessThanOrEqual(65536); data = { data: bytes.get(asset.id)!.subarray(offset, offset + length).toString('base64'), offset, total: asset.size, mime: asset.mime, name: asset.name }; }
      if (action === 'publishing-draft-save') { const input = params.input as Omit<Draft, 'status' | 'actionIds' | 'updatedAt' | 'createdAt' | 'blocked'>; const draft = { ...input, id: input.id || ulid(), status: 'draft', actionIds: [], blocked: [], updatedAt: Date.now(), createdAt: Date.now() }; state.drafts = [...state.drafts.filter((d) => d.id !== draft.id), draft]; data = { draft }; }
      if (action === 'publishing-submit') { const draft = state.drafts.find((d) => d.id === params.draftId)!; const blocked = draft.posts.filter((p) => !p.accountId).map((p) => ({ channel: p.channel, reason: 'Connect an account first' })); const actions = blocked.length ? [] : draft.posts.map((p) => ({ id: ulid(), kind: 'social.publish', channel: p.channel, text: p.text, mediaIds: p.mediaIds, providerAccountId: p.accountId!, dueAt: Date.parse(draft.scheduledFor), state: 'awaiting_approval', approvalId: ulid(), operationHash: createHash('sha256').update(JSON.stringify(p)).digest('hex'), draftId: draft.id, reason: null })); draft.status = blocked.length ? 'blocked' : 'queued'; draft.actionIds = actions.map((a) => a.id); state.actions.push(...actions); data = { draft, actions, blocked }; }
      if (action === 'approval-decide') { const item = state.actions.find((a) => a.approvalId === params.approvalId)!; expect(params.operationHash).toBe(item.operationHash); item.state = 'scheduled'; data = { approved: true }; }
      if (action === 'kill-switch') { state.sendingStopped = params.engaged === 'true'; data = { stopped: state.sendingStopped }; }
      if (action === 'action-cancel') { state.actions.find((a) => a.id === params.actionId)!.state = 'cancelled'; data = { cancelled: true }; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: true, data }) }) }); return;
    }
    const path = resolve('apps/papr/bundle/apps/outreach-console', url.pathname === '/' ? 'publishing.html' : url.pathname.slice(1));
    await route.fulfill({ contentType: extname(path) === '.html' ? 'text/html' : extname(path) === '.css' ? 'text/css' : 'application/javascript', body: readFileSync(path) });
  });
  return { state, calls, disconnect: () => { disconnected = true; } };
}
async function poster(page: Page) {
  const image = await page.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 720; c.height = 880; const g = c.getContext('2d'); g.fillStyle = '#e2ead7'; g.fillRect(0, 0, 720, 880); g.fillStyle = '#394d2c'; g.fillRect(44, 44, 632, 792); g.strokeStyle = '#91a578'; g.lineWidth = 1; for (let i = 0; i < 12; i++) { g.beginPath(); g.arc(360, 345, 45 + i * 17, 0, Math.PI * 2); g.stroke(); } g.fillStyle = '#edf2de'; g.font = '19px Georgia'; g.fillText('A LITTLE PLANNING GOES A LONG WAY', 88, 108); g.font = 'italic 74px Georgia'; g.fillText('Make room', 84, 585); g.fillText('for what’s next.', 84, 670); g.font = '15px Arial'; g.fillStyle = '#b8c6a7'; g.fillText('STUDIO FIXTURE · NOT A REAL PUBLISHED POST', 88, 780); return c.toDataURL('image/png').split(',')[1]; })()` ) as string;
  return Buffer.from(image, 'base64');
}
async function labelFixture(page: Page) { await page.evaluate(`(() => { const note = document.createElement('div'); note.textContent = 'BROWSER TEST FIXTURE · No real accounts or published posts'; note.style.cssText = 'font:9px sans-serif;letter-spacing:1px;color:#718365;margin-bottom:18px'; document.querySelector('#workspace').prepend(note); })()`); }
it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1')('composes four platform posts with durable uploads, independent captions, review, exact approval and cancellation', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 90000 }); mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000); const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message)); const f = await fixture(page); await page.goto('https://studio.test/publishing.html?appId=assigned-studio');
    await expect.poll(() => page.locator('#runtime-state').textContent()).toBe('Workspace connected'); expect(await page.locator('.old-console').getAttribute('href')).toContain('appId=assigned-studio');
    await page.getByRole('button', { name: 'Create a post', exact: true }).first().click(); await page.getByLabel('Working title').fill('Make room for what is next'); await page.getByLabel('Caption', { exact: true }).fill('A little planning makes space for good work.');
    const png = await poster(page); await page.locator('input[type=file]').setInputFiles({ name: 'launch-poster.png', mimeType: 'image/png', buffer: png }); await expect.poll(() => f.state.media.length).toBe(1); await expect.poll(() => page.getByRole('button', { name: 'Review & schedule' }).isEnabled()).toBe(true);
    await page.getByRole('checkbox', { name: 'Publish to X', exact: true }).check(); await page.getByLabel('Caption', { exact: true }).fill('Make room for your next good idea.');
    await page.getByRole('checkbox', { name: 'Publish to Instagram', exact: true }).check(); await page.getByLabel('Caption', { exact: true }).fill('A fresh chapter, in good company. #StudioFixture');
    await page.getByRole('checkbox', { name: 'Publish to TikTok', exact: true }).check(); await page.getByRole('button', { name: 'Remove launch-poster.png', exact: true }).click(); await page.getByLabel('Caption', { exact: true }).fill('A small moment of planning. A little more possibility.');
    await page.locator('input[type=file]').setInputFiles({ name: 'launch-film.mp4', mimeType: 'video/mp4', buffer: STUDIO_VIDEO }); await expect.poll(() => f.state.media.length).toBe(2); await expect.poll(() => page.getByRole('button', { name: 'Review & schedule' }).isEnabled()).toBe(true);
    await page.getByRole('tab', { name: 'LinkedIn', exact: true }).click(); await labelFixture(page); await page.screenshot({ path: resolve(artifacts, 'publishing-composer-desktop.png'), fullPage: false });
    await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect.poll(() => f.state.drafts.length).toBe(1); expect(f.state.drafts[0]!.posts).toHaveLength(4); expect(f.state.drafts[0]!.posts.map((p) => p.text)).toEqual(['A little planning makes space for good work.', 'Make room for your next good idea.', 'A fresh chapter, in good company. #StudioFixture', 'A small moment of planning. A little more possibility.']);
    await page.reload(); await expect.poll(() => page.locator('#runtime-state').textContent()).toBe('Workspace connected'); await page.getByRole('button', { name: /^Drafts/ }).click(); await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
    await expect.poll(() => f.calls.filter((c) => c.action === 'publishing-media-read').length).toBeGreaterThan(0); await page.getByRole('button', { name: 'Review & schedule', exact: true }).click(); await expect.poll(() => page.getByRole('heading', { name: 'One last look before it goes out' }).count()).toBe(1); expect(await page.locator('.review-entry').count()).toBe(4);
    await page.getByRole('button', { name: 'Submit for approval', exact: true }).click(); await expect.poll(() => f.state.actions.length).toBe(4); expect(f.state.actions.every((a) => a.state === 'awaiting_approval')).toBe(true);
    await page.getByRole('button', { name: 'Publishing queue', exact: true }).click(); await page.getByRole('button', { name: 'Review & approve', exact: true }).first().click(); await page.getByRole('button', { name: 'Approve this exact post', exact: true }).click(); await expect.poll(() => f.state.actions.filter((a) => a.state === 'scheduled').length).toBe(1);
    await page.getByRole('button', { name: 'View details', exact: true }).first().click(); await page.getByRole('button', { name: 'Cancel this post', exact: true }).click(); await expect.poll(() => f.state.actions.filter((a) => a.state === 'cancelled').length).toBe(1);
    await page.getByRole('button', { name: 'Calendar', exact: true }).click(); await labelFixture(page); await page.screenshot({ path: resolve(artifacts, 'publishing-calendar-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: /^Drafts/ }).click(); await page.getByRole('button', { name: 'Edit draft', exact: true }).click(); await page.screenshot({ path: resolve(artifacts, 'publishing-composer-mobile.png'), fullPage: false });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true); await page.keyboard.press('Escape'); expect(await page.locator('dialog').count()).toBe(0); expect(errors).toEqual([]); expect(f.calls.some((c) => c.action === 'email-send')).toBe(false);
  } finally { await browser.close(); }
}, 180000);
it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1')('keeps unsupported content editable and accurately reports lost connectivity', async () => {
  const browser = await chromium.launch({ executablePath, headless: true, timeout: 90000 });
  try { const page = await browser.newPage(); const f = await fixture(page); await page.goto('https://studio.test/publishing.html'); await expect.poll(() => page.locator('#runtime-state').textContent()).toBe('Workspace connected');
    await page.getByRole('button', { name: 'Stop all sending', exact: true }).click(); await page.getByRole('button', { name: 'Keep sending', exact: true }).click(); expect(f.calls.filter((c) => c.action === 'kill-switch')).toHaveLength(0);
    await page.getByRole('button', { name: 'Stop all sending', exact: true }).click(); await page.locator('dialog').getByRole('button', { name: 'Stop all sending', exact: true }).click(); await expect.poll(() => f.calls.filter((c) => c.action === 'kill-switch').length).toBe(1);
    await page.reload(); await expect.poll(() => page.locator('#sending-banner').textContent()).toContain('Workspace sending is paused'); await expect.poll(() => page.getByRole('button', { name: 'Resume sending', exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: 'Resume sending', exact: true }).click(); await page.getByRole('button', { name: 'Keep paused', exact: true }).click(); expect(f.calls.filter((c) => c.action === 'kill-switch')).toHaveLength(1);
    await page.getByRole('button', { name: 'Resume sending', exact: true }).click(); await page.locator('dialog').getByRole('button', { name: 'Resume sending', exact: true }).click(); await expect.poll(() => f.state.sendingStopped).toBe(false);
    await page.getByRole('button', { name: 'Accounts', exact: true }).click(); const xCard = page.locator('.account-card').filter({ has: page.getByRole('heading', { name: 'X', exact: true }) }); await xCard.getByRole('button', { name: 'Add another account', exact: true }).click();
    await page.getByLabel('Your X profile URL').fill('https://www.linkedin.com/in/wrong-platform/'); await page.getByLabel('Your name', { exact: true }).fill('Owner'); await page.getByLabel('Account email', { exact: true }).fill('owner@example.invalid'); await page.getByRole('button', { name: 'Create browser connection', exact: true }).click();
    await expect.poll(() => page.locator('#studio-toast').textContent()).toContain('Enter your own X profile URL'); expect(f.calls.filter((c) => c.action === 'account-register')).toHaveLength(0); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Create a post', exact: true }).first().click(); await page.getByLabel('Working title').fill('Needs a little more work'); await page.getByRole('checkbox', { name: 'Publish to TikTok', exact: true }).check(); await page.getByRole('checkbox', { name: 'Publish to LinkedIn', exact: true }).uncheck(); await page.getByLabel('Caption', { exact: true }).fill('This cannot publish without a video.');
    await page.getByRole('button', { name: 'Review & schedule', exact: true }).click(); await expect.poll(() => page.locator('.validation-errors').textContent()).toContain('TikTok requires exactly one video'); expect(f.calls.filter((c) => c.action === 'publishing-submit')).toHaveLength(0);
    await page.getByRole('button', { name: 'Save draft', exact: true }).click(); await expect.poll(() => f.state.drafts.length).toBe(1); f.disconnect(); await page.getByRole('button', { name: 'Refresh workspace', exact: true }).click();
    await expect.poll(() => page.locator('#connection-banner').textContent()).toContain('existing approved schedules may continue in Daytona'); expect(f.state.drafts).toHaveLength(1);
  } finally { await browser.close(); }
}, 120000);
