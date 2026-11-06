import type { ProviderContext, SendResult, SocialHealth, SocialPublishInput } from '@splitin/outreach-contracts';
import type { Page, Response } from 'playwright';
import type { SocialSession } from './session';
import type { AccountBinding } from './runtime';
import { accountChannel, canonicalSocialProfile, PLATFORM_ORIGINS, type SocialChannel } from './platforms';
import { loadMedia, mediaUploadTimeout, type MediaPolicy } from './media';
import type { MediaAttachment } from './stored-media';
import { preEffectFailure } from './linkedin';

export interface NetworkOptions { readonly origin: string; readonly confirmationTimeoutMs?: number; readonly media?: MediaPolicy }
type Network = Exclude<SocialChannel, 'linkedin'>;
const IDENTITY: Record<Network, string> = {
  x: 'a[data-testid="AppTabBar_Profile_Link"]',
  instagram: 'nav a:has(img[alt*="profile picture"]), [role="navigation"] a:has(img[alt*="profile picture"]), a[aria-label="Profile"]',
  tiktok: 'a[data-e2e="profile-icon"], a[data-e2e="nav-profile"], a[data-tt="profile-link"]',
};
const START: Record<Network, string> = { x: '/home', instagram: '/', tiktok: '/tiktokstudio/upload' };
const RECEIPTS: Record<Network, string> = { x: 'article[data-testid="tweet"] a[href*="/status/"]', instagram: 'a[href*="/p/"], a[href*="/reel/"]', tiktok: 'a[href*="/video/"]' };
const paths: Record<Network, RegExp> = { x: /^\/[a-z0-9_]+\/status\/\d+$/i, instagram: /^\/(p|reel)\/[A-Za-z0-9_-]+\/?$/, tiktok: /^\/@[a-z0-9_.]+\/video\/\d+$/i };
const time = (options: NetworkOptions) => options.confirmationTimeoutMs ?? 30_000;
function checkOrigin(page: Page, options: NetworkOptions): void {
  if (new URL(page.url()).origin !== options.origin) throw new Error('Browser left its bound social origin');
  if (/\/(login|accounts\/login|checkpoint|challenge|authwall)(?:\/|$)/i.test(new URL(page.url()).pathname)) throw new Error('needs_reauth: platform login or checkpoint required');
}
async function identity(page: Page, binding: AccountBinding, channel: Network, options: NetworkOptions): Promise<void> {
  checkOrigin(page, options);
  const href = await page.locator(binding.identitySelector ?? IDENTITY[channel]).first().getAttribute('href', { timeout: time(options) });
  const expected = canonicalSocialProfile(binding.expectedProfileUrl ?? '');
  const actual = href && canonicalSocialProfile(new URL(href, PLATFORM_ORIGINS[channel]).href);
  if (!actual || actual.channel !== channel || actual.url.toLowerCase() !== expected.url.toLowerCase()) throw new Error('needs_reauth: signed-in profile does not match the bound account');
}
async function ready(page: Page, binding: AccountBinding, channel: Network, options: NetworkOptions): Promise<void> {
  await page.goto(`${options.origin}${START[channel]}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await identity(page, binding, channel, options);
}
export async function networkHealth(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, channel: Network, options: NetworkOptions): Promise<SocialHealth> {
  try { await session.withPage(ctx.signal, (page) => ready(page, binding, channel, options)); return { status: 'ok', reconnectNeeded: false }; }
  catch (error) { return { status: 'reauth_required', reconnectNeeded: true, detail: String((error as Error).message).slice(0, 300) }; }
}
function validate(channel: Network, input: SocialPublishInput, files: readonly MediaAttachment[]): void {
  if (!input.text.trim() && !files.length) throw new Error('A caption or uploaded media is required');
  if (input.channel !== channel) throw new Error('The requested channel does not match the browser account');
  if (Array.from(input.text).length > (channel === 'x' ? 280 : 2200)) throw new Error('Caption exceeds the conservative platform limit');
  if (files.some((f) => f.mimeType.startsWith('video/') && f.mimeType !== 'video/mp4')) throw new Error('Publishing requires MP4 video; convert WebM to MP4 before scheduling');
  if (channel === 'instagram' && files.some((f) => f.mimeType === 'image/webp')) throw new Error('Instagram publishing requires JPEG or PNG images; convert WebP before scheduling');
  const videos = files.filter((f) => f.mimeType.startsWith('video/')).length;
  if (videos && (videos !== 1 || files.length !== 1)) throw new Error('Choose one video or images, not mixed media');
  if (files.length > (channel === 'instagram' ? 10 : channel === 'x' ? 4 : 1)) throw new Error('Platform attachment count exceeded');
  if (channel === 'instagram' && !files.length) throw new Error('Instagram requires an image or video');
  if (channel === 'tiktok' && (files.length !== 1 || videos !== 1)) throw new Error('TikTok web publishing requires exactly one uploaded video; photo posts are unsupported');
}
async function uploads(page: Page, files: readonly MediaAttachment[], channel: Network, options: NetworkOptions): Promise<void> {
  if (!files.length) return;
  const input = page.locator('input[type="file"]').first();
  const preview = channel === 'x' ? '[data-testid="attachments"] img, [data-testid="videoPlayer"], [data-test-media-ready]' : channel === 'instagram' ? '[role="dialog"] img[src^="blob:"], [role="dialog"] video, [data-test-media-ready]' : '[data-e2e="upload-video-preview"], video[src], [data-test-media-ready]';
  const target = page.locator(preview);
  if (await target.count()) throw new Error('The composer already contains unapproved media; clear its draft before publishing');
  await input.setInputFiles([...files]);
  const count = files[0]?.mimeType.startsWith('video/') ? 1 : files.length;
  const deadline = Date.now() + mediaUploadTimeout(files[0]?.mimeType.startsWith('video/') ? 'video' : 'image', options.confirmationTimeoutMs, 30_000);
  while (Date.now() < deadline) {
    if (await target.count() === count) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Not all media uploads were confirmed; publication was not attempted');
}
async function compose(page: Page, channel: Network, input: SocialPublishInput, files: readonly MediaAttachment[], options: NetworkOptions): Promise<string> {
  if (channel === 'x') {
    await page.locator('[data-testid="tweetTextarea_0"]').first().fill(input.text);
    await uploads(page, files, channel, options);
    return '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';
  }
  if (channel === 'instagram') {
    await page.getByRole('link', { name: /^New post$|^Create$/i }).or(page.getByRole('button', { name: /^Create$|^New post$/i })).first().click();
    await uploads(page, files, channel, options);
    for (let i = 0; i < 3 && !await page.locator('textarea[aria-label*="caption" i], [contenteditable="true"][role="textbox"]').count(); i++) await page.getByRole('button', { name: /^Next$/ }).click();
    await page.locator('textarea[aria-label*="caption" i], [contenteditable="true"][role="textbox"]').first().fill(input.text);
    return '[role="dialog"] :is(button, [role="button"]):text-is("Share")';
  }
  await uploads(page, files, channel, options);
  await page.locator('[data-e2e="caption-editor"] [contenteditable="true"], .public-DraftEditor-content, [contenteditable="true"][role="textbox"]').first().fill(input.text);
  return 'button[data-e2e="post-video-button"], button[data-tt="post-button"]';
}
/** Only identifiers from the final create-publication response are eligible receipts. */
function responseId(channel: Network, value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  if (channel === 'x') {
    const create = (object.data as { create_tweet?: { tweet_results?: { result?: { rest_id?: unknown; legacy?: { id_str?: unknown } } } } } | undefined)?.create_tweet?.tweet_results?.result;
    const id = create?.legacy?.id_str ?? create?.rest_id;
    return typeof id === 'string' && /^\d+$/.test(id) ? id : undefined;
  }
  for (const key of channel === 'instagram' ? ['pk', 'media_id'] : ['item_id', 'aweme_id']) {
    const id = object[key];
    if ((typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) && /^\d+(?:_\d+)?$/.test(String(id))) return String(id);
  }
  for (const key of ['data', 'media', 'result', 'item']) { const id = responseId(channel, object[key]); if (id) return id; }
  return undefined;
}
function isCreateResponse(channel: Network, response: Response, origin: string): boolean {
  const url = new URL(response.url());
  const expected = channel === 'x' ? /\/CreateTweet$/ : channel === 'instagram' ? /\/media\/configure(?:_to_(?:clips|sidecar))?\/?$/ : /\/(?:item|post)\/(?:publish|create)\/?$/;
  return url.origin === origin && response.request().method() === 'POST' && response.ok() && expected.test(url.pathname);
}
export interface SeenPublications { readonly urls: Set<string>; readonly ids: Set<string> }
function canonicalPublication(raw: string, origin: string): string { const url = new URL(raw, origin); return `${url.origin}${url.pathname.replace(/\/$/, '')}`; }
async function previous(page: Page, channel: Network, options: NetworkOptions): Promise<SeenPublications> {
  const links = await page.locator(RECEIPTS[channel]).evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute('href'), native: node.closest('article, [data-publication]')?.getAttribute('data-media-id') })));
  const urls = new Set<string>(); const ids = new Set<string>();
  for (const link of links) if (link.href) {
    const href = canonicalPublication(link.href, options.origin); urls.add(href);
    const id = new URL(href).pathname.split('/').filter(Boolean).at(-1); if (id) ids.add(id);
    if (link.native) ids.add(link.native);
  }
  return { urls, ids };
}
/** A create response must belong to a request carrying this exact approved caption. */
export function approvedCreateRequest(channel: Network, raw: string | null, text: string): boolean {
  if (!raw) return false;
  try {
    const body = JSON.parse(raw) as { variables?: { tweet_text?: unknown }; caption?: unknown; post_info?: { title?: unknown } };
    const caption = channel === 'x' ? body.variables?.tweet_text : channel === 'instagram' ? body.caption : body.post_info?.title;
    return typeof caption === 'string' && caption === text;
  } catch {
    if (channel !== 'instagram') return false;
    const form = new URLSearchParams(raw); return form.has('caption') && form.get('caption') === text;
  }
}
function responseAuthor(channel: Network, value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  if (channel === 'x' && typeof body.screen_name === 'string') return body.screen_name;
  if (channel === 'instagram' && typeof body.username === 'string') return body.username;
  if (channel === 'tiktok' && typeof body.unique_id === 'string') return body.unique_id;
  for (const key of ['data', 'create_tweet', 'tweet_results', 'result', 'core', 'user_results', 'legacy', 'media', 'user', 'author']) { const found = responseAuthor(channel, body[key]); if (found) return found; }
  return undefined;
}
async function ownedPublication(node: ReturnType<Page['locator']>, binding: AccountBinding, channel: Network, input: SocialPublishInput): Promise<boolean> {
  if (!input.text.trim()) return false;
  const post = node.locator('xpath=ancestor::*[self::article or @data-publication][1]');
  const body = await post.textContent().catch(() => null); if (!body?.includes(input.text)) return false;
  const links = await post.locator('a[href]').evaluateAll((nodes) => nodes.map((anchor) => anchor.getAttribute('href')));
  const expected = canonicalSocialProfile(binding.expectedProfileUrl ?? '').url.toLowerCase();
  return links.some((href) => { try { return Boolean(href) && canonicalSocialProfile(new URL(href!, PLATFORM_ORIGINS[channel]).href).url.toLowerCase() === expected; } catch { return false; } });
}
async function receipt(page: Page, channel: Network, binding: AccountBinding, input: SocialPublishInput, before: SeenPublications, responseReceipt: () => string | undefined, options: NetworkOptions): Promise<string> {
  const deadline = Date.now() + time(options);
  while (Date.now() < deadline) {
    checkOrigin(page, options);
    const native = responseReceipt(); if (native && !before.ids.has(native)) return native;
    const nodes = page.locator(RECEIPTS[channel]);
    for (let i = 0; i < await nodes.count(); i++) {
      const node = nodes.nth(i); const href = await node.getAttribute('href'); if (!href) continue;
      const url = new URL(href, options.origin);
      if (url.origin !== options.origin || !paths[channel].test(url.pathname) || before.urls.has(canonicalPublication(href, options.origin))) continue;
      if (await ownedPublication(node, binding, channel, input)) return `${PLATFORM_ORIGINS[channel]}${url.pathname}`;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('No new native publication receipt was observed');
}
export async function networkPublish(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, options: NetworkOptions, input: SocialPublishInput): Promise<SendResult> {
  let channel: Network; let files: MediaAttachment[];
  try {
    const bound = accountChannel(binding); if (bound === 'linkedin') throw new Error('Wrong publishing driver'); channel = bound;
    files = await loadMedia(ctx, input.mediaUrls ?? [], options.media); validate(channel, input, files);
  } catch (error) { return { kind: 'rejected', errorClass: 'unsupported', detail: (error as Error).message.slice(0, 300) }; }
  let crossed = false; let authenticated = false; let active: Page | undefined;
  try {
    return await session.withPage(ctx.signal, async (page) => {
      active = page; await ready(page, binding, channel, options); authenticated = true;
      const before = await previous(page, channel, options); const submit = await compose(page, channel, input, files, options);
      await identity(page, binding, channel, options); ctx.signal.throwIfAborted(); checkOrigin(page, options);
      let observed: string | undefined;
      const listener = (response: Response) => {
        if (crossed && isCreateResponse(channel, response, options.origin) && approvedCreateRequest(channel, response.request().postData(), input.text)) void response.json().then((body) => {
          const author = responseAuthor(channel, body); const expected = new URL(binding.expectedProfileUrl!).pathname.replace(/\//g, '').replace(/^@/, '').toLowerCase();
          const id = responseId(channel, body);
          if ((!author || author.toLowerCase() === expected) && id && !before.ids.has(id)) observed = id;
        }).catch(() => undefined);
      };
      page.on('response', listener);
      try {
        crossed = true;
        await page.locator(submit).first().click();
        const id = await receipt(page, channel, binding, input, before, () => observed, options);
        return { kind: 'accepted', receipt: { providerMessageId: id, acceptedAt: ctx.now() } };
      } finally { page.off('response', listener); }
    });
  } catch (error) {
    return crossed ? { kind: 'unknown', detail: `Effect attempted; confirmation uncertain: ${(error as Error).message}`.slice(0, 300) } : preEffectFailure(error, authenticated, ctx.signal.aborted, active?.url());
  }
}
