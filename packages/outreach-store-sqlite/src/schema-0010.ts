/** Durable deletion tombstones serialize remote object cleanup against identical reuploads. */
export const SCHEMA_0010 = `
CREATE TABLE media_deletions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 sha256 TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(workspace_id,sha256)
) STRICT;
`;
