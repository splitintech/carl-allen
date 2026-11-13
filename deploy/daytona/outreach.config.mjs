import { readFileSync, lstatSync } from 'node:fs';
import { stageMediaByHash } from '@splitin/outreach-core';
import { socialBrowserAdapter } from '@splitin/outreach-provider-social-browser';
import { gmailAdapter } from '@splitin/outreach-provider-email-gmail';
import { zohoAdapter } from '@splitin/outreach-provider-email-zoho';
import { outlookAdapter } from '@splitin/outreach-provider-email-outlook';

const bindingsPath = process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE ?? process.env.OUTREACH_SOCIAL_BINDINGS_FILE ?? '/data/outreach/social-bindings.json';
const recipesPath = process.env.OUTREACH_BROWSER_RECIPES_FILE ?? '/data/outreach/browser-recipes.json';
function optionalJson(path, fallback) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Browser configuration must be an owner-only regular file');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export default {
  documentJobs: { enabled: process.env.OUTREACH_DOCUMENT_JOBS !== '0', executablePath: process.env.OUTREACH_DOCUMENT_CHROME_EXECUTABLE ?? process.env.OUTREACH_CHROME_EXECUTABLE ?? '/usr/bin/google-chrome-stable' },
  execution: { publishingMediaTimeoutMs: Number(process.env.OUTREACH_PUBLISHING_MEDIA_TIMEOUT_MS ?? 180000) },
  adapters: [
    socialBrowserAdapter({
      runtime: { kind: 'daytona', sandboxId: process.env.DAYTONA_SANDBOX_ID },
      accountBindings: () => optionalJson(bindingsPath, {}),
      recipes: optionalJson(recipesPath, []),
      media: { allowedOrigins: JSON.parse(process.env.OUTREACH_MEDIA_ALLOWED_ORIGINS ?? '[]'), ...(process.env.OUTREACH_MEDIA_GATEWAY ? { stageStoredMedia: (ctx, hash, path) => stageMediaByHash(ctx.workspaceId, hash, path) } : {}) },
      purposes: ['social_publishing', 'social_messaging', 'manual_correspondence'],
    }),
    zohoAdapter({ region: process.env.OUTREACH_ZOHO_REGION ?? 'us' }),
    gmailAdapter({ purposes: ['manual_correspondence', 'automated_outreach'] }),
    outlookAdapter({ purposes: ['manual_correspondence'] }),
  ],
};
