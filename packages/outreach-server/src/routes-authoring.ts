import { registerConfiguredAccount } from './browser-binding';
import { PROVIDER_PURPOSES, OUTREACH_API_VERSION, ulid, type EmailContent, type ProviderContext, type SenderIdentity } from '@splitin/outreach-contracts';
import { audit, checkAccountHealth, refreshAccountCapabilities, findTemplate, createTemplate, createContentCampaign, activateContentCampaign, requireRole, NotFoundError, ForbiddenError, listContentCampaigns, getContentCampaign, updateContentCampaign, deleteContentCampaign, updateScheduledAction, cancelScheduledAction, convertSocialActionToManual, scheduleAction, type Engine, type AuthContext } from '@splitin/outreach-core';
import { z } from 'zod';
import type { Hono } from 'hono';
import { auth, type ServerEnv } from './app';
const address = z.object({ address: z.string().email(), name: z.string().max(200).optional() }).strict();
const mail = z.object({ id: z.string().max(500).optional(), from: address, to: z.array(address).max(100), replyTo: address.optional(), subject: z.string().max(1000), text: z.string().max(100_000), html: z.string().max(200_000).optional(), headers: z.record(z.string(), z.string()).default({}), inReplyTo: z.string().optional(), references: z.array(z.string()).optional(), providerThreadId: z.string().optional() }).strict();
const reason = z.object({ reason: z.string().min(1).max(500) }).strict();

export function accountContext(engine: Engine, ctx: AuthContext, accountId: string): { provider: string; context: ProviderContext } {
  const row = engine.db.prepare('SELECT provider, external_account_id, sender_identity, secret_ref FROM provider_accounts WHERE workspace_id = ? AND id = ?').get<{ provider: string; external_account_id: string; sender_identity: string; secret_ref: string }>(ctx.workspaceId, accountId);
  if (!row) throw new NotFoundError('provider account');
  return { provider: row.provider, context: { workspaceId: ctx.workspaceId, account: { id: accountId, provider: row.provider, externalAccountId: row.external_account_id, sender: JSON.parse(row.sender_identity) as SenderIdentity }, secretRef: row.secret_ref, secrets: engine.exec.secrets, traceId: ctx.traceId, now: engine.now, signal: AbortSignal.timeout(60_000) } };
}
export function registerAuthoringRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.post('/v1/content-compose', async (c) => {
    const ctx = auth(c); requireRole(ctx, 'operator');
    const input = z.object({ name: z.string().min(1).max(200), channel: z.string().min(1).max(40), text: z.string().min(1).max(100_000), mediaUrls: z.array(z.string().url().refine((u) => u.startsWith('https://'), 'media requires HTTPS')).max(4).optional(), providerAccountId: z.string().min(1), scheduledFor: z.string().datetime({ offset: true }), timezone: z.string().default('America/New_York'), activate: z.boolean().default(false), campaignId: z.string().optional(), postId: z.string().optional() }).strict().parse(await c.req.json());
    const result = engine.db.transaction(() => {
      const name = `post-${ulid().toLowerCase()}`;
      const template = createTemplate(engine.db, ctx, { name, channel: input.channel, text: input.text }, engine.now());
      const post = { id: input.postId ?? 'post', providerAccountId: input.providerAccountId, channel: input.channel, template: `${template.name}@${template.version}`, scheduledFor: input.scheduledFor, approval: 'always' as const, ...(input.mediaUrls ? { mediaUrls: input.mediaUrls } : {}) };
      const old = input.campaignId ? getContentCampaign(engine, ctx, input.campaignId) : null;
      const calendar = old ? { ...old.calendar, spec: { ...old.calendar.spec, posts: old.calendar.spec.posts.map((p) => p.id === post.id ? post : p) } } : { apiVersion: OUTREACH_API_VERSION, kind: 'ContentCalendar', metadata: { name }, spec: { purpose: 'social_publishing', policy: { approval: 'every_action', window: { timezone: input.timezone, fallback: input.timezone, days: ['Mon','Tue','Wed','Thu','Fri'], start: '09:30', end: '16:30' }, limits: { accountPerDay: 10, channelPerDay: 10 } }, posts: [post] } };
      if (old && !old.calendar.spec.posts.some((p) => p.id === post.id)) throw new NotFoundError('content post');
      const campaign = input.campaignId ? updateContentCampaign(engine, ctx, input.campaignId, { name: input.name, providerAccountId: old!.providerAccountId, calendar }) : createContentCampaign(engine, ctx, { name: input.name, providerAccountId: input.providerAccountId, calendar });
      if (input.activate) activateContentCampaign(engine, ctx, campaign.campaignId);
      return campaign;
    });
    return c.json(result, 201);
  });
  app.get('/v1/content-campaigns', (c) => c.json({ campaigns: listContentCampaigns(engine, auth(c)).map((campaign) => ({ ...campaign, posts: campaign.calendar.spec.posts.map((post) => ({ ...post, text: findTemplate(engine.db, auth(c).workspaceId, post.template)?.body_text ?? '' })) })) }));
  app.get('/v1/content-campaigns/:id', (c) => c.json(getContentCampaign(engine, auth(c), c.req.param('id'))));
  app.patch('/v1/content-campaigns/:id', async (c) => c.json(updateContentCampaign(engine, auth(c), c.req.param('id'), z.object({ name: z.string().min(1).max(200).optional(), calendar: z.union([z.string().max(100_000), z.record(z.string(), z.unknown())]).optional(), providerAccountId: z.string().optional() }).strict().parse(await c.req.json()))));
  app.delete('/v1/content-campaigns/:id', (c) => { deleteContentCampaign(engine, auth(c), c.req.param('id')); return c.json({ deleted: true }); });
  app.get('/v1/actions/:id', (c) => {
    const ctx = auth(c); requireRole(ctx, 'viewer');
    const row = engine.db.prepare('SELECT id, kind, state, state_reason, provider_account_id, due_at, attempt_count, approval_id, content_hash FROM scheduled_actions WHERE workspace_id = ? AND id = ?').get<{ id: string; kind: string; state: string; state_reason: string|null; provider_account_id:string|null; due_at:number; attempt_count:number; approval_id:string|null; content_hash:string }>(ctx.workspaceId, c.req.param('id'));
    if (!row) throw new NotFoundError('scheduled action');
    const attempts = engine.db.prepare('SELECT attempt_no, outcome, error_class, receipt, started_at, finished_at FROM action_attempts WHERE action_id = ? ORDER BY attempt_no').all<{attempt_no:number;outcome:string;error_class:string|null;receipt:string|null;started_at:number;finished_at:number|null}>(row.id);
    return c.json({ ...row, actionId: row.id, attempts: attempts.map((attempt) => ({ ...attempt, receipt: attempt.receipt ? JSON.parse(attempt.receipt) as unknown : null })) });
  });
  app.patch('/v1/actions/:id', async (c) => c.json(updateScheduledAction(engine, auth(c), c.req.param('id'), z.object({ text: z.string().max(100_000).optional(), mediaUrls: z.array(z.string().url().refine((u) => u.startsWith('https://'))).max(4).optional(), scheduledFor: z.string().datetime({ offset: true }).optional(), input: z.record(z.string(), z.unknown()).optional() }).strict().parse(await c.req.json()))));
  app.post('/v1/actions/:id/cancel', async (c) => { cancelScheduledAction(engine, auth(c), c.req.param('id'), reason.parse(await c.req.json()).reason); return c.json({ cancelled: true }); });
  app.post('/v1/actions/:id/manual', async (c) => c.json(convertSocialActionToManual(engine, auth(c), c.req.param('id'), reason.parse(await c.req.json()).reason)));
  app.post('/v1/actions', async (c) => c.json(scheduleAction(engine, auth(c), z.object({ kind: z.enum(['social.publish', 'social.message', 'social.connect', 'browser.task']), providerAccountId: z.string().min(1), payload: z.record(z.string(), z.unknown()), dueAt: z.number().int().positive().optional(), purpose: z.enum(PROVIDER_PURPOSES).optional(), approval: z.enum(['always', 'none']).optional(), idempotencyKey: z.string().min(1).max(200).optional() }).strict().parse(await c.req.json())), 201));
  app.get('/v1/accounts', (c) => {
    const ctx = auth(c); requireRole(ctx, 'viewer');
    const accounts = engine.db.prepare('SELECT id, provider, external_account_id, sender_identity, purposes, capabilities, health, health_detail FROM provider_accounts WHERE workspace_id = ? ORDER BY id').all<{id:string;provider:string;external_account_id:string;sender_identity:string;purposes:string;capabilities:string;health:string;health_detail:string|null}>(ctx.workspaceId);
    return c.json({ accounts: accounts.map((row) => ({ id: row.id, provider: row.provider, externalAccountId: row.external_account_id, sender: JSON.parse(row.sender_identity) as SenderIdentity, purposes: JSON.parse(row.purposes) as string[], capabilities: JSON.parse(row.capabilities) as unknown, health: row.health, detail: row.health_detail, drafts: !!engine.adapters.get(row.provider)?.drafts })) });
  });
  app.post('/v1/accounts', async (c) => {
    const ctx = auth(c); requireRole(ctx, 'admin');
    const input = z.object({ provider: z.string().min(1), externalAccountId: z.string().min(1), sender: z.object({ name: z.string(), address: z.string().email(), postalAddress: z.string().optional(), organization: z.string().optional() }).strict(), purposes: z.array(z.enum(PROVIDER_PURPOSES)).min(1), secretRef: z.string().min(1), executionPlacement: z.literal('daytona-browser').optional(), profileUrl: z.string().url().optional() }).strict().parse(await c.req.json());
    return c.json({ accountId: await registerConfiguredAccount(engine, ctx, input) }, 201);
  });
  for (const operation of ['check', 'reconnect'] as const) app.post(`/v1/accounts/:id/${operation}`, async (c) => {
    const ctx = auth(c); requireRole(ctx, 'operator');
    accountContext(engine, ctx, c.req.param('id')); // Scope before provider I/O or state mutation.
    await refreshAccountCapabilities(engine, ctx, c.req.param('id'));
    const result = await checkAccountHealth(engine, c.req.param('id'));
    audit(engine.db, ctx, engine.now(), 'provider_account', c.req.param('id'), operation, { status: result.status });
    return c.json({ ...result, liveViewUrl: process.env.OUTREACH_DAYTONA_LIVE_VIEW_URL ?? null });
  });
  const drafts = (ctx: AuthContext, id: string, mutate = false) => {
    requireRole(ctx, mutate ? 'operator' : 'viewer');
    const account = accountContext(engine, ctx, id);
    const port = engine.adapters.get(account.provider)?.drafts;
    if (!port) throw new ForbiddenError('this provider does not support mailbox drafts');
    return { port, context: account.context };
  };
  app.get('/v1/accounts/:id/drafts', async (c) => { const { port, context } = drafts(auth(c), c.req.param('id')); return c.json({ drafts: await port.list(context) }); });
  app.get('/v1/accounts/:id/drafts/:draftId', async (c) => { const { port, context } = drafts(auth(c), c.req.param('id')); return c.json(await port.get(context, c.req.param('draftId'))); });
  app.post('/v1/accounts/:id/drafts', async (c) => {
    const ctx = auth(c); const { port, context } = drafts(ctx, c.req.param('id'), true);
    const input = mail.parse(await c.req.json()) as EmailContent & { id?: string };
    if (input.from.address.toLowerCase() !== context.account.sender.address.toLowerCase()) throw new ForbiddenError('draft sender must match connected account');
    const saved = await port.save(context, input);
    audit(engine.db, ctx, engine.now(), 'mail_draft', saved.id, 'saved', { accountId: context.account.id });
    return c.json(saved);
  });
  app.delete('/v1/accounts/:id/drafts/:draftId', async (c) => {
    const ctx = auth(c); const { port, context } = drafts(ctx, c.req.param('id'), true);
    await port.delete(context, c.req.param('draftId'));
    audit(engine.db, ctx, engine.now(), 'mail_draft', c.req.param('draftId'), 'deleted', { accountId: context.account.id });
    return c.json({ deleted: true });
  });
}
