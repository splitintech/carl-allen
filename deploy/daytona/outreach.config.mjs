import { readFileSync, lstatSync } from 'node:fs';
import { socialBrowserAdapter } from '@splitin/outreach-provider-social-browser';
import { gmailAdapter } from '@splitin/outreach-provider-email-gmail';
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
  execution: { publishingMediaTimeoutMs: Number(process.env.OUTREACH_PUBLISHING_MEDIA_TIMEOUT_MS ?? 180000) },
  adapters: [
    socialBrowserAdapter({
      runtime: { kind: 'daytona', sandboxId: process.env.DAYTONA_SANDBOX_ID },
      accountBindings: () => optionalJson(bindingsPath, {}),
      recipes: optionalJson(recipesPath, []),
      media: { allowedOrigins: JSON.parse(process.env.OUTREACH_MEDIA_ALLOWED_ORIGINS ?? '[]') },
      purposes: ['social_publishing', 'social_messaging', 'manual_correspondence'],
    }),
    gmailAdapter({ purposes: ['manual_correspondence', 'automated_outreach'] }),
    outlookAdapter({ purposes: ['manual_correspondence'] }),
  ],
};
