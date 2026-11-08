/** OAuth secrets and upload bytes live only in owner-only files; SQL retains scoped workflow metadata. */
export const SCHEMA_0014 = `
CREATE TABLE mailbox_oauth_sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal_id TEXT NOT NULL REFERENCES principals(id),
 provider TEXT NOT NULL, region TEXT NOT NULL, reconnect_account_id TEXT REFERENCES provider_accounts(id),
 state_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, detail TEXT, account_id TEXT REFERENCES provider_accounts(id),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX mailbox_oauth_owner ON mailbox_oauth_sessions(workspace_id,principal_id,status,expires_at);
CREATE TABLE mailbox_attachment_uploads (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal_id TEXT NOT NULL REFERENCES principals(id),
 account_id TEXT NOT NULL REFERENCES provider_accounts(id), name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
 sha256 TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0, next_index INTEGER NOT NULL DEFAULT 0, native_ref TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
`;
