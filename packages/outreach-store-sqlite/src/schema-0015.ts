/** Account lifecycle is independent of provider health; a successful health poll cannot reconnect it. */
export const SCHEMA_0015 = `
CREATE TABLE provider_account_lifecycle (
 account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 status TEXT NOT NULL CHECK(status IN ('disabled','disconnected')),
 reason TEXT NOT NULL, disabled_at INTEGER NOT NULL,
 profile_policy TEXT NOT NULL CHECK(profile_policy IN ('retain','delete'))
) STRICT;
CREATE INDEX account_lifecycle_workspace ON provider_account_lifecycle(workspace_id,status);
`;
