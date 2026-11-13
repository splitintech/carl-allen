import type { HtmlImportAction } from '@splitin/outreach-contracts';
import type { AuthContext, Engine, WorkPackage } from '@splitin/outreach-core';
import { extractWorkPackage } from '@splitin/outreach-import';

const legacyActions = new Map<string, HtmlImportAction[]>();

/** Reconstruct the manual-link inventory for pre-inventory imports without changing their reviewed work. */
export function workPackageView(engine: Engine, ctx: AuthContext, pack: WorkPackage): WorkPackage {
  const row = engine.db.prepare('SELECT original_html,extracted_data FROM work_packages WHERE workspace_id=? AND id=?')
    .get<{ original_html: string; extracted_data: string }>(ctx.workspaceId, pack.id);
  if (!row || Array.isArray((JSON.parse(row.extracted_data) as { actions?: unknown }).actions)) return pack;
  const key = `${ctx.workspaceId}:${pack.cloudReceipt.sourceHash}`;
  let actions = legacyActions.get(key);
  if (!actions) {
    try { actions = extractWorkPackage(row.original_html).actions; }
    catch {
      actions = [{ id: 'legacy-source-review', kind: 'unsupported', label: 'Original HTML interactions', source: 'import', reason: 'The original HTML exceeds the current parser limits. Upload a revised report to inspect its interactions.' }];
    }
    if (legacyActions.size >= 16) legacyActions.delete(legacyActions.keys().next().value!);
    legacyActions.set(key, actions);
  }
  return { ...pack, extractedActions: actions };
}
