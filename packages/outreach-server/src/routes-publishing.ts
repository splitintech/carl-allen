import { accountLifecycle, getPublishingDraft, requireRole, publishingActions, PublishingDraftInput, PUBLISHING_LIMITS, appendPublishingChunk, cancelPublishingUpload, completePublishingUploadDurable, deletePublishingDraft, deletePublishingMediaDurable, listApprovals, listPublishingDrafts, listPublishingMedia, readPublishingMediaDurable, retryPublishingMediaDeletions, hasRole, savePublishingDraft, startPublishingUpload, getPublishingUploadStatus, submitPublishingDraft, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';
import {stagePublishingDraftMedia} from '@splitin/outreach-core';
const uploadInput = z.object({ name: z.string().max(240), mime: z.string().max(100), size: z.number().int().positive(), sha256:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const chunk = z.object({ index: z.number().int().nonnegative(), data: z.string().max(87384) }).strict();
export function registerPublishingRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/v1/publishing', (c) => {
    const ctx = auth(c); requireRole(ctx, 'viewer');
    const accounts = engine.db.prepare('SELECT id,provider,external_account_id,sender_identity,purposes,capabilities,health,health_detail FROM provider_accounts WHERE workspace_id=? ORDER BY id').all<{ id: string; provider: string; external_account_id: string; sender_identity: string; purposes: string; capabilities: string; health: string; health_detail: string | null }>(ctx.workspaceId).map((row) => ({ id: row.id, provider: row.provider, externalAccountId: row.external_account_id, sender: JSON.parse(row.sender_identity) as unknown, purposes: JSON.parse(row.purposes) as unknown, capabilities: JSON.parse(row.capabilities) as unknown, health: row.health, detail: row.health_detail, lifecycle:accountLifecycle(engine,ctx.workspaceId,row.id) }));
    const sendingStops = engine.db.prepare("SELECT scope,reason,changed_at AS changedAt FROM kill_switches WHERE engaged=1 AND (scope='global' OR (scope='workspace' AND workspace_id=?)) ORDER BY scope").all<{ scope: string; reason: string; changedAt: number }>(ctx.workspaceId);
    return c.json({ sendingStopped: sendingStops.length > 0, sendingStopScopes: sendingStops.map((s) => s.scope), sendingStops, workspaceId: ctx.workspaceId, roles: ctx.roles, accounts, drafts: listPublishingDrafts(engine, ctx), media: listPublishingMedia(engine, ctx), actions: publishingActions(engine, ctx), approvals: listApprovals(engine.db, ctx), limits: PUBLISHING_LIMITS, liveViewUrl: hasRole(ctx, 'admin') ? process.env.OUTREACH_DAYTONA_LIVE_VIEW_URL ?? null : null });
  });
  app.get('/v1/publishing/actions', (c) => {
    const ctx=auth(c); requireRole(ctx,'viewer');
    const query=z.object({cursor:z.string().default(''),limit:z.coerce.number().int().min(1).max(200).default(100),from:z.coerce.number().default(0),to:z.coerce.number().default(8640000000000000)}).parse(c.req.query());
    const rows=engine.db.prepare("SELECT id FROM scheduled_actions WHERE workspace_id=? AND kind='social.publish' AND id>? AND due_at>=? AND due_at<=? ORDER BY id LIMIT ?").all<{id:string}>(ctx.workspaceId,query.cursor,query.from,query.to,query.limit);
    const ids=new Set(rows.map(x=>x.id));const actions=publishingActions(engine,ctx).filter(x=>ids.has(x.id)).sort((a,b)=>a.id.localeCompare(b.id));
    return c.json({actions,nextCursor:rows.length===query.limit?rows.at(-1)?.id:null});
  });
  app.get('/v1/publishing/drafts', (c) => {
    const ctx=auth(c); requireRole(ctx,'viewer');
    const q=z.object({cursor:z.string().default(''),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(c.req.query());
    const drafts=engine.db.prepare('SELECT id FROM publishing_drafts WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?').all<{id:string}>(ctx.workspaceId,q.cursor,q.limit).map(r=>getPublishingDraft(engine,ctx,r.id));
    return c.json({drafts,nextCursor:drafts.length===q.limit?drafts.at(-1)?.id:null});
  });
  app.post('/v1/publishing/plans', async(c)=>{const draft=savePublishingDraft(engine,auth(c),PublishingDraftInput.parse(await c.req.json()));return c.json({plan:draft,draft},201);});
  app.get('/v1/publishing/plans/:id',(c)=>c.json({plan:getPublishingDraft(engine,auth(c),c.req.param('id'))}));
  app.post('/v1/publishing/drafts', async (c) => c.json({ draft: savePublishingDraft(engine, auth(c), PublishingDraftInput.parse(await c.req.json())) }, 201));
  app.delete('/v1/publishing/drafts/:id', (c) => { deletePublishingDraft(engine, auth(c), c.req.param('id')); return c.json({ deleted: true }); });
  app.post('/v1/publishing/drafts/:id/submit', async(c) => {await stagePublishingDraftMedia(engine,auth(c),c.req.param('id'));return c.json(submitPublishingDraft(engine, auth(c), c.req.param('id'),{planApproval:false}));});
  app.post('/v1/publishing/plans/:id/prepare',async(c)=>{await stagePublishingDraftMedia(engine,auth(c),c.req.param('id'));return c.json(submitPublishingDraft(engine,auth(c),c.req.param('id')));});
  app.post('/v1/publishing/uploads', async (c) => c.json(startPublishingUpload(engine, auth(c), uploadInput.parse(await c.req.json())), 201));
  app.get('/v1/publishing/uploads/:id',(c)=>c.json(getPublishingUploadStatus(engine,auth(c),c.req.param('id'))));
  app.post('/v1/publishing/uploads/:id/chunks', async (c) => { const body = chunk.parse(await c.req.json()); return c.json(appendPublishingChunk(engine, auth(c), c.req.param('id'), body.index, body.data)); });
  app.post('/v1/publishing/uploads/:id/complete', async (c) => c.json({ asset: await completePublishingUploadDurable(engine, auth(c), c.req.param('id')) }));
  app.delete('/v1/publishing/uploads/:id', (c) => { cancelPublishingUpload(engine, auth(c), c.req.param('id')); return c.json({ cancelled: true }); });
  app.get('/v1/publishing/media/:id', async (c) => {
    const range = z.object({ offset: z.coerce.number().int().nonnegative().default(0), length: z.coerce.number().int().min(1).max(PUBLISHING_LIMITS.chunkBytes).default(PUBLISHING_LIMITS.chunkBytes) }).parse({ offset: c.req.query('offset'), length: c.req.query('length') });
    return c.json(await readPublishingMediaDurable(engine, auth(c), c.req.param('id'), range.offset, range.length));
  });
  app.post('/v1/publishing/media-cleanup', async (c) => c.json(await retryPublishingMediaDeletions(engine, auth(c))));
  app.delete('/v1/publishing/media/:id', async (c) => { await deletePublishingMediaDurable(engine, auth(c), c.req.param('id')); return c.json({ deleted: true }); });
}
