/** Document jobs freeze detected navigation/draft triggers independently from provider outreach approvals. */
export const SCHEMA_0016 = `
CREATE TABLE document_jobs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), package_id TEXT NOT NULL REFERENCES work_packages(id),
 source_hash TEXT NOT NULL, name TEXT NOT NULL, selected_action_ids TEXT NOT NULL, actions TEXT NOT NULL,
 action_hash TEXT NOT NULL, scheduled_for INTEGER, timezone TEXT NOT NULL,
 execution_intent TEXT NOT NULL DEFAULT 'automatic' CHECK(execution_intent='automatic'),
 status TEXT NOT NULL CHECK(status IN ('draft','paused','scheduled','running','completed','needs_attention','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1, results TEXT NOT NULL DEFAULT '[]', detail TEXT,
 lease_token TEXT, lease_expires_at INTEGER, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(workspace_id,idempotency_key)
) STRICT;
CREATE INDEX document_jobs_due ON document_jobs(status,scheduled_for,id);
CREATE INDEX document_jobs_package ON document_jobs(workspace_id,package_id,created_at,id);
CREATE TABLE document_job_runs (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES document_jobs(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 job_revision INTEGER NOT NULL, status TEXT NOT NULL, results TEXT NOT NULL DEFAULT '[]', detail TEXT,
 started_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE INDEX document_job_runs_job ON document_job_runs(workspace_id,job_id,started_at,id);
`;
