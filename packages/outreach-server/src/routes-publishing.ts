import { PublishingDraftInput, PUBLISHING_LIMITS, appendPublishingChunk, cancelPublishingUpload, completePublishingUpload, deletePublishingDraft, deletePublishingMedia, listApprovals, listPublishingDrafts, listPublishingMedia, publishingActions, readPublishingMedia, requireRole, savePublishingDraft, startPublishingUpload, submitPublishingDraft, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';
const uploadInput = z.object({ name: z.string().max(240), mime: z.string().max(100), size: z.number().int().positive() }).strict();
const chunk = z.object({ index: z.number().int().nonnegative(), data: z.string().max(87384) }).strict();
export function registerPublishingRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/v1/publishing', (c) => {
    const ctx = auth(c); requireRole(ctx, 'viewer');
    const accounts = engine.db.prepare('SELECT id,provider,external_account_id,sender_identity,purposes,capabilities,health,health_detail FROM provider_accounts WHERE workspace_id=? ORDER BY id').all<{ id: string; provider: string; external_account_id: string; sender_identity: string; purposes: string; capabilities: string; health: string; health_detail: string | null }>(ctx.workspaceId).map((row) => ({ id: row.id, provider: row.provider, externalAccountId: row.external_account_id, sender: JSON.parse(row.sender_identity) as unknown, purposes: JSON.parse(row.purposes) as unknown, capabilities: JSON.parse(row.capabilities) as unknown, health: row.health, detail: row.health_detail }));
    const sendingStops = engine.db.prepare("SELECT scope,reason,changed_at AS changedAt FROM kill_switches WHERE engaged=1 AND (scope='global' OR (scope='workspace' AND workspace_id=?)) ORDER BY scope").all<{ scope: string; reason: string; changedAt: number }>(ctx.workspaceId);
    return c.json({ sendingStopped: sendingStops.length > 0, sendingStopScopes: sendingStops.map((s) => s.scope), sendingStops, workspaceId: ctx.workspaceId, roles: ctx.roles, accounts, drafts: listPublishingDrafts(engine, ctx), media: listPublishingMedia(engine, ctx), actions: publishingActions(engine, ctx), approvals: listApprovals(engine.db, ctx), limits: PUBLISHING_LIMITS, liveViewUrl: process.env.OUTREACH_DAYTONA_LIVE_VIEW_URL ?? null });
  });
  app.post('/v1/publishing/drafts', async (c) => c.json({ draft: savePublishingDraft(engine, auth(c), PublishingDraftInput.parse(await c.req.json())) }, 201));
  app.delete('/v1/publishing/drafts/:id', (c) => { deletePublishingDraft(engine, auth(c), c.req.param('id')); return c.json({ deleted: true }); });
  app.post('/v1/publishing/drafts/:id/submit', (c) => c.json(submitPublishingDraft(engine, auth(c), c.req.param('id'))));
  app.post('/v1/publishing/uploads', async (c) => c.json(startPublishingUpload(engine, auth(c), uploadInput.parse(await c.req.json())), 201));
  app.post('/v1/publishing/uploads/:id/chunks', async (c) => { const body = chunk.parse(await c.req.json()); return c.json(appendPublishingChunk(engine, auth(c), c.req.param('id'), body.index, body.data)); });
  app.post('/v1/publishing/uploads/:id/complete', (c) => c.json({ asset: completePublishingUpload(engine, auth(c), c.req.param('id')) }));
  app.delete('/v1/publishing/uploads/:id', (c) => { cancelPublishingUpload(engine, auth(c), c.req.param('id')); return c.json({ cancelled: true }); });
  app.get('/v1/publishing/media/:id', (c) => {
    const range = z.object({ offset: z.coerce.number().int().nonnegative().default(0), length: z.coerce.number().int().min(1).max(PUBLISHING_LIMITS.chunkBytes).default(PUBLISHING_LIMITS.chunkBytes) }).parse({ offset: c.req.query('offset'), length: c.req.query('length') });
    return c.json(readPublishingMedia(engine, auth(c), c.req.param('id'), range.offset, range.length));
  });
  app.delete('/v1/publishing/media/:id', (c) => { deletePublishingMedia(engine, auth(c), c.req.param('id')); return c.json({ deleted: true }); });
}
