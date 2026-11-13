import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, WorkPackageManifest, type DocumentJobRunner, type DocumentTriggerResult, type HtmlImportAction } from '@splitin/outreach-contracts';
import { makeDomainEnv } from './domain.test-util';
import { storeWorkPackage } from './work-packages';
import { createDocumentJob, getDocumentJob, listDocumentJobs, updateDocumentJob } from './document-jobs';
import { runDueDocumentJobs } from './document-job-worker';
import { accountLifecycle, disableProviderAccount } from './account-lifecycle';

const open: Awaited<ReturnType<typeof makeDomainEnv>>[] = [];
afterEach(() => { for (const env of open.splice(0)) env.engine.db.close(); });
const actions: HtmlImportAction[] = [
  { id: 'link', kind: 'open_url', label: 'Reference', href: 'https://example.org/reference', source: 'anchor' },
  { id: 'mail', kind: 'compose_email', label: 'Email draft', href: 'mailto:ada@example.org?subject=Reviewed', source: 'anchor', email: { to: ['ada@example.org'], cc: [], bcc: [], subject: 'Reviewed' } },
];
const resultsFor = (selected: HtmlImportAction[]): DocumentTriggerResult[] => selected.flatMap<DocumentTriggerResult>((action) => action.kind === 'open_url'
  ? [{ actionId: action.id, kind: 'open_url', status: 'completed', requestedUrl: action.href, finalUrl: action.href, title: 'Reference', httpStatus: 200 }]
  : action.kind === 'compose_email' ? [{ actionId: action.id, kind: 'compose_email', status: 'completed', draft: action.email }] : []);
async function fixture(runner?: DocumentJobRunner) {
  const env = await makeDomainEnv({ ...(runner ? { documentJobRunner: runner } : {}) }); open.push(env);
  const html = '<a href="https://example.org/reference">Reference</a><a href="mailto:ada@example.org?subject=Reviewed">Email draft</a>';
  const manifest = WorkPackageManifest.parse({ schemaVersion: 1, packageId: 'document-job-fixture', revision: 1, name: 'Original file' });
  const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html, manifest, actions, issues: [], sourceHash: sha256Hex(html) });
  const input = { sourceHash: pack.cloudReceipt.sourceHash, selectedActionIds: actions.map((action) => action.id), actions, scheduledFor: new Date(env.now() + 60000).toISOString(), timezone: 'UTC', idempotencyKey: 'fixture-create' };
  return { env, pack, input };
}
function fakeRunner() { return { run: vi.fn<DocumentJobRunner['run']>(async (input) => ({ results: resultsFor(input.actions) })) }; }

describe('durable automatic document jobs', () => {
  it('persists drafts/pauses and reports missing configuration without pretending a job is scheduled', async () => {
    const { env, pack, input } = await fixture();
    const draft = createDocumentJob(env.engine, env.operator, pack.id, { ...input, scheduledFor: null }); expect(draft.status).toBe('draft');
    expect(draft.actions).toEqual(actions); expect(draft.sourceHash).toBe(pack.cloudReceipt.sourceHash);
    const held = createDocumentJob(env.engine, env.operator, pack.id, { ...input, paused: true, idempotencyKey: 'paused' }); expect(held.status).toBe('paused');
    const missing = createDocumentJob(env.engine, env.operator, pack.id, { ...input, idempotencyKey: 'missing' }); expect(missing.status).toBe('needs_attention'); expect(missing.detail).toContain('not configured');
    expect(listDocumentJobs(env.engine, env.viewer, pack.id)).toHaveLength(3);
    expect(env.engine.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 });
  });
  it('freezes the selected source/actions and makes exact create retries idempotent', async () => {
    const runner = fakeRunner(); const { env, pack, input } = await fixture(runner);
    const first = createDocumentJob(env.engine, env.operator, pack.id, input); expect(first.status).toBe('scheduled');
    expect(createDocumentJob(env.engine, env.operator, pack.id, input).id).toBe(first.id);
    env.advance(60001); expect(createDocumentJob(env.engine, env.operator, pack.id, input).id).toBe(first.id);
    expect(() => createDocumentJob(env.engine, env.operator, pack.id, { ...input, name: 'Different' })).toThrow('different settings');
    expect(() => createDocumentJob(env.engine, env.operator, pack.id, { ...input, sourceHash: '0'.repeat(64), idempotencyKey: 'wrong-source' })).toThrow('document changed');
    expect(() => createDocumentJob(env.engine, env.operator, pack.id, { ...input, selectedActionIds: ['unknown'], idempotencyKey: 'wrong-action' })).toThrow('supported triggers');
    expect(() => createDocumentJob(env.engine, env.operator, pack.id, { ...input, scheduledFor: new Date(env.now() - 1).toISOString(), idempotencyKey: 'past' })).toThrow('future');
    expect(runner.run).not.toHaveBeenCalled();
  });
  it('actually drains a due job through Engine.runOnce and records navigation/draft receipts without provider sends', async () => {
    const runner = fakeRunner(); const { env, pack, input } = await fixture(runner);
    const job = createDocumentJob(env.engine, env.operator, pack.id, input);
    expect((await env.engine.runOnce()).documentJobs.started).toBe(0); env.advance(60000);
    const report = await env.engine.runOnce(); expect(report.documentJobs).toMatchObject({ started: 1, completed: 1, needsAttention: 0 });
    const completed = getDocumentJob(env.engine, env.viewer, job.id); expect(completed.status).toBe('completed'); expect(completed.results).toEqual(resultsFor(actions));
    expect(runner.run).toHaveBeenCalledTimes(1); expect(runner.run.mock.calls[0]?.[0]).toMatchObject({ jobId: job.id, sourceHash: input.sourceHash, actions });
    expect(env.engine.db.prepare('SELECT status FROM document_job_runs').get()).toEqual({ status: 'completed' });
    expect(env.engine.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 }); expect(env.fake.sendCalls).toBe(0); expect(env.social.deliveries).toEqual([]);
    await env.engine.runOnce(); expect(runner.run).toHaveBeenCalledTimes(1);
  });
  it('uses optimistic revisions and pause/cancel state without silently reusing a past schedule', async () => {
    const runner = fakeRunner(); const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input);
    const paused = updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: job.revision, paused: true }); expect(paused.status).toBe('paused');
    expect(() => updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: job.revision, paused: false })).toThrow('changed');
    env.advance(60000); await runDueDocumentJobs(env.engine); expect(runner.run).not.toHaveBeenCalled();
    expect(() => updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: paused.revision, paused: false })).toThrow('future');
    const resumed = updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: paused.revision, paused: false, scheduledFor: new Date(env.now() + 60000).toISOString() }); expect(resumed.status).toBe('scheduled');
    const cancelled = updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: resumed.revision, cancel: true }); expect(cancelled.status).toBe('cancelled');
    expect(() => updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: cancelled.revision, paused: false })).toThrow('cancelled');
  });
  it('does not revive or overwrite a job cancelled while its runner is in flight', async () => {
    let release!: (value: { results: DocumentTriggerResult[] }) => void;
    const runner = { run: vi.fn<DocumentJobRunner['run']>(() => new Promise((resolve) => { release = resolve; })) };
    const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input); env.advance(60000);
    const pending = runDueDocumentJobs(env.engine); await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    const running = getDocumentJob(env.engine, env.viewer, job.id); expect(running.status).toBe('running');
    updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: running.revision, cancel: true });
    release({ results: resultsFor(actions) }); await pending;
    const cancelled = getDocumentJob(env.engine, env.viewer, job.id); expect(cancelled.status).toBe('cancelled'); expect(cancelled.results).toEqual([]);
    const receipt = env.engine.db.prepare('SELECT status,results FROM document_job_runs').get<{ status: string; results: string }>()!;
    expect(receipt.status).toBe('cancelled'); expect(JSON.parse(receipt.results)).toEqual(resultsFor(actions));
  });
  it('signals a paused runner across persisted state changes before accepting any more results', async () => {
    let signal: AbortSignal | undefined;
    const runner = { run: vi.fn<DocumentJobRunner['run']>(async (input) => { signal = input.signal; return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('Aborted')))); }) };
    const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input); env.advance(60000);
    const pending = runDueDocumentJobs(env.engine); await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    const running = getDocumentJob(env.engine, env.viewer, job.id);
    updateDocumentJob(env.engine, env.operator, job.id, { expectedRevision: running.revision, paused: true });
    await pending; expect(signal?.aborted).toBe(true); expect(getDocumentJob(env.engine, env.viewer, job.id).status).toBe('paused');
  });
  it('keeps provider outreach paused while independently preparing document navigation and in-app drafts', async () => {
    const runner = fakeRunner(); const { env, pack, input } = await fixture(runner);
    disableProviderAccount(env.engine, env.admin, env.accountId, { reason: 'Keep outreach paused', profilePolicy: 'retain' });
    const before = accountLifecycle(env.engine, 'ws', env.accountId);
    const job = createDocumentJob(env.engine, env.operator, pack.id, input); env.advance(60000); await env.engine.runOnce();
    expect(getDocumentJob(env.engine, env.viewer, job.id).status).toBe('completed'); expect(accountLifecycle(env.engine, 'ws', env.accountId)).toEqual(before);
    expect(env.fake.sendCalls).toBe(0); expect(env.social.deliveries).toEqual([]);
  });
  it.each(['throw', 'missing-receipts', 'wrong-url', 'changed-draft'])('requires attention after %s and never blindly retries', async (failure) => {
    const runner = fakeRunner(); runner.run.mockImplementationOnce(async (input) => {
      if (failure === 'throw') throw new Error('Explicit runner failure');
      const results = resultsFor(input.actions);
      if (failure === 'missing-receipts') return { results: [] };
      if (failure === 'wrong-url' && results[0]?.kind === 'open_url') results[0].requestedUrl = 'https://different.example.org/';
      if (failure === 'changed-draft' && results[1]?.kind === 'compose_email') results[1].draft = { to: ['different@example.org'], cc: [], bcc: [] };
      return { results };
    });
    const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input); env.advance(60000);
    await runDueDocumentJobs(env.engine); const failed = getDocumentJob(env.engine, env.viewer, job.id);
    expect(failed.status).toBe('needs_attention'); expect(failed.detail).toBeTruthy(); await runDueDocumentJobs(env.engine); expect(runner.run).toHaveBeenCalledTimes(1);
  });
  it('parks expired leases for review without calling the runner again', async () => {
    const runner = fakeRunner(); const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input);
    env.engine.db.prepare("UPDATE document_jobs SET status='running',lease_token='expired-run',lease_expires_at=?,revision=2 WHERE id=?").run(env.now() - 1, job.id);
    env.engine.db.prepare("INSERT INTO document_job_runs(id,job_id,workspace_id,job_revision,status,started_at) VALUES ('expired-run',?,'ws',2,'running',?)").run(job.id, env.now() - 1000);
    expect((await runDueDocumentJobs(env.engine)).recovered).toBe(1); expect(getDocumentJob(env.engine, env.viewer, job.id).status).toBe('needs_attention'); expect(runner.run).not.toHaveBeenCalled();
  });
  it('rejects source tampering before runner invocation and scopes jobs to their workspace', async () => {
    const runner = fakeRunner(); const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input);
    expect(() => getDocumentJob(env.engine, { ...env.viewer, workspaceId: 'other' }, job.id)).toThrow('not found');
    expect(() => updateDocumentJob(env.engine, { ...env.operator, workspaceId: 'other' }, job.id, { expectedRevision: job.revision, cancel: true })).toThrow('not found');
    env.engine.db.prepare('UPDATE work_packages SET original_html=? WHERE id=?').run('<html>changed</html>', pack.id); env.advance(60000);
    await runDueDocumentJobs(env.engine); expect(getDocumentJob(env.engine, env.viewer, job.id).detail).toContain('does not match'); expect(runner.run).not.toHaveBeenCalled();
  });
  it('marks a timed-out runner for attention instead of claiming completion', async () => {
    let signal: AbortSignal | undefined;
    const runner = { run: vi.fn<DocumentJobRunner['run']>(async (input) => { signal = input.signal; return new Promise(() => {}); }) };
    const { env, pack, input } = await fixture(runner); const job = createDocumentJob(env.engine, env.operator, pack.id, input); env.advance(60000);
    await runDueDocumentJobs(env.engine, { timeoutMs: 10 }); expect(signal?.aborted).toBe(true); expect(getDocumentJob(env.engine, env.viewer, job.id).status).toBe('needs_attention');
  });
});
