import {
  listManualTasks,
  listUpcoming,
  listReview,
  recordManualOutcome,
  resolveReview,
  setEnrollmentState,
  setKillSwitchAs,
  type Engine,
} from '@splitin/outreach-core';
import type { CapabilitySnapshot, ProviderAdapter } from '@splitin/outreach-contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';

const resolution = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sent'), providerMessageId: z.string().min(1).max(500), providerThreadId: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal('not_sent_retry') }).strict(),
  z.object({ kind: z.literal('drop'), reason: z.string().min(1).max(500) }).strict(),
]);

export function registerOperationRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/v1/actions/upcoming', (c) => {
    const hours = z.coerce.number().int().min(1).max(168).default(24).parse(c.req.query('hours') ?? undefined);
    return c.json({ actions: listUpcoming(engine, auth(c), hours) });
  });

  app.get('/v1/tasks', (c) => {
    const status = z.enum(['open', 'done', 'skipped', 'expired']).default('open').parse(c.req.query('status'));
    return c.json({ tasks: listManualTasks(engine, auth(c), status) });
  });

  app.post('/v1/tasks/:id/outcome', async (c) => {
    const body = z.object({ outcome: z.enum(['done', 'skipped']), note: z.string().max(1000).optional() }).strict().parse(await c.req.json());
    recordManualOutcome(engine, auth(c), c.req.param('id'), body.outcome, body.note);
    return c.json({ status: body.outcome });
  });

  app.get('/v1/review', (c) => c.json({ actions: listReview(engine, auth(c)).map(({ payload: _payload, ...row }) => row) }));

  app.post('/v1/review/:id/resolve', async (c) => {
    resolveReview(engine, auth(c), c.req.param('id'), resolution.parse(await c.req.json()));
    return c.json({ resolved: true });
  });

  app.post('/v1/enrollments/:id/:change', async (c) => {
    const change = z.enum(['pause', 'resume', 'stop']).parse(c.req.param('change'));
    const body = z.object({ reason: z.string().min(1).max(500) }).strict().parse(await c.req.json());
    setEnrollmentState(engine, auth(c), c.req.param('id'), change, body.reason);
    return c.json({ change });
  });

  app.post('/v1/kill-switches', async (c) => {
    const body = z
      .object({ scope: z.enum(['global', 'workspace', 'provider_account', 'campaign']), targetId: z.string().min(1).optional(), engaged: z.boolean(), reason: z.string().min(1).max(500) })
      .strict()
      .parse(await c.req.json());
    setKillSwitchAs(engine, auth(c), { scope: body.scope, engaged: body.engaged, reason: body.reason, ...(body.targetId ? { targetId: body.targetId } : {}) });
    return c.json({ scope: body.scope, engaged: body.engaged });
  });

  /** Daytona social session status for the Outreach Console Connections panel (ADR 0006). */
  app.get('/v1/social/status', (c) => {
    const ctx = auth(c);
    const liveViewUrl = process.env.OUTREACH_DAYTONA_LIVE_VIEW_URL ?? null;
    const accounts = engine.db
      .prepare(
        `SELECT id, provider, external_account_id, health, health_detail, capabilities, purposes
         FROM provider_accounts WHERE workspace_id = ? ORDER BY id`,
      )
      .all<{
        id: string;
        provider: string;
        external_account_id: string;
        health: string;
        health_detail: string | null;
        capabilities: string;
        purposes: string;
      }>(ctx.workspaceId);
    const social = accounts
      .map((row) => {
        const caps = JSON.parse(row.capabilities || '{}') as CapabilitySnapshot;
        const adapter = engine.adapters.get(row.provider) as ProviderAdapter | undefined;
        if (!adapter?.social && caps.executionPlacement !== 'daytona-browser') return null;
        return {
          id: row.id,
          provider: row.provider,
          externalAccountId: row.external_account_id,
          health: row.health,
          detail: row.health_detail,
          executionPlacement: caps.executionPlacement ?? null,
          socialPublish: caps.socialPublish === true,
          socialMessage: caps.socialMessage === true,
          purposes: JSON.parse(row.purposes) as string[],
          reconnectNeeded: row.health === 'reauth_required',
        };
      })
      .filter(Boolean);
    return c.json({ liveViewUrl, accounts: social });
  });
}
