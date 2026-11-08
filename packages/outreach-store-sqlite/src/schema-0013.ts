export const SCHEMA_0013 = `
CREATE TABLE social_login_sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), principal_id TEXT NOT NULL REFERENCES principals(id),
 channel TEXT NOT NULL, connection_key TEXT NOT NULL, binding_key TEXT NOT NULL, account_id TEXT REFERENCES provider_accounts(id),
 lease_id TEXT, identity TEXT, status TEXT NOT NULL DEFAULT 'awaiting_login', detail TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX social_logins_owner ON social_login_sessions(workspace_id,principal_id,status,expires_at);
`;
