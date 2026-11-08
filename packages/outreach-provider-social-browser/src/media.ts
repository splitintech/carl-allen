import {probeVideoBytes,publishingVideoIssues,type ProviderContext} from '@splitin/outreach-contracts';
import type { Page } from 'playwright';
import { loadStoredMedia, type MediaAttachment } from './stored-media';
export interface MediaPolicy {
  readonly allowedOrigins: readonly string[];
  readonly assetDirectory?: string;
  readonly stageStoredMedia?: (ctx: ProviderContext, hash: string, filePath: string) => Promise<void>;
  readonly maxFiles?: number;
  readonly maxBytesPerFile?: number;
  readonly allowFixtureHttp?: boolean;
}
export interface ImageAttachment { readonly name: string; readonly mimeType: string; readonly buffer: Buffer }
function imageType(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
/** Fetch approved image URLs before opening the composer. No file paths, redirects or unbounded bodies. */
export async function loadImages(ctx: ProviderContext, urls: readonly string[], policy?: MediaPolicy): Promise<ImageAttachment[]> {
  if (!policy?.allowedOrigins.length) throw new Error('Image attachments require configured allowed media origins');
  const maxFiles = Math.min(policy.maxFiles ?? 20, 20);
  const maxBytes = Math.min(policy.maxBytesPerFile ?? 8 * 1024 * 1024, 20 * 1024 * 1024);
  if (urls.length > maxFiles || maxFiles < 1 || maxBytes < 1) throw new Error('Image attachment limit exceeded');
  const files: ImageAttachment[] = [];
  for (const [index, raw] of urls.entries()) {
    ctx.signal.throwIfAborted();
    const url = new URL(raw);
    const fixtureHttp = policy.allowFixtureHttp && process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !fixtureHttp) || url.username || url.password || !policy.allowedOrigins.includes(url.origin)) throw new Error('Media URL origin is not allowed');
    const response = await fetch(url, { redirect: 'manual', signal: ctx.signal });
    if (!response.ok || response.status >= 300) throw new Error('Media download failed or redirected');
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) { await response.body?.cancel(); throw new Error('Media is too large'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Media body is missing');
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Media is too large'); }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    const buffer = Buffer.concat(chunks);
    const mimeType = imageType(buffer);
    const declared = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (!mimeType || declared !== mimeType) throw new Error('Media must have matching PNG/JPEG/GIF/WebP bytes and content type');
    files.push({ name: `approved-image-${index + 1}.${mimeType.split('/')[1]}`, mimeType, buffer });
  }
  return files;
}
export async function attachImages(page: Page, files: readonly ImageAttachment[], timeoutMs: number): Promise<void> {
  let input = page.locator('input[type="file"][accept*="image"]').first();
  if (!await input.count()) {
    await page.locator('button[aria-label*="Add media"], button[aria-label*="photo"], button[aria-label*="Photo"]').first().click();
    input = page.locator('input[type="file"][accept*="image"]').first();
  }
  const previews = page.locator('[data-test-media-preview], .share-creation-state__image, .image-sharing-detour-container img');
  if (await previews.count()) throw new Error('Composer already contains unapproved media');
  await input.setInputFiles([...files]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await previews.count() === files.length) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Image uploads were not confirmed; no post was submitted');
}

/** Stored uploads may contain video; arbitrary remote video fetches are deliberately unsupported. */
export async function loadMedia(ctx: ProviderContext, refs: readonly string[], policy?: MediaPolicy, channel='linkedin'): Promise<MediaAttachment[]> {
  if (refs.length > Math.min(policy?.maxFiles ?? 20, 20)) throw new Error('Media attachment limit exceeded');
  const files: MediaAttachment[] = [];
  for (const ref of refs) files.push(ref.startsWith('outreach-media:') ? await loadStoredMedia(ctx, ref, policy?.assetDirectory, policy?.stageStoredMedia) : (await loadImages(ctx, [ref], policy))[0]!);
  for(const file of files)if(file.mimeType.startsWith('video/')){if(file.mimeType!=='video/mp4')throw new Error('Convert video to MP4 / H.264 before publishing.');const issues=publishingVideoIssues(channel,probeVideoBytes(file.buffer));if(issues.length)throw new Error(issues.join('; '));}
  return files;
}
export async function attachVideo(page: Page, file: MediaAttachment, timeoutMs: number): Promise<void> {
  let input = page.locator('input[type="file"][accept*="video"]').first();
  if (!await input.count()) { await page.locator('button[aria-label*="media" i], button[aria-label*="video" i]').first().click(); input = page.locator('input[type="file"][accept*="video"]').first(); }
  const preview = page.locator('[data-test-video-ready], video[src], .video-sharing-detour-container video');
  if (await preview.count()) throw new Error('Composer already contains unapproved video');
  await input.setInputFiles(file);
  await preview.first().waitFor({ state: 'visible', timeout: timeoutMs });
}

/** Upload processing has its own bounded budget; receipt polling keeps its shorter timeout. */
export function mediaUploadTimeout(kind: 'image' | 'video', override?: number, imageDefaultMs = 15_000): number {
  const requested = override ?? (kind === 'video' ? 120_000 : imageDefaultMs);
  if (!Number.isFinite(requested) || requested < 1) throw new Error('Media upload timeout must be a positive finite duration');
  return Math.min(requested, 120_000);
}
