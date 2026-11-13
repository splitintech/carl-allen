import type { WorkPackageIssue } from '@splitin/outreach-contracts';
import type { AuthContext } from './auth';
import type { DomainEnv } from './env';

/** Older imports used validation issues for successful inference guidance. Only those exact notes are informational. */
export function normalizeWorkPackageIssues(issues: WorkPackageIssue[], hasManifest: boolean): WorkPackageIssue[] {
  return issues.map((issue) => {
    if (issue.severity) return issue;
    const inferred = hasManifest && issue.field === 'manifest' && /^Inferred \d+ LinkedIn profiles from this report\./.test(issue.message);
    const intent = /^intent\./.test(issue.field);
    return { ...issue, severity: inferred || intent ? 'info' : 'error' };
  });
}

export const blockingWorkPackageIssues = (issues: WorkPackageIssue[]) => issues.filter((issue) => issue.severity !== 'info' && issue.severity !== 'warning');
export const workPackageNotes = (issues: WorkPackageIssue[]) => issues.filter((issue) => issue.severity === 'info' || issue.severity === 'warning');

export function workPackageImportIssues(env: DomainEnv, ctx: AuthContext, id: string, fallback: WorkPackageIssue[] = []): WorkPackageIssue[] {
  const row = env.db.prepare('SELECT extracted_data,manifest FROM work_packages WHERE workspace_id=? AND id=?')
    .get<{ extracted_data: string; manifest: string }>(ctx.workspaceId, id);
  if (!row) return [];
  const extracted = JSON.parse(row.extracted_data) as { importIssues?: WorkPackageIssue[] };
  // Legacy rows do not distinguish import errors from subsequently computed validation errors.
  return extracted.importIssues ? normalizeWorkPackageIssues(extracted.importIssues, Boolean(JSON.parse(row.manifest))) : workPackageNotes(fallback);
}
