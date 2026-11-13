import { digestCanonical, DocumentTriggerResultSchema, HtmlImportAction, sha256Hex, ulid, type DocumentTriggerResult } from '@splitin/outreach-contracts';
import { audit, ConflictError, systemContext } from './auth';
import type { DomainEnv } from './env';
import type { DocumentJobRow } from './document-jobs';

export interface DocumentJobPassReport { started: number; completed: number; needsAttention: number; recovered: number }
const interrupted = 'The previous document run lost its lease. Review it before explicitly rescheduling; it will not retry automatically.';

function recoverExpired(env: DomainEnv): number {
  const expired = env.db.prepare("SELECT * FROM document_jobs WHERE status='running' AND lease_expires_at<=? LIMIT 100").all<DocumentJobRow>(env.now());
  let recovered = 0;
  for (const row of expired) env.db.transaction(() => {
    const changed = env.db.prepare("UPDATE document_jobs SET status='needs_attention',detail=?,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND workspace_id=? AND status='running' AND lease_token=? AND lease_expires_at<=?")
      .run(interrupted, env.now(), row.id, row.workspace_id, row.lease_token, env.now()).changes;
    if (!changed) return;
    recovered++;
    env.db.prepare("UPDATE document_job_runs SET status='needs_attention',detail=?,finished_at=? WHERE id=? AND status='running'").run(interrupted, env.now(), row.lease_token);
    audit(env.db, systemContext(row.workspace_id, ulid(env.now())), env.now(), 'document_job', row.id, 'interrupted', { runId: row.lease_token });
  });
  return recovered;
}
function checkedResults(actions: HtmlImportAction[], output: { results: DocumentTriggerResult[] }): DocumentTriggerResult[] {
  const results = DocumentTriggerResultSchema.array().max(20).parse(output.results);
  if (results.length !== actions.length || new Set(results.map((result) => result.actionId)).size !== actions.length) throw new ConflictError('The document runner did not return one receipt for every selected trigger');
  for (const result of results) {
    const action = actions.find((candidate) => candidate.id === result.actionId);
    if (!action || action.kind !== result.kind) throw new ConflictError('The document runner returned a receipt for an unexpected trigger');
    if (result.kind === 'open_url' && action.kind === 'open_url') {
      if (result.requestedUrl !== action.href) throw new ConflictError('The document runner changed a selected URL');
      if (result.finalUrl) { const url = new URL(result.finalUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ConflictError('The document runner returned an invalid final URL'); }
    }
    if (result.kind === 'compose_email' && action.kind === 'compose_email' && digestCanonical(result.draft) !== digestCanonical(action.email)) throw new ConflictError('The document runner changed a selected email draft');
  }
  return results;
}
async function invoke(env: DomainEnv, row: DocumentJobRow, runId: string, timeoutMs: number): Promise<DocumentTriggerResult[]> {
  const original = env.db.prepare('SELECT original_html,source_hash FROM work_packages WHERE workspace_id=? AND id=?').get<{ original_html: string; source_hash: string }>(row.workspace_id, row.package_id);
  if (!original || original.source_hash !== row.source_hash || sha256Hex(original.original_html) !== row.source_hash) throw new ConflictError('The stored original document does not match this job. Reopen and create a new job.');
  const actions = HtmlImportAction.array().min(1).max(20).parse(JSON.parse(row.actions));
  if (actions.some((action) => action.kind === 'unsupported') || digestCanonical(actions) !== row.action_hash) throw new ConflictError('The selected trigger snapshot is unavailable or changed');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let watcher: ReturnType<typeof setInterval> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Document run timed out. Review the recorded state before rescheduling.')); }, timeoutMs); });
  const cancelled = new Promise<never>((_resolve, reject) => {
    watcher = setInterval(() => {
      try {
        const active = env.db.prepare("SELECT id FROM document_jobs WHERE workspace_id=? AND id=? AND status='running' AND lease_token=?")
          .get(row.workspace_id, row.id, runId);
        if (active) return;
        controller.abort(); reject(new Error('Document job was paused or cancelled while running.'));
      } catch { controller.abort(); reject(new Error('Document job state is unavailable. Review before rescheduling.')); }
    }, 250);
  });
  try {
    const result = await Promise.race([env.documentJobRunner!.run({ jobId: row.id, sourceHash: row.source_hash, html: original.original_html, actions, signal: controller.signal }), deadline, cancelled]);
    return checkedResults(actions, result);
  } finally { if (timer) clearTimeout(timer); if (watcher) clearInterval(watcher); controller.abort(); }
}

/** Executes only immutable navigation/draft snapshots through the configured document runner. No provider outreach is enqueued. */
export async function runDueDocumentJobs(env: DomainEnv, options: { limit?: number; timeoutMs?: number; leaseMs?: number } = {}): Promise<DocumentJobPassReport> {
  const report: DocumentJobPassReport = { started: 0, completed: 0, needsAttention: 0, recovered: recoverExpired(env) };
  const timeoutMs = options.timeoutMs ?? 120000; const leaseMs = Math.max(options.leaseMs ?? 150000, timeoutMs + 1000);
  const rows = env.db.prepare("SELECT * FROM document_jobs WHERE status='scheduled' AND scheduled_for<=? ORDER BY scheduled_for,id LIMIT ?")
    .all<DocumentJobRow>(env.now(), Math.min(3, Math.max(1, options.limit ?? 3)));
  for (const row of rows) {
    if (!env.documentJobRunner) {
      const detail = 'Automatic document runner is not configured. Configure the server, then explicitly reschedule this job.';
      const changed = env.db.prepare("UPDATE document_jobs SET status='needs_attention',detail=?,revision=revision+1,updated_at=? WHERE id=? AND workspace_id=? AND status='scheduled' AND revision=?")
        .run(detail, env.now(), row.id, row.workspace_id, row.revision).changes;
      if (changed) report.needsAttention++;
      continue;
    }
    const runId = ulid(env.now()); const revision = row.revision + 1;
    const claimed = env.db.transaction(() => {
      const changed = env.db.prepare("UPDATE document_jobs SET status='running',detail=NULL,lease_token=?,lease_expires_at=?,revision=?,updated_at=? WHERE id=? AND workspace_id=? AND status='scheduled' AND revision=? AND scheduled_for<=?")
        .run(runId, env.now() + leaseMs, revision, env.now(), row.id, row.workspace_id, row.revision, env.now()).changes;
      if (!changed) return false;
      env.db.prepare('INSERT INTO document_job_runs(id,job_id,workspace_id,job_revision,status,started_at) VALUES (?,?,?,?,?,?)').run(runId, row.id, row.workspace_id, revision, 'running', env.now());
      audit(env.db, systemContext(row.workspace_id, runId), env.now(), 'document_job', row.id, 'started', { runId, sourceHash: row.source_hash, revision });
      return true;
    });
    if (!claimed) continue;
    report.started++;
    let results: DocumentTriggerResult[] = []; let detail: string | null = null;
    try { results = await invoke(env, row, runId, timeoutMs); if (results.some((result) => result.status !== 'completed')) detail = 'Some selected triggers need attention. Review their recorded results.'; }
    catch (error) { detail = error instanceof Error ? error.message.slice(0, 2000) : 'Document runner failed. Review before rescheduling.'; }
    const status = detail ? 'needs_attention' : 'completed';
    env.db.transaction(() => {
      const changed = env.db.prepare('UPDATE document_jobs SET status=?,results=?,detail=?,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND workspace_id=? AND status=? AND revision=? AND lease_token=?')
        .run(status, JSON.stringify(results), detail, env.now(), row.id, row.workspace_id, 'running', revision, runId).changes;
      if (changed) {
        env.db.prepare('UPDATE document_job_runs SET status=?,results=?,detail=?,finished_at=? WHERE id=?').run(status, JSON.stringify(results), detail, env.now(), runId);
        audit(env.db, systemContext(row.workspace_id, runId), env.now(), 'document_job', row.id, status, { runId, resultCount: results.length });
        if (status === 'completed') report.completed++; else report.needsAttention++;
      } else {
        // Pause/cancel/recovery won the race. Preserve actual port receipts in history without reviving the job.
        env.db.prepare('UPDATE document_job_runs SET results=?,finished_at=COALESCE(finished_at,?) WHERE id=?').run(JSON.stringify(results), env.now(), runId);
      }
    });
  }
  return report;
}
