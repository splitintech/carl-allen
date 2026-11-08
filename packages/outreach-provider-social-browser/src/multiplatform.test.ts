import {syntheticVideoBytes} from './video.test-util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ProviderContext } from '@splitin/outreach-contracts';
import { socialBrowserAdapter } from './index';
import { canonicalSocialProfile, type SocialChannel } from './platforms';
import { loadStoredMedia } from './stored-media';
import { mediaUploadTimeout } from './media';
import { approvedCreateRequest } from './network-publish';
const executable = process.env.OUTREACH_TEST_CHROME ?? [join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'), '/usr/bin/chromium'].find(existsSync);
let ctx: ProviderContext = { workspaceId: 'ws', account: { id: 'a', provider: 'social-browser', externalAccountId: 'owner', sender: { name: 'Owner', address: 'owner@example.com' } }, secretRef: 'env:SOCIAL', secrets: { get: async () => '' }, traceId: 'test', signal: AbortSignal.timeout(120000), now: Date.now };
let root: string; let imageRef: string; let videoRef: string;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
let video:Buffer;
async function asset(bytes: Buffer): Promise<string> { const hash = createHash('sha256').update(bytes).digest('hex'); const directory = join(root, createHash('sha256').update('ws').digest('hex').slice(0, 24)); await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, hash), bytes, { mode: 0o600 }); return `outreach-media://${hash}`; }
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'publishing-assets-')); video=syntheticVideoBytes(); imageRef = await asset(image); videoRef = await asset(video); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
describe('immutable publishing media', () => {
  it('allows bounded video processing independently of shorter receipt/image waits', () => {
    expect(mediaUploadTimeout('video')).toBe(120_000);
    expect(mediaUploadTimeout('image')).toBe(15_000);
    expect(mediaUploadTimeout('image', undefined, 30_000)).toBe(30_000);
    expect(mediaUploadTimeout('video', 2000)).toBe(2000);
    expect(mediaUploadTimeout('video', 900_000)).toBe(120_000);
    expect(() => mediaUploadTimeout('video', -1)).toThrow(/positive finite/);
    expect(() => mediaUploadTimeout('video', Number.NaN)).toThrow(/positive finite/);
  });
  it('loads signed image/video bytes from the selected workspace only', async () => {
    expect(await loadStoredMedia(ctx, imageRef, root)).toMatchObject({ mimeType: 'image/png', buffer: image });
    expect(await loadStoredMedia(ctx, videoRef, root)).toMatchObject({ mimeType: 'video/mp4', buffer: video });
    await expect(loadStoredMedia({ ...ctx, workspaceId: 'different-workspace' }, imageRef, root)).rejects.toThrow();
    await expect(loadStoredMedia(ctx, 'outreach-media://../escape', root)).rejects.toThrow(/reference/);
  });
  it('rejects tampering with bytes pinned by an approved hash', async () => {
    const ref = await asset(Buffer.concat([image, Buffer.from('unique')])); const hash = ref.split('//')[1]!;
    await writeFile(join(root, createHash('sha256').update('ws').digest('hex').slice(0, 24), hash), image);
    await expect(loadStoredMedia(ctx, ref, root)).rejects.toThrow(/approved content hash/);
  });
  it('associates create responses with exact approved caption data', () => {
    expect(approvedCreateRequest('x', JSON.stringify({variables:{tweet_text:'Approved'}}), 'Approved')).toBe(true);
    expect(approvedCreateRequest('x', JSON.stringify({variables:{tweet_text:'Different'}}), 'Approved')).toBe(false);
    expect(approvedCreateRequest('instagram', 'caption=Approved', 'Approved')).toBe(true);
    expect(approvedCreateRequest('tiktok', JSON.stringify({post_info:{title:'Approved'}}), 'Approved')).toBe(true);
    expect(approvedCreateRequest('tiktok', JSON.stringify({post_info:{title:''}}), '')).toBe(true);
    expect(approvedCreateRequest('tiktok', JSON.stringify({media:{title:'Approved'}}), 'Approved')).toBe(false);
  });
  it('rejects WebM publishing and Instagram WebP before any browser effect', async () => {
    const webm = await asset(Buffer.from([0x1a,0x45,0xdf,0xa3,1,2,3,4]));
    const webp = await asset(Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP'),Buffer.alloc(4)]));
    for (const [channel, ref, profile] of [['x',webm,'https://x.com/owner/'],['instagram',webp,'https://www.instagram.com/owner/']] as const) {
      const p = socialBrowserAdapter({runtime:{kind:'fixture',sandboxId:'fixture'},origin:'http://127.0.0.1:1234',media:{allowedOrigins:[],assetDirectory:root},accountBindings:{owner:{kind:channel,expectedProfileUrl:profile,pageFactory:async()=>{throw new Error('Browser must not open');}}}});
      expect(await p.social!.publish(ctx,{channel,actionId:'format',idempotencyKey:'format',text:'Approved',mediaUrls:[ref]})).toMatchObject({kind:'rejected',errorClass:'unsupported',detail:expect.stringMatching(/convert|MP4/i)});
      await p.close();
    }
  });
  it('canonicalizes account URLs and rejects publication/system URLs', () => {
    expect(canonicalSocialProfile('https://x.com/Owner')).toEqual({ channel: 'x', url: 'https://x.com/owner/' });
    expect(canonicalSocialProfile('https://instagram.com/owner')).toEqual({ channel: 'instagram', url: 'https://www.instagram.com/owner/' });
    expect(canonicalSocialProfile('https://www.tiktok.com/@owner').channel).toBe('tiktok');
    for (const url of ['https://x.com/home', 'https://x.com/owner/status/123', 'https://www.instagram.com/p/abc/', 'https://www.tiktok.com/@owner?redirect=evil', 'https://evil.example/@owner']) expect(() => canonicalSocialProfile(url)).toThrow(/canonical/);
  });
});
const fixture = process.env.OUTREACH_BROWSER_FIXTURES === '1' ? describe : describe.skip;
fixture('four platform browser publishing with real Chromium local fixtures', () => {
  vi.setConfig({testTimeout:120000,hookTimeout:120000});
  let server: Server; let browser: Browser; let context: BrowserContext; let origin: string;
  let channel: 'x' | 'instagram' | 'tiktok'; let wrongIdentity = false; let ambiguous = false; let uploadFail = false; let hideReelMarker = false; let preexistingReceipt = false; let domWrongAuthor = false; let effects: string[] = []; let adapter: ReturnType<typeof socialBrowserAdapter>;
  const profiles: Record<SocialChannel, string> = { linkedin: 'https://www.linkedin.com/in/owner/', x: 'https://x.com/owner/', instagram: 'https://www.instagram.com/owner/', tiktok: 'https://www.tiktok.com/@owner/' };
  function html() {
    const href = wrongIdentity ? profiles[channel].replace('owner', 'somebody_else') : profiles[channel];
    return `<style>[contenteditable]{min-height:24px;border:1px solid #aaa}</style>${preexistingReceipt ? '<article data-publication data-testid="tweet"><a href="https://x.com/owner/">Owner</a><a href="/owner/status/1234567890">Approved caption</a></article>' : ''}<a data-identity href="${href}">Signed-in account</a><div data-testid="tweetTextarea_0" contenteditable="true"></div><a href="#" aria-label="Create">Create</a><div role="dialog"><input type="file" accept="image/*,video/*" multiple><textarea aria-label="Write a caption"></textarea><button onclick="publish()">Share</button></div><div data-e2e="caption-editor"><div contenteditable="true"></div></div><button data-testid="tweetButtonInline" onclick="publish()">Post</button><button data-e2e="post-video-button" onclick="publish()">Post video</button><script>document.querySelector('input').onchange=()=>{if(${uploadFail})return;for(const f of document.querySelector('input').files){const el=document.createElement('div');el.setAttribute('data-test-media-ready','');if(f.type.startsWith('video/')&&!${hideReelMarker})el.setAttribute('data-reel-preview','');document.body.append(el);}};async function publish(){const file=document.querySelector('input').files;await fetch(${JSON.stringify(channel==='instagram')}?(file[0]?.type.startsWith('video/')?'/api/v1/media/configure_to_clips/':file.length>1?'/api/v1/media/configure_to_sidecar/':'/api/v1/media/configure/'):${JSON.stringify(channel==='x'?'/graphql/CreateTweet':'/api/item/publish/')},{method:'POST',body:JSON.stringify({count:file.length,types:[...file].map(f=>f.type),...(${JSON.stringify(channel)}==='x'?{variables:{tweet_text:document.querySelector('[data-testid=tweetTextarea_0]').textContent}}:${JSON.stringify(channel)}==='instagram'?{caption:document.querySelector('textarea').value}:{post_info:{title:document.querySelector('[data-e2e=caption-editor] [contenteditable]').textContent}})})});if(${domWrongAuthor}){const n=document.createElement('article');n.dataset.publication='';n.dataset.testid='tweet';n.innerHTML='<a href="https://x.com/somebody_else/">Wrong author</a><a href="/somebody_else/status/99999999">'+document.querySelector('[data-testid=tweetTextarea_0]').textContent+'</a>';document.body.append(n);}}</script>`;
  }
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST') { let body = ''; req.on('data', (chunk) => body += chunk); req.on('end', () => { effects.push(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(ambiguous ? { ok: true } : channel === 'x' ? { data: { create_tweet: { tweet_results: { result: { rest_id: '1234567890' } } } } } : channel === 'instagram' ? { media: { pk: '2345678901' } } : { item_id: '3456789012' })); }); return; }
      res.setHeader('content-type', 'text/html'); res.end(html());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server'); origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
  }, 120000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise<void>((resolve) => server?.close(() => resolve())); });
  beforeEach(async () => { ctx = {...ctx,signal:AbortSignal.timeout(90000)}; channel = 'x'; wrongIdentity = false; ambiguous = false; uploadFail = false; hideReelMarker=false; preexistingReceipt = false; domWrongAuthor = false; effects = []; context = await browser.newContext(); });
  afterEach(async () => { await adapter?.close(); await context?.close(); });
  function provider() {
    adapter = socialBrowserAdapter({ runtime: { kind: 'fixture', sandboxId: 'fixture' }, origin, confirmationTimeoutMs: 2000, media: { allowedOrigins: [], assetDirectory: root }, accountBindings: { owner: { kind: channel, expectedProfileUrl: profiles[channel], identitySelector: '[data-identity]', pageFactory: () => context.newPage() } } }); return adapter;
  }
  it.each(['x', 'instagram', 'tiktok'] as const)('uploads a stored video and confirms a native %s publication ID', async (network) => {
    channel = network; const p = provider(); const caps = await p.account.discover(ctx);
    expect(caps).toMatchObject({ socialChannels: [network], socialPublish: true, socialMessage: network === 'instagram', socialConnect: false });
    expect(await p.social!.publish(ctx, { channel, actionId: 'a', idempotencyKey: 'k', text: 'Approved caption', mediaUrls: [videoRef] })).toMatchObject({ kind: 'accepted', receipt: { providerMessageId: channel === 'x' ? '1234567890' : channel === 'instagram' ? '2345678901' : '3456789012' } });
    expect(effects).toHaveLength(1); expect(JSON.parse(effects[0]!)).toMatchObject({ count: 1, types: ['video/mp4'] });
  });
  it('publishes an explicitly requested Instagram reel only after native reel preview confirmation',async()=>{channel='instagram';expect(await provider().social!.publish(ctx,{channel,format:'reel',actionId:'reel',idempotencyKey:'reel',text:'Approved reel',mediaUrls:[videoRef]})).toMatchObject({kind:'accepted'});expect(effects).toHaveLength(1);});
  it('holds Instagram video when its native composer does not confirm reel mode',async()=>{channel='instagram';hideReelMarker=true;expect(await provider().social!.publish(ctx,{channel,format:'reel',actionId:'reel',idempotencyKey:'reel',text:'Approved reel',mediaUrls:[videoRef]})).toMatchObject({kind:'rejected',detail:expect.stringMatching(/reel format/)});expect(effects).toEqual([]);});
  it('confirms an Instagram carousel through the native sidecar create response',async()=>{channel='instagram';expect(await provider().social!.publish(ctx,{channel,format:'carousel',actionId:'carousel',idempotencyKey:'carousel',text:'Approved carousel',mediaUrls:[imageRef,imageRef]})).toMatchObject({kind:'accepted'});expect(JSON.parse(effects[0]!)).toMatchObject({count:2});});
  it.each(['x', 'instagram'] as const)('uploads an image on %s without silently falling back to text', async (network) => {
    channel = network; expect(await provider().social!.publish(ctx, { channel, actionId: 'a', idempotencyKey: 'k', text: 'Approved image', mediaUrls: [imageRef] })).toMatchObject({ kind: 'accepted' }); expect(JSON.parse(effects[0]!)).toMatchObject({ count: 1, types: ['image/png'] });
  });
  it('rejects unsupported TikTok photos before browser navigation', async () => {
    channel = 'tiktok'; expect(await provider().social!.publish(ctx, { channel, actionId: 'a', idempotencyKey: 'k', text: 'Photo', mediaUrls: [imageRef] })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' }); expect(effects).toEqual([]);
  });
  it('holds wrong account identity before any external effect', async () => {
    wrongIdentity = true; expect(await provider().social!.publish(ctx, { channel, actionId: 'a', idempotencyKey: 'k', text: 'Do not post' })).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' }); expect(effects).toEqual([]);
  });
  it('holds mismatched channel and LinkedIn-only messaging on X', async () => {
    const p = provider(); expect(await p.social!.publish(ctx, { channel: 'instagram', actionId: 'a', idempotencyKey: 'k', text: 'No', mediaUrls: [imageRef] })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(await p.social!.message(ctx, { channel: 'x', actionId: 'a', idempotencyKey: 'k', targetUrl: profiles.x, text: 'No' })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' }); expect(effects).toEqual([]);
  });
  it('records an ambiguous publication as unknown instead of retryable success', async () => {
    ambiguous = true; expect(await provider().social!.publish(ctx, { channel, actionId: 'a', idempotencyKey: 'k', text: 'Unknown' })).toMatchObject({ kind: 'unknown' }); expect(effects).toHaveLength(1);
  });
  it('does not accept a response or DOM receipt already observed before publication', async () => {
    preexistingReceipt = true; expect(await provider().social!.publish(ctx, {channel, actionId:'a', idempotencyKey:'k', text:'Approved caption'})).toMatchObject({kind:'unknown'}); expect(effects).toHaveLength(1);
  });
  it('rejects a new identical-caption publication owned by another author as confirmation', async () => {
    ambiguous = true; domWrongAuthor = true; expect(await provider().social!.publish(ctx, {channel, actionId:'a', idempotencyKey:'k', text:'Approved caption'})).toMatchObject({kind:'unknown'}); expect(effects).toHaveLength(1);
  });
  it('does not accept arbitrary new feed links for an empty-caption post', async () => {
    ambiguous = true; domWrongAuthor = true; expect(await provider().social!.publish(ctx, {channel, actionId:'a', idempotencyKey:'k', text:'',mediaUrls:[imageRef]})).toMatchObject({kind:'unknown'}); expect(effects).toHaveLength(1);
  });
  it('refuses publication if an upload never becomes ready', async () => {
    uploadFail = true; expect(await provider().social!.publish(ctx, { channel, actionId: 'a', idempotencyKey: 'k', text: 'Upload failed', mediaUrls: [imageRef] })).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' }); expect(effects).toEqual([]);
  });
});
