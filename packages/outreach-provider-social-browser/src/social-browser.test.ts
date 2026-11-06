import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { digestCanonical } from '@splitin/outreach-contracts';
import type { ProviderContext } from '@splitin/outreach-contracts';
import { socialBrowserAdapter, createSocialSession, type BrowserRecipe } from './index';

describe.runIf(process.env.OUTREACH_BROWSER_FIXTURES === '1')('local Chromium acceptance', () => {
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const executable = process.env.OUTREACH_TEST_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);
const sender = 'https://www.linkedin.com/in/operator';
let origin: string;
let server: Server;
let browser: Browser;
let context: BrowserContext;
let adapter: ReturnType<typeof socialBrowserAdapter>;
let mode = 'ok';
let actor = sender;
let recipient = 'https://www.linkedin.com/in/recipient';
let effects: string[] = [];
function ctx(signal = AbortSignal.timeout(90_000)): ProviderContext {
  return { workspaceId: 'ws', account: { id: 'a1', provider: 'social-browser', externalAccountId: 'li-1', sender: { name: 'Ops', address: 'ops@example.com' } }, secretRef: 'env:SOCIAL', secrets: { get: async () => '' }, traceId: 't', signal, now: () => 1_700_000_000_000 };
}
function fixture(): string {
  return `<div class="profile-card"><a href="${actor}">My account</a></div>
  <input type="file" accept="image/*,video/*" multiple onchange="for(const f of this.files){const i=document.createElement(f.type.startsWith('video/')?'video':'img');if(f.type.startsWith('video/'))i.setAttribute('data-test-video-ready','true');i.setAttribute('data-test-media-preview','true');const r=new FileReader();r.onload=()=>{i.src=r.result;document.body.append(i);};r.readAsDataURL(f);}"><span id="identity">operator</span><input id="recipe-input"><div class="ql-editor" contenteditable="true" role="textbox"></div>
  <button class="share-box-feed-entry__trigger">Start a post</button><button class="share-actions__primary-action" onclick="perform('post')">Post</button>
  <button>Message</button><a class="msg-thread__link-to-profile" href="${recipient}">Conversation recipient</a><button class="msg-form__send-button" onclick="perform('message')">Send</button>
  <button>Connect</button><div role="dialog"><button>Add a note</button><textarea name="message"></textarea>
  <button onclick="invite()">Send without a note</button><button onclick="invite()">Send</button></div>
  <button id="recipe-effect" onclick="perform('recipe')">Run recipe</button>
  <script>
  async function perform(kind) {
    const count=document.querySelector('input[type=file]').files.length;
    await fetch('/effect/'+kind+(count?'?media='+count:''),{method:'POST'});
    if (${JSON.stringify(mode)} === 'ambiguous') return;
    const n=document.createElement(kind==='post'?'article':'div');
    if(kind==='post') n.setAttribute('data-urn','urn:li:activity:fixture');
    if(kind==='message'){n.className='msg-s-event-listitem';n.setAttribute(${JSON.stringify(mode)}==='message-id'?'data-message-id':'data-event-urn','urn:li:message:fixture');}
    if(kind==='recipe'){n.id='receipt';n.setAttribute('data-id','fixture:recipe:123');}
    n.textContent=kind==='recipe'?document.querySelector('#recipe-input').value:document.querySelector('.ql-editor').textContent;document.body.append(n);
  }
  async function invite(){await fetch('/relationships/invitations',{method:'POST'});}
  </script>`;
}
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/image.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64')); return; }
    if (req.url?.startsWith('/effect/')) { effects.push(req.url); res.end('ok'); return; }
    if (req.url === '/relationships/invitations') { effects.push('connect'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: { entityUrn: 'urn:li:invitation:fixture' } })); return; }
    if (mode === 'checkpoint' && req.url === '/feed/') { res.writeHead(302, { location: '/checkpoint/challenge' }); res.end(); return; }
    res.setHeader('content-type', 'text/html'); res.end(fixture());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, timeout: 90_000, ...(executable ? { executablePath: executable } : {}) });
}, 120_000);
async function settleCleanup(action: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([action, new Promise<void>((resolve) => { timer = setTimeout(resolve, 15_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
afterAll(async () => {
  await settleCleanup(browser?.close() ?? Promise.resolve());
  server?.closeAllConnections();
  await settleCleanup(new Promise<void>((resolve) => server?.close(() => resolve())));
});
beforeEach(async () => {
  mode = 'ok'; actor = sender; recipient = 'https://www.linkedin.com/in/recipient'; effects = [];
  context = await browser.newContext();
  adapter = socialBrowserAdapter({ runtime: { kind: 'fixture', sandboxId: 'safe-fixture' }, origin, confirmationTimeoutMs: 10_000, accountBindings: { 'li-1': { expectedProfileUrl: sender, pageFactory: () => context.newPage() } } });
});
afterEach(async () => { await settleCleanup(adapter?.close() ?? Promise.resolve()); await settleCleanup(context?.close() ?? Promise.resolve()); });

describe('social browser with real Chromium against a local fixture', () => {
  it('requires attested Daytona placement and a bound identity', async () => {
    const production = socialBrowserAdapter({ runtime: { kind: 'daytona', sandboxId: 'unattested' }, accountBindings: {} });
    await expect(production.account.discover(ctx())).rejects.toThrow(/Linux|DAYTONA/);
    const unbound = socialBrowserAdapter({ runtime: { kind: 'fixture', sandboxId: 'fixture' }, origin, accountBindings: {} });
    await expect(unbound.account.discover(ctx())).rejects.toThrow(/binding/);
  });
  it('discovers supported actions and verifies actual signed-in identity', async () => {
    expect(await adapter.account.discover(ctx())).toMatchObject({ socialPublish: true, socialMessage: true, socialConnect: true, browserTasks: false });
    const health = await adapter.social!.health(ctx());
    expect(health, JSON.stringify(health)).toMatchObject({ status: 'ok', reconnectNeeded: false });
  });
  it('publishes only with a new native receipt', async () => {
    const result = await adapter.social!.publish(ctx(), { actionId: 'a', idempotencyKey: 'k', channel: 'linkedin', text: 'Hello fixture' });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'urn:li:activity:fixture' } });
    expect(effects).toEqual(['/effect/post']);
  });
  it('sends a DM with a native message identifier', async () => {
    const result = await adapter.social!.message(ctx(), { actionId: 'm', idempotencyKey: 'm', channel: 'linkedin', targetUrl: 'https://www.linkedin.com/in/recipient', text: 'Hello recipient' });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'urn:li:message:fixture' } });
  });
  it('confirms a first message in an empty conversation using data-message-id', async () => {
    mode = 'message-id';
    const result = await adapter.social!.message(ctx(), { actionId: 'first-dm', idempotencyKey: 'first-dm', channel: 'linkedin', targetUrl: 'https://www.linkedin.com/in/recipient', text: 'First conversation message' });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'urn:li:message:fixture' } });
    expect(effects).toEqual(['/effect/message']);
  });
  it('refuses a conversation with a different recipient before sending', async () => {
    recipient = 'https://www.linkedin.com/in/someone-else';
    const result = await adapter.social!.message(ctx(), { actionId: 'wrong-target', idempotencyKey: 'wrong-target', channel: 'linkedin', targetUrl: 'https://www.linkedin.com/in/recipient', text: 'must not send' });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(effects).toEqual([]);
  });
  it('sends a connection invitation and extracts its native response receipt', async () => {
    const result = await adapter.social!.connect!(ctx(), { actionId: 'c', idempotencyKey: 'c', channel: 'linkedin', targetUrl: 'https://www.linkedin.com/in/recipient' });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'urn:li:invitation:fixture' } });
    expect(effects).toEqual(['connect']);
  });
  it('holds a wrong sender before any effect', async () => {
    actor = 'https://www.linkedin.com/in/somebody-else';
    expect(await adapter.social!.publish(ctx(), { actionId: 'a', idempotencyKey: 'k', channel: 'linkedin', text: 'no' })).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
    expect(effects).toEqual([]);
  });
  it('pauses checkpoints for human reconnect', async () => {
    mode = 'checkpoint';
    expect(await adapter.social!.health(ctx())).toMatchObject({ status: 'reauth_required', reconnectNeeded: true });
    expect(effects).toEqual([]);
  });
  it('does not mark an unconfirmed click as sent', async () => {
    mode = 'ambiguous';
    expect(await adapter.social!.publish(ctx(), { actionId: 'a', idempotencyKey: 'k', channel: 'linkedin', text: 'uncertain' })).toMatchObject({ kind: 'unknown' });
    expect(effects).toEqual(['/effect/post']);
  });
  it('rejects media without silently posting text only', async () => {
    expect(await adapter.social!.publish(ctx(), { actionId: 'a', idempotencyKey: 'k', channel: 'linkedin', text: 'no', mediaUrls: ['https://example.com/pic.png'] })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(effects).toEqual([]);
  });
  it('uploads approved image bytes and confirms the image preview before posting', async () => {
    const browserErrors: string[] = [];
    const images = socialBrowserAdapter({ runtime: { kind: 'fixture', sandboxId: 'fixture' }, origin, confirmationTimeoutMs: 10_000, accountBindings: { 'li-1': { expectedProfileUrl: sender, pageFactory: async () => { const page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(error.message)); return page; } } }, media: { allowedOrigins: [origin] } });
    try {
      const result = await images.social!.publish(ctx(), { actionId: 'image', idempotencyKey: 'image', channel: 'linkedin', text: 'Attached image', mediaUrls: [`${origin}/image.png`] });
      if (result.kind !== 'accepted') {
        const page = context.pages().at(-1);
        console.log('Image fixture diagnostics', JSON.stringify({ browserErrors, html: await page?.content() }));
      }
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'urn:li:activity:fixture' } });
      expect(effects).toEqual(['/effect/post?media=1']);
    } finally { await images.close(); }
  });
  it('uploads immutable video bytes and confirms LinkedIn media before posting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outreach-linkedin-video-'));
    const workspace = createHash('sha256').update('ws').digest('hex').slice(0, 24);
    const bytes = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await mkdir(join(dir, workspace), { mode: 0o700 }); await writeFile(join(dir, workspace, hash), bytes, { mode: 0o600 });
    const videos = socialBrowserAdapter({runtime:{kind:'fixture',sandboxId:'fixture'},origin,confirmationTimeoutMs:10000,media:{allowedOrigins:[],assetDirectory:dir},accountBindings:{'li-1':{expectedProfileUrl:sender,pageFactory:()=>context.newPage()}}});
    try {
      expect(await videos.social!.publish(ctx(), {actionId:'video',idempotencyKey:'video',channel:'linkedin',text:'Approved video',mediaUrls:[`outreach-media://${hash}`]})).toMatchObject({kind:'accepted',receipt:{providerMessageId:'urn:li:activity:fixture'}});
      expect(effects).toEqual(['/effect/post?media=1']);
    } finally {await videos.close();await rm(dir,{recursive:true,force:true});}
  });
  it('rejects non-LinkedIn message targets before navigation', async () => {
    expect(await adapter.social!.message(ctx(), { actionId: 'm', idempotencyKey: 'm', channel: 'linkedin', targetUrl: 'http://127.0.0.1/private', text: 'no' })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(effects).toEqual([]);
  });
  it('honors cancellation before the effect', async () => {
    const abort = new AbortController(); abort.abort();
    expect(await adapter.social!.publish(ctx(abort.signal), { actionId: 'a', idempotencyKey: 'k', channel: 'linkedin', text: 'no' })).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
    expect(effects).toEqual([]);
  });
  it('maps a disconnected browser context to reconnect-required', async () => {
    await context.close();
    expect(await adapter.social!.health(ctx())).toMatchObject({ status: 'reauth_required', reconnectNeeded: true });
  });
});

it('persists a signed-in fixture cookie across persistent Chromium restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outreach-profile-'));
  const options = { userDataDir: dir, launchTimeoutMs: 90_000, ...(executable ? { executablePath: executable } : {}) };
  let session = createSocialSession(options);
  try {
    await session.withPage(ctx().signal, async (page) => { await page.goto(origin); await page.context().addCookies([{ name: 'session', value: 'signed-in', url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }]); });
    await session.close(); session = createSocialSession(options);
    const cookies = await session.withPage(ctx().signal, async (page) => { await page.goto(origin); return page.context().cookies(); });
    expect(cookies.find((cookie) => cookie.name === 'session')?.value).toBe('signed-in');
  } finally { await session.close(); await rm(dir, { recursive: true, force: true }); }
}, 240_000);

it('checks a recipe-only signed-in browser account without requiring LinkedIn or causing an effect', async () => {
  const recipe: BrowserRecipe = { id: 'mail-draft', allowedOrigins: [origin], parameters: { text: { maxLength: 100 } }, steps: [{ type: 'goto', url: `${origin}/mail/` }, { type: 'fill', selector: '#recipe-input', parameter: 'text' }, { type: 'click', selector: '#recipe-effect', effect: true }], confirmation: { selector: '#receipt', attribute: 'data-id' } };
  const generic = socialBrowserAdapter({ runtime: { kind: 'fixture', sandboxId: 'fixture' }, origin, accountBindings: { 'li-1': { kind: 'browser', pageFactory: () => context.newPage(), recipeIdentities: { 'mail-draft': { selector: '#identity', expected: 'operator' } } } }, recipes: [recipe] });
  try {
    actor = 'https://www.linkedin.com/in/not-signed-into-linkedin';
    expect(await generic.account.discover(ctx())).toMatchObject({ socialPublish: false, socialMessage: false, socialConnect: false, socialChannels: [], browserTasks: true });
    expect(await generic.account.health(ctx())).toMatchObject({ status: 'ok' });
    expect(effects).toEqual([]);
    expect(await generic.social!.publish(ctx(), { actionId: 'no-social', idempotencyKey: 'no-social', channel: 'linkedin', text: 'must not send' })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(effects).toEqual([]);
    expect(await generic.browser!.run(ctx(), { actionId: 'mail', idempotencyKey: 'mail', recipeId: recipe.id, recipeHash: digestCanonical(recipe), input: { text: 'local draft' } })).toMatchObject({ kind: 'accepted' });
    expect(effects).toEqual(['/effect/recipe']);
  } finally { await generic.close(); }
});
it('executes configured browser recipes with identity/origin/input and receipt gates', async () => {
  const recipe: BrowserRecipe = { id: 'trusted-post', allowedOrigins: [origin], parameters: { text: { maxLength: 100 } }, steps: [{ type: 'goto', url: `${origin}/feed/` }, { type: 'fill', selector: '#recipe-input', parameter: 'text' }, { type: 'click', selector: '#recipe-effect', effect: true }], confirmation: { selector: '#receipt', attribute: 'data-id' } };
  const recipes = socialBrowserAdapter({ runtime: { kind: 'fixture', sandboxId: 'fixture' }, origin, accountBindings: { 'li-1': { expectedProfileUrl: sender, pageFactory: () => context.newPage(), recipeIdentities: { 'trusted-post': { selector: '#identity', expected: 'operator' } } } }, recipes: [recipe] });
  try {
    expect(await recipes.browser!.run(ctx(), { actionId: 'b', idempotencyKey: 'b', recipeId: recipe.id, recipeHash: digestCanonical(recipe), input: { text: 'safe text' } })).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: 'fixture:recipe:123' } });
    expect(await recipes.browser!.run(ctx(), { actionId: 'c', idempotencyKey: 'c', recipeId: recipe.id, recipeHash: digestCanonical(recipe), input: { url: 'https://evil.example' } })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(await recipes.browser!.run(ctx(), { actionId: 'd', idempotencyKey: 'd', recipeId: 'unconfigured-js', recipeHash: 'unconfigured', input: {} })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
  } finally { await recipes.close(); }
});

});
