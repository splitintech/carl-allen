import { z } from 'zod';
import { buildHtmlDocumentPreview, extractWorkPackage } from '@splitin/outreach-import';
import { ConflictError, createDocumentJob, getDocumentJob, getWorkPackage, listDocumentJobs, requireRole, updateDocumentJob, workPackageOriginal, type AuthContext, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { auth, type ServerEnv } from './app';

const create = z.object({ name: z.string().trim().min(1).max(200).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), selectedActionIds: z.array(z.string().min(1).max(120)).max(20), scheduledFor: z.string().datetime({ offset: true }).nullable(), timezone: z.string().min(1).max(100), paused: z.boolean().optional(), idempotencyKey: z.string().min(1).max(200) }).strict();
const update = z.object({ expectedRevision: z.number().int().min(1), scheduledFor: z.string().datetime({ offset: true }).nullable().optional(), paused: z.boolean().optional(), cancel: z.boolean().optional() }).strict();

function original(engine: Engine, ctx: AuthContext, packageId: string) {
  const pack = getWorkPackage(engine, ctx, packageId); const html = workPackageOriginal(engine, ctx, packageId);
  return { pack, html };
}
export function registerDocumentJobRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/v1/work-packages/:id/document', (c) => {
    const { pack, html } = original(engine, auth(c), c.req.param('id')); const preview = buildHtmlDocumentPreview(html);
    if (preview.sourceHash !== pack.cloudReceipt.sourceHash) throw new ConflictError('The stored original document checksum does not match. Upload a new document revision.');
    return c.json({ document: { packageId: pack.id, name: pack.name, ...preview } });
  });
  app.get('/v1/work-packages/:id/document-jobs', (c) => c.json({ jobs: listDocumentJobs(engine, auth(c), c.req.param('id')) }));
  app.get('/v1/document-jobs/:id', (c) => c.json({ job: getDocumentJob(engine, auth(c), c.req.param('id')) }));
  app.post('/v1/work-packages/:id/document-jobs', async (c) => {
    requireRole(auth(c), 'operator');
    const input = create.parse(await c.req.json()); const { pack, html } = original(engine, auth(c), c.req.param('id'));
    const extracted = extractWorkPackage(html);
    if (extracted.sourceHash !== pack.cloudReceipt.sourceHash || input.sourceHash !== extracted.sourceHash) throw new ConflictError('The document changed. Reopen it before scheduling triggers.');
    const actions = input.selectedActionIds.map((id) => {
      const action = extracted.actions.find((candidate) => candidate.id === id);
      if (!action || action.kind === 'unsupported') throw new ConflictError('Select supported triggers from the stored document');
      return action;
    });
    return c.json({ job: createDocumentJob(engine, auth(c), pack.id, { ...input, actions }) }, 201);
  });
  app.patch('/v1/document-jobs/:id', async (c) => c.json({ job: updateDocumentJob(engine, auth(c), c.req.param('id'), update.parse(await c.req.json())) }));
}
