import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, bootstrapWorkspace, createApiToken, createEngine, type WorkPackage } from '@splitin/outreach-core';
import { staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import type { DocumentJob, DocumentJobRunner, DocumentTriggerResult, HtmlImportAction } from '@splitin/outreach-contracts';
import { createApp } from './app';

const open: ReturnType<typeof openSqliteDatabase>[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); vi.unstubAllEnvs(); });
const receipts = (actions: HtmlImportAction[]): DocumentTriggerResult[] => actions.flatMap<DocumentTriggerResult>((action) => action.kind === 'open_url' ? [{ actionId: action.id, kind: 'open_url', status: 'completed', requestedUrl: action.href, finalUrl: action.href, title: 'Reference', httpStatus: 200 }] : action.kind === 'compose_email' ? [{ actionId: action.id, kind: 'compose_email', status: 'completed', draft: action.email }] : []);
async function fixture(configured = true) {
  vi.stubEnv('OUTREACH_MEDIA_GATEWAY', ''); vi.stubEnv('CLOUD_MEDIA_SECRET', '');
  const db = openSqliteDatabase(':memory:'); open.push(db); let now = Date.UTC(2030, 0, 1);
  const runner = { run: vi.fn<DocumentJobRunner['run']>(async (input) => ({ results: receipts(input.actions) })) };
  const engine = createEngine({ db, adapters: [], secrets: staticSecrets({}), workerId: 'document-api', now: () => now, ...(configured ? { documentJobRunner: runner } : {}) });
  bootstrapWorkspace(db, { workspaceId: 'document-ws', name: 'Document test', adminRef: 'admin', adminName: 'Admin' }, now);
  const ctx = authenticate(db, 'document-ws', 'admin', 'test', 'document-trace');
  const tokens = { admin: createApiToken(engine, ctx, { principalId: ctx.principalId, name: 'Test admin', roleCeiling: 'admin', ttlDays: 1 }).token, viewer: createApiToken(engine, ctx, { principalId: ctx.principalId, name: 'Test viewer', roleCeiling: 'viewer', ttlDays: 1 }).token, other: '' };
  bootstrapWorkspace(db, { workspaceId: 'other', name: 'Other', adminRef: 'other', adminName: 'Other' }, now);
  const other = authenticate(db, 'other', 'other', 'test', 'other-trace'); tokens.other = createApiToken(engine, other, { principalId: other.principalId, name: 'Other', roleCeiling: 'admin', ttlDays: 1 }).token;
  const app = createApp({ engine });
  const request = (path: string, method = 'GET', body?: unknown, role: keyof typeof tokens | 'missing' = 'admin') => app.request(path, { method, headers: { authorization: `Bearer ${role === 'missing' ? '' : tokens[role]}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const html = '<title>Original file</title><style>p{color:red}</style><p>Original content</p><a href="https://example.org/reference">Reference</a><a href="mailto:ada@example.org?subject=Reviewed">Email</a><button onclick="fetch(\'/unsafe\')">Unsupported</button><script>globalThis.originalWasExecuted=true;</script>';
  const imported = await (await request('/v1/work-packages', 'POST', { name: 'original.html', html })).json() as { package: WorkPackage };
  const pack = imported.package;
  const input = { sourceHash: pack.cloudReceipt.sourceHash, selectedActionIds: pack.extractedActions.filter((action) => action.kind !== 'unsupported').map((action) => action.id), scheduledFor: new Date(now + 60000).toISOString(), timezone: 'UTC', idempotencyKey: 'document-api-create' };
  return { db, engine, runner, request, pack, html, input, advance: (ms: number) => { now += ms; } };
}

describe('stored original document and automatic jobs API', () => {
  it('returns an authenticated JSON preview of the original without changing stored source or granting same-origin HTML execution', async () => {
    const f = await fixture(); const before = f.db.prepare('SELECT * FROM work_packages WHERE id=?').get(f.pack.id);
    const response = await f.request(`/v1/work-packages/${f.pack.id}/document`, 'GET', undefined, 'viewer'); expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json'); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const { document } = await response.json() as { document: { packageId: string; sourceHash: string; html: string; boundActionIds: string[]; actions: HtmlImportAction[]; policy: { sandbox: string } } };
    expect(document).toMatchObject({ packageId: f.pack.id, sourceHash: f.pack.cloudReceipt.sourceHash, policy: { sandbox: 'allow-scripts' } });
    expect(document.html).toContain('Original content'); expect(document.html).not.toContain('originalWasExecuted'); expect(document.html).not.toContain('onclick=');
    expect(document.actions.some((action) => action.kind === 'unsupported')).toBe(true); expect(document.boundActionIds.length).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT * FROM work_packages WHERE id=?').get(f.pack.id)).toEqual(before);
    expect((await f.request(`/v1/work-packages/${f.pack.id}/document`, 'GET', undefined, 'other')).status).toBe(404);
    expect((await f.request(`/v1/work-packages/${f.pack.id}/document`, 'GET', undefined, 'missing')).status).toBe(403);
  });
  it('schedules real server-owned work and returns persisted receipts after the worker runs', async () => {
    const f = await fixture(); const response = await f.request(`/v1/work-packages/${f.pack.id}/document-jobs`, 'POST', f.input); expect(response.status).toBe(201);
    const { job } = await response.json() as { job: DocumentJob }; expect(job.status).toBe('scheduled'); expect(job.actions.map((action) => action.kind)).toEqual(['open_url', 'compose_email']);
    const replay = await (await f.request(`/v1/work-packages/${f.pack.id}/document-jobs`, 'POST', f.input)).json() as { job: DocumentJob }; expect(replay.job.id).toBe(job.id);
    f.advance(60000); const pass = await f.engine.runOnce(); expect(pass.documentJobs.completed).toBe(1);
    const fetched = await (await f.request(`/v1/document-jobs/${job.id}`)).json() as { job: DocumentJob }; expect(fetched.job.status).toBe('completed'); expect(fetched.job.results).toEqual(receipts(job.actions));
    const listed = await (await f.request(`/v1/work-packages/${f.pack.id}/document-jobs`, 'GET', undefined, 'viewer')).json() as { jobs: DocumentJob[] }; expect(listed.jobs[0]?.id).toBe(job.id);
    expect(f.runner.run).toHaveBeenCalledTimes(1); expect(f.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 }); expect(f.db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
  });
  it('preserves drafts and pauses, checks optimistic revisions, and scopes all job reads and mutations', async () => {
    const f = await fixture(); const { job } = await (await f.request(`/v1/work-packages/${f.pack.id}/document-jobs`, 'POST', { ...f.input, scheduledFor: null })).json() as { job: DocumentJob }; expect(job.status).toBe('draft');
    const path = `/v1/document-jobs/${job.id}`;
    expect((await f.request(path, 'GET', undefined, 'other')).status).toBe(404);
    expect((await f.request(path, 'PATCH', { expectedRevision: job.revision, cancel: true }, 'viewer')).status).toBe(403);
    expect((await f.request(path, 'PATCH', { expectedRevision: job.revision, cancel: true }, 'other')).status).toBe(404);
    const paused = await (await f.request(path, 'PATCH', { expectedRevision: job.revision, scheduledFor: f.input.scheduledFor, paused: true })).json() as { job: DocumentJob }; expect(paused.job.status).toBe('paused');
    expect((await f.request(path, 'PATCH', { expectedRevision: job.revision, paused: false })).status).toBe(409);
    const cancelled = await (await f.request(path, 'PATCH', { expectedRevision: paused.job.revision, cancel: true })).json() as { job: DocumentJob }; expect(cancelled.job.status).toBe('cancelled');
    f.advance(60000); await f.engine.runOnce(); expect(f.runner.run).not.toHaveBeenCalled();
  });
  it('rejects client-supplied destinations, unsupported selections, changed sources, and viewer scheduling', async () => {
    const f = await fixture(); const path = `/v1/work-packages/${f.pack.id}/document-jobs`;
    expect((await f.request(path, 'POST', { ...f.input, href: 'https://different.example.org' })).status).toBe(400);
    expect((await f.request(path, 'POST', f.input, 'viewer')).status).toBe(403);
    expect((await f.request(path, 'POST', { ...f.input, selectedActionIds: ['missing'] })).status).toBe(409);
    const unsupported = f.pack.extractedActions.find((action) => action.kind === 'unsupported')!;
    expect((await f.request(path, 'POST', { ...f.input, selectedActionIds: [unsupported.id] })).status).toBe(409);
    expect((await f.request(path, 'POST', { ...f.input, sourceHash: '0'.repeat(64) })).status).toBe(409);
    expect(f.db.prepare('SELECT COUNT(*) n FROM document_jobs').get()).toEqual({ n: 0 });
    f.db.prepare('UPDATE work_packages SET original_html=? WHERE id=?').run('<html>changed</html>', f.pack.id);
    expect((await f.request(`/v1/work-packages/${f.pack.id}/document`)).status).toBe(409); expect((await f.request(path, 'POST', f.input)).status).toBe(409);
  });
  it('returns needs_attention when the automatic runner is missing instead of reporting fake scheduling', async () => {
    const f = await fixture(false); const { job } = await (await f.request(`/v1/work-packages/${f.pack.id}/document-jobs`, 'POST', f.input)).json() as { job: DocumentJob };
    expect(job.status).toBe('needs_attention'); expect(job.detail).toContain('not configured'); expect(job.results).toEqual([]);
  });
});
