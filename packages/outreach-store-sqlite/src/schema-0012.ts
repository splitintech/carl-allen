/** Optional integrity commitment keeps legacy upload clients compatible. */
export const SCHEMA_0012 = `
ALTER TABLE publishing_uploads ADD COLUMN expected_sha256 TEXT;
CREATE INDEX publishing_upload_hash ON publishing_uploads(workspace_id,expected_sha256,completed_asset_id);
`;
