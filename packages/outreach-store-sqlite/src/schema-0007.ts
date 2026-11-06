/** Private publishing workspace and immutable content-addressed media. */
export const SCHEMA_0007 = `
CREATE TABLE publishing_uploads (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0, next_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, completed_asset_id TEXT
) STRICT;
CREATE INDEX publishing_uploads_workspace ON publishing_uploads(workspace_id);
CREATE TABLE publishing_media (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(workspace_id,sha256)
) STRICT;
CREATE INDEX publishing_media_workspace ON publishing_media(workspace_id,created_at);
CREATE TABLE publishing_drafts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, timezone TEXT NOT NULL, scheduled_for TEXT NOT NULL,
  posts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  action_ids TEXT NOT NULL DEFAULT '[]', blocked TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX publishing_drafts_workspace ON publishing_drafts(workspace_id,updated_at);
`;
