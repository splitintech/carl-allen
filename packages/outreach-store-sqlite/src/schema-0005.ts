/**
 * Social action kinds + content campaign kind (ADR 0006).
 * SQLite cannot ALTER CHECK constraints in place, so scheduled_actions is rebuilt.
 */
export const SCHEMA_0005 = `
ALTER TABLE campaigns ADD COLUMN campaign_kind TEXT NOT NULL DEFAULT 'outreach'
  CHECK (campaign_kind IN ('outreach','content'));

CREATE TABLE scheduled_actions_0005 (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  enrollment_id TEXT REFERENCES enrollments(id), campaign_id TEXT REFERENCES campaigns(id),
  step_id TEXT, contact_point_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN (
    'email.send','email.reply','notify.publish','manual.task','social.publish','social.message')),
  purpose TEXT, provider_account_id TEXT REFERENCES provider_accounts(id), recipient_norm TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned','awaiting_approval','scheduled','claimed',
    'executing','succeeded','retryable','uncertain','reconciling','failed','cancelled','review')),
  due_at INTEGER NOT NULL, not_after INTEGER,
  payload TEXT NOT NULL, content_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  rfc_message_id TEXT, approval_id TEXT,
  lease_owner TEXT, lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  reconcile_count INTEGER NOT NULL DEFAULT 0,
  last_error_class TEXT, state_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
) STRICT;

INSERT INTO scheduled_actions_0005 SELECT * FROM scheduled_actions;
DROP TABLE scheduled_actions;
ALTER TABLE scheduled_actions_0005 RENAME TO scheduled_actions;
CREATE INDEX ix_actions_due ON scheduled_actions (state, due_at);
CREATE INDEX ix_actions_enrollment ON scheduled_actions (enrollment_id, state);
CREATE INDEX ix_actions_approval ON scheduled_actions (approval_id);
CREATE INDEX ix_actions_kind_due ON scheduled_actions (kind, state, due_at);
`;
