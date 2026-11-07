/** Freeze non-payload execution fields separately from worker-owned retry/deferral times.
 * Existing experimental plan rows lack a full snapshot and require fresh approval; legacy
 * action/campaign approvals are unchanged. No historical approval is silently widened.
 */
export const SCHEMA_0011 = `
ALTER TABLE plan_actions ADD COLUMN provider_account_id TEXT;
ALTER TABLE plan_actions ADD COLUMN recipient_norm TEXT;
ALTER TABLE plan_actions ADD COLUMN action_kind TEXT;
ALTER TABLE plan_actions ADD COLUMN purpose TEXT;
ALTER TABLE plan_actions ADD COLUMN approved_not_after INTEGER;
ALTER TABLE plan_actions ADD COLUMN execution_due_at INTEGER;
`;
