import { socialComment } from './comments';
import { readConversations } from './conversations';
import { instagramMessage } from './instagram-message';
import { withLoginConnection } from './pool';
import { qualifyPublishing } from './publishing-qualification';
import { digestCanonical } from '@splitin/outreach-contracts';
import type { BrowserTaskInput, CapabilitySnapshot, ProviderAdapter, ProviderContext, ProviderPurpose, SendResult, SocialHealth } from '@splitin/outreach-contracts';
import { linkedInConnect, linkedInConnectionStatus, linkedInHealth, linkedInMessage, linkedInPublish, type LinkedInOptions } from './linkedin';
import { createSocialSession, type SocialSession } from './session';
import { accountBinding, assertPlacement, type AccountBinding, type RuntimePlacement } from './runtime';
import type { MediaPolicy } from './media';
import { accountChannel, PLATFORM_ORIGINS } from './platforms';
import { networkHealth, networkPublish } from './network-publish';
import { browserRecipeHealth, runBrowserRecipe, type BrowserRecipe } from './recipes';

export interface SocialBrowserAdapterOptions {
  readonly name?: string;
  readonly purposes?: readonly ProviderPurpose[];
  readonly runtime: RuntimePlacement;
  readonly accountBindings: Readonly<Record<string, AccountBinding>> | (() => Readonly<Record<string, AccountBinding>>);
  readonly recipes?: readonly BrowserRecipe[];
  readonly media?: MediaPolicy;
  /** Loopback fixture origin is accepted only in NODE_ENV=test fixture runtime. */
  readonly origin?: string;
  readonly confirmationTimeoutMs?: number;
}
export function socialBrowserAdapter(options: SocialBrowserAdapterOptions): ProviderAdapter & { close(): Promise<void> } {
  const name = options.name ?? 'social-browser';
  const purposes = options.purposes ?? ['social_publishing', 'social_messaging'];
  const origin = options.origin ?? 'https://www.linkedin.com';
  const linkedin: LinkedInOptions = { origin, confirmationTimeoutMs: options.confirmationTimeoutMs, ...(options.media ? { media: { ...options.media, allowFixtureHttp: options.runtime.kind === 'fixture' } } : {}) };
  const sessions = new Map<string, { fingerprint: string; session: SocialSession }>();
  const currentBindings = () => typeof options.accountBindings === 'function' ? options.accountBindings() : options.accountBindings;
  const recipes = new Map((options.recipes ?? []).map((recipe) => [recipe.id, recipe]));
  if (options.runtime.kind === 'fixture' && [...recipes.values()].some((recipe) => recipe.allowedOrigins.some((allowed) => !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(allowed).hostname)))) throw new Error('Fixture recipes must use only loopback origins');
  const binding = (ctx: ProviderContext): AccountBinding => {
    assertPlacement(options.runtime, origin);
    const value = accountBinding(currentBindings(), ctx);
    assertPlacement(options.runtime, options.origin ?? (value.kind === 'browser' ? origin : PLATFORM_ORIGINS[accountChannel(value)]));
    if (options.runtime.kind === 'daytona') {
      if (!value.cdpUrl) throw new Error('Production requires supervised account-specific Chrome CDP');
      const endpoint = new URL(value.cdpUrl);
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('CDP must use loopback HTTP inside the attested sandbox');
      for (const [externalId, other] of Object.entries(currentBindings())) {
        if (externalId !== ctx.account.externalAccountId && other.cdpUrl === value.cdpUrl && (!other.connectionId || other.connectionId !== value.connectionId)) throw new Error('Each account requires a unique CDP profile binding');
      }
    }
    if (value.pageFactory && options.runtime.kind !== 'fixture') throw new Error('Page injection is restricted to fixture runtime');
    if (!value.cdpUrl && !value.userDataDir && !value.pageFactory) throw new Error('Account requires a persistent profile/CDP binding');
    return value;
  };
  const session = async (ctx: ProviderContext, value: AccountBinding): Promise<SocialSession> => {
    const key = ctx.account.externalAccountId;
    const fingerprint = JSON.stringify(value);
    let cached = sessions.get(key);
    if (cached && cached.fingerprint !== fingerprint) { await cached.session.close(); sessions.delete(key); cached = undefined; }
    if (!cached) { cached = { fingerprint, session: createSocialSession(value) }; sessions.set(key, cached); }
    return cached.session;
  };
  const health = async (ctx: ProviderContext): Promise<SocialHealth> => {
    try {
      const value = binding(ctx);
      return await withLoginConnection(options.runtime, ctx, value, async () => {
      const active = await session(ctx, value);
      if (value.kind === 'browser') return await browserRecipeHealth(active, ctx, value, [...recipes.values()].filter(recipe => Boolean(value.recipeIdentities?.[recipe.id])));
      const channel = accountChannel(value);
      return channel === 'linkedin' ? await linkedInHealth(active, ctx, value, linkedin) : await networkHealth(active, ctx, value, channel, { ...linkedin, origin: options.origin ?? PLATFORM_ORIGINS[channel] });
      });
    }
    catch (error) { const detail=(error as Error).message;return /busy|capacity/.test(detail)?{status:'degraded',reconnectNeeded:false,detail}:{ status: 'reauth_required', reconnectNeeded: true, detail }; }
  };
  const execute = async (ctx: ProviderContext, fn: (active: SocialSession, value: AccountBinding) => Promise<SendResult>): Promise<SendResult> => {
    try { const value = binding(ctx); return await withLoginConnection(options.runtime, ctx, value, async () => fn(await session(ctx, value), value)); }
    catch (error) { const detail=(error as Error).message; return { kind: 'rejected', errorClass: /busy|capacity/.test(detail) ? 'transient' : 'auth_expired', detail }; }
  };
  return {
    name, purposes,
    async close() { await Promise.all([...sessions.values()].map((entry) => entry.session.close())); sessions.clear(); },
    account: {
      async qualifyPublishing(ctx,input) {const value=binding(ctx);const channel=accountChannel(value);return withLoginConnection(options.runtime,ctx,value,async()=>qualifyPublishing(await session(ctx,value),ctx,value,{...linkedin,origin:options.origin??PLATFORM_ORIGINS[channel]},input));},
      async discover(ctx): Promise<CapabilitySnapshot> {
        const account = binding(ctx);
        const channel = account.kind === 'browser' ? undefined : accountChannel(account);
        const eligibleRecipes = [...recipes].filter(([id]) => Boolean(account.recipeIdentities?.[id]));
        return {
          provider: name, send: false, replyInThread: false, customHeaders: false,
          externalIdempotency: false, inboundWebhook: false, mailboxPolling: false,
          reconcileBySentSearch: false, maxRecipientsPerMessage: 1, discoveredAt: ctx.now(),
          socialPublish: Boolean(channel), socialMessage: (channel === 'linkedin' && !account.publishingProfileUrl) || channel === 'instagram', socialConnect: channel === 'linkedin' && !account.publishingProfileUrl, socialChannels: channel ? [channel] : [],
          requiresPublishingQualification:options.runtime.kind==='daytona'&&Boolean(channel),
          socialMediaTypes: channel === 'tiktok' ? ['video'] : channel ? ['image', 'video'] : [],
          browserTasks: eligibleRecipes.length > 0, browserRecipeHashes: Object.fromEntries(eligibleRecipes.map(([id, recipe]) => [id, digestCanonical(recipe)])), executionPlacement: 'daytona-browser',
        };
      },
      health,
    },
    social: {
      publish: (ctx, input) => execute(ctx, async (active, value) => {
        if (value.kind === 'browser') return Promise.resolve({ kind: 'rejected', errorClass: 'unsupported', detail: 'Browser-only account has no native publishing capability' });
        const channel = accountChannel(value);
        if(options.runtime.kind==='daytona') {const observed=await qualifyPublishing(active,ctx,value,{...linkedin,origin:PLATFORM_ORIGINS[channel]},channel==='instagram'&&['reel','video'].includes(input.format??'')?input:undefined);if(!observed.formats.includes(input.format??'feed'))return {kind:'rejected',errorClass:'unsupported',detail:observed.detail??'This format could not be confirmed for the selected publishing identity'};}
        return channel === 'linkedin' ? linkedInPublish(active, ctx, value, linkedin, input) : networkPublish(active, ctx, value, { ...linkedin, origin: options.origin ?? PLATFORM_ORIGINS[channel] }, input);
      }),
      message: (ctx, input) => execute(ctx,(active,value)=> {
        const channel=value.kind==='browser'?'browser':accountChannel(value);
        if(value.publishingProfileUrl)return Promise.resolve({kind:'rejected',errorClass:'unsupported',detail:'Company-page messaging is not supported'});
        if(channel==='linkedin')return linkedInMessage(active,ctx,value,linkedin,input);
        if(channel==='instagram')return instagramMessage(active,ctx,value,{...linkedin,origin:options.origin??PLATFORM_ORIGINS.instagram},input);
        return Promise.resolve({kind:'rejected',errorClass:'unsupported',detail:'Messaging is unavailable for this platform'});
      }),
      comment: (ctx,input)=>execute(ctx,(active,value)=>socialComment(active,ctx,value,{...linkedin,origin:options.origin??PLATFORM_ORIGINS[input.channel as keyof typeof PLATFORM_ORIGINS]??origin},input)),
      conversations: async (ctx,cursor)=> {
        const value=binding(ctx);const channel=value.kind==='browser'?'browser':accountChannel(value);
        if(value.publishingProfileUrl||!['linkedin','instagram'].includes(channel))throw new Error('Inbox monitoring is unavailable for this account');
        return withLoginConnection(options.runtime,ctx,value,async()=>readConversations(await session(ctx,value),ctx,value,channel as 'linkedin'|'instagram',{...linkedin,origin:options.origin??PLATFORM_ORIGINS[channel as 'linkedin'|'instagram']},cursor));
      },
      connectionStatus: async(ctx,targetUrl)=> {
        const value=binding(ctx);if(value.kind==='browser'||accountChannel(value)!=='linkedin'||value.publishingProfileUrl)return'unknown';
        return withLoginConnection(options.runtime,ctx,value,async()=>linkedInConnectionStatus(await session(ctx,value),ctx,value,linkedin,targetUrl));
      },
      connect: (ctx, input) => execute(ctx, (active, value) => value.kind === 'browser' || value.publishingProfileUrl || accountChannel(value) !== 'linkedin' ? Promise.resolve({ kind: 'rejected', errorClass: 'unsupported', detail: 'Only LinkedIn accounts have invitation capability' }) : linkedInConnect(active, ctx, value, linkedin, input)),
      health,
    },
    ...(recipes.size ? { browser: { run: (ctx: ProviderContext, input: BrowserTaskInput) => execute(ctx, (active, value) => {
      const recipe = recipes.get(input.recipeId);
      return recipe ? runBrowserRecipe(active, ctx, value, recipe, input) : Promise.resolve({ kind: 'rejected', errorClass: 'unsupported', detail: 'Unknown trusted browser recipe' });
    }) } } : {}),
  };
}
export { createSocialSession } from './session';
export type { AccountBinding, RuntimePlacement } from './runtime';
export type { BrowserRecipe, RecipeStep } from './recipes';

export type { MediaPolicy } from './media';

export { canonicalSocialProfile, PLATFORM_ORIGINS } from './platforms';
export { inspectSignedInPage, LOGIN_IDENTITY_SELECTORS, type BrowserLoginIdentity } from './login-inspection';
