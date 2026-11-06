import type { ProviderContext, SendResult, SocialConnectInput, SocialHealth, SocialMessageInput, SocialPublishInput } from '@splitin/outreach-contracts';
import type { Page, Response } from 'playwright';
import type { SocialSession } from './session';
import { attachImages, attachVideo, loadMedia, mediaUploadTimeout, type MediaPolicy } from './media';
import { canonicalProfile, type AccountBinding } from './runtime';

export interface LinkedInOptions {
  readonly origin: string;
  readonly confirmationTimeoutMs?: number;
  readonly media?: MediaPolicy;
}
const IDENTITY = '.profile-card a[href*="/in/"], a[data-control-name="identity_welcome_message"], a[data-view-name="identity-module"]';
function timeout(options: LinkedInOptions): number { return options.confirmationTimeoutMs ?? 15_000; }
async function ready(page: Page, binding: AccountBinding, options: LinkedInOptions): Promise<void> {
  await page.goto(`${options.origin}/feed/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (new URL(page.url()).origin !== options.origin) throw new Error('Browser left the configured social origin');
  if (/\/(login|checkpoint|authwall|challenge)/i.test(new URL(page.url()).pathname)) throw new Error('needs_reauth: checkpoint or logged out');
  const identity = page.locator(binding.identitySelector ?? IDENTITY).first();
  const actual = await identity.getAttribute('href', { timeout: timeout(options) });
  if (!actual || !binding.expectedProfileUrl || canonicalProfile(actual) !== canonicalProfile(binding.expectedProfileUrl)) throw new Error('needs_reauth: signed-in identity does not match account binding');
}
export async function linkedInHealth(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, options: LinkedInOptions): Promise<SocialHealth> {
  try {
    await session.withPage(ctx.signal, (page) => ready(page, binding, options));
    return { status: 'ok', reconnectNeeded: false };
  } catch (error) {
    return { status: 'reauth_required', reconnectNeeded: true, detail: `needs_reauth: ${(error as Error).message}`.slice(0, 300) };
  }
}
function rejected(detail: string): SendResult { return { kind: 'rejected', errorClass: 'unsupported', detail }; }
/** A missing target control is a capability/UI problem, not evidence of revoked authentication. */
export function preEffectFailure(error: unknown, authenticated: boolean, cancelled: boolean, currentUrl?: string): SendResult {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const loggedOut = currentUrl && /\/(login|checkpoint|authwall|challenge)(?:\/|$)/i.test(new URL(currentUrl).pathname);
  const lostSession = /needs_reauth|checkpoint|authwall|logged out|identity.*match|(?:target|browser|context|connection).*(?:closed|disconnect)|ECONNREFUSED|ERR_CONNECTION|connectOverCDP/i.test(detail);
  return !authenticated || cancelled || loggedOut || lostSession
    ? { kind: 'rejected', errorClass: 'auth_expired', detail: `needs_reauth: ${detail}` }
    : rejected(`No external effect attempted: ${detail}`);
}
function target(input: { channel: string; targetUrl: string }, options: LinkedInOptions): string {
  if (input.channel !== 'linkedin') throw new Error('unsupported social channel');
  const parsed = new URL(input.targetUrl);
  if (parsed.origin !== 'https://www.linkedin.com' || !/^\/in\/[^/]+\/?$/.test(parsed.pathname)) throw new Error('target must be a LinkedIn /in/ profile');
  return `${options.origin}${parsed.pathname}`;
}
async function effect(
  session: SocialSession, ctx: ProviderContext, binding: AccountBinding, options: LinkedInOptions,
  action: (page: Page, boundary: () => void) => Promise<string>,
): Promise<SendResult> {
  let crossed = false;
  let authenticated = false;
  let activePage: Page | undefined;
  try {
    return await session.withPage(ctx.signal, async (page) => {
      activePage = page;
      await ready(page, binding, options);
      authenticated = true;
      const id = await action(page, () => { ctx.signal.throwIfAborted(); if (new URL(page.url()).origin !== options.origin) throw new Error('Browser left the configured social origin'); crossed = true; });
      if (new URL(page.url()).origin !== options.origin) throw new Error('Social confirmation origin changed');
      return { kind: 'accepted', receipt: { providerMessageId: id, acceptedAt: ctx.now() } };
    });
  } catch (error) {
    const detail = (error as Error).message.slice(0, 300);
    return crossed ? { kind: 'unknown', detail: `effect attempted; confirmation uncertain: ${detail}` }
      : preEffectFailure(error, authenticated, ctx.signal.aborted, activePage?.url());
  }
}
async function confirmedId(page: Page, selector: string, text: string, attribute: string | readonly string[], options: LinkedInOptions, before: readonly string[]): Promise<string> {
  const attributes = typeof attribute === 'string' ? [attribute] : attribute;
  const candidates = page.locator(selector).filter({ hasText: text });
  await candidates.first().waitFor({ state: 'visible', timeout: timeout(options) });
  // A pre-existing identical message/post is not a receipt for this attempt.
  const deadline = Date.now() + timeout(options);
  while (Date.now() < deadline) {
    for (let i = 0; i < await candidates.count(); i += 1) {
      for (const name of attributes) {
        const id = await candidates.nth(i).getAttribute(name);
        if (id && !before.includes(id)) return id;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error('No new platform receipt identifier');
}
async function previousIds(page: Page, selector: string, attribute: string | readonly string[]): Promise<string[]> {
  const attributes = typeof attribute === 'string' ? [attribute] : attribute;
  return (await page.locator(selector).evaluateAll((nodes, names) => nodes.flatMap((node) => names.map((name) => node.getAttribute(name))), attributes)).filter((id): id is string => Boolean(id));
}
export async function linkedInPublish(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, options: LinkedInOptions, input: SocialPublishInput): Promise<SendResult> {
  if (input.channel !== 'linkedin') return rejected('unsupported social channel');
  let files: Awaited<ReturnType<typeof loadMedia>> = [];
  if (input.mediaUrls?.length) {
    try { files = await loadMedia(ctx, input.mediaUrls, options.media); }
    catch (error) { return rejected((error as Error).message); }
  }
  if (!input.text.trim() && !files.length) return rejected('A caption or uploaded media is required');
  if (files.some((f) => f.mimeType.startsWith('video/') && f.mimeType !== 'video/mp4')) return rejected('Publishing requires MP4 video; convert WebM to MP4 before scheduling');
  if (Array.from(input.text).length > 3000 || files.length > 4 || (files.some((f) => f.mimeType.startsWith('video/')) && files.length !== 1)) return rejected('LinkedIn supports at most four images or one video and 3000 characters');
  return effect(session, ctx, binding, options, async (page, boundary) => {
    const selector = 'article[data-urn], .feed-shared-update-v2[data-urn]';
    const before = await previousIds(page, selector, 'data-urn');
    await page.locator('button.share-box-feed-entry__trigger, button:has-text("Start a post")').first().click();
    await page.locator('.ql-editor, div[role="textbox"][contenteditable="true"]').first().fill(input.text);
    if (files[0]?.mimeType.startsWith('video/')) await attachVideo(page, files[0], mediaUploadTimeout('video', options.confirmationTimeoutMs));
    else if (files.length) await attachImages(page, files, mediaUploadTimeout('image', options.confirmationTimeoutMs));
    boundary();
    await page.locator('button.share-actions__primary-action').first().click();
    return confirmedId(page, selector, input.text, 'data-urn', options, before);
  });
}
export async function linkedInMessage(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, options: LinkedInOptions, input: SocialMessageInput): Promise<SendResult> {
  let url: string;
  try { url = target(input, options); } catch (error) { return rejected((error as Error).message); }
  return effect(session, ctx, binding, options, async (page, boundary) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== options.origin) throw new Error('Target navigation left the configured social origin');
    if (/checkpoint|authwall|login|challenge/i.test(new URL(page.url()).pathname)) throw new Error('checkpoint before message');
    await page.locator('button:has-text("Message"), a:has-text("Message")').first().click();
    const participant = page.locator(binding.messageRecipientSelector ?? '.msg-overlay-bubble-header a[href*="/in/"], .msg-thread__link-to-profile, .msg-thread__topcard a[href*="/in/"]').first();
    const participantHref = await participant.getAttribute('href', { timeout: timeout(options) });
    if (!participantHref || canonicalProfile(participantHref) !== canonicalProfile(input.targetUrl)) throw new Error('Opened conversation recipient does not match the approved target');
    const selector = '.msg-s-event-listitem[data-event-urn], [data-message-id]';
    const attribute = ['data-event-urn', 'data-message-id'] as const;
    const before = await previousIds(page, selector, attribute);
    await page.locator('.msg-form__contenteditable, div[role="textbox"][contenteditable="true"]').first().fill(input.text);
    boundary();
    await page.locator('button.msg-form__send-button').first().click();
    return confirmedId(page, selector, input.text, attribute, options, before);
  });
}
export function invitationReceiptId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (['entityUrn', 'invitationUrn', 'backendUrn'].includes(key) && typeof item === 'string' && /^urn:li:(?:fsd_|fs_)?invitation(?::|$)/i.test(item)) return item;
    const nested = invitationReceiptId(item);
    if (nested) return nested;
  }
  return undefined;
}
export async function linkedInConnect(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, options: LinkedInOptions, input: SocialConnectInput): Promise<SendResult> {
  if (input.text && input.text.length > 200) return rejected('Connection note exceeds conservative 200 character limit');
  let url: string;
  try { url = target(input, options); } catch (error) { return rejected((error as Error).message); }
  return effect(session, ctx, binding, options, async (page, boundary) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== options.origin) throw new Error('Target navigation left the configured social origin');
    const existing = page.locator('button:has-text("Pending"), button:has-text("Withdraw invitation")');
    if (await existing.count()) throw new Error('An invitation is already pending; no new invitation attempted');
    // Some LinkedIn layouts submit immediately on Connect. Treat the first click as the boundary.
    const response: Promise<Response | null> = page.waitForResponse((r) => /invitation|relationships/i.test(r.url()) && r.request().method() === 'POST', { timeout: timeout(options) }).catch(() => null);
    boundary();
    await page.getByRole('button', { name: /^Connect$/i }).first().click();
    const dialog = page.getByRole('dialog').last();
    const hasDialog = await dialog.waitFor({ state: 'visible', timeout: 1_000 }).then(() => true, () => false);
    if (hasDialog) {
      if (input.text) {
        await dialog.getByRole('button', { name: /Add a note/i }).click();
        await dialog.locator('textarea[name="message"], textarea#custom-message').fill(input.text);
      }
      ctx.signal.throwIfAborted();
      await dialog.getByRole('button', { name: input.text ? /^Send$/i : /Send without a note/i }).click();
    } else if (input.text) throw new Error('Connection may have sent without requested note');
    const received = await response;
    if (!received || !received.ok()) throw new Error('Invitation response not confirmed');
    const id = invitationReceiptId(await received.json().catch(() => null));
    if (!id) throw new Error('Invitation response lacks a native receipt identifier');
    return id;
  });
}
