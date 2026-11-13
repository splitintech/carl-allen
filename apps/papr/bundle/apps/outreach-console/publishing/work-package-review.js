import { el, button, modal, busy, dateText } from './utils.js';
import { api } from './service.js';
import { platform } from './model.js';
import { mappingWizard } from './import-mapping.js';
import { rejectExactPlan } from './review.js';
import { issueText, splitIssues, receiptSummary } from './work-package-state.js';
import { renderHtmlActions, personTile, sourceLink } from './work-package-links.js';
import { scheduleEditor } from './work-package-schedule.js';
import { packageMappings } from './work-package-mapping.js';

const canEdit = (data) => data.roles?.some((role) => ['admin', 'operator', 'approver'].includes(role));
const canApprove = (data) => data.roles?.some((role) => ['admin', 'approver'].includes(role));
export const manifestFor = (pack) => pack.manifest || { schemaVersion: 1, packageId: pack.externalId || pack.id, revision: pack.revision || 1, name: pack.name, timezone: 'America/New_York', accountRefs: [], contacts: [], media: [], publishingPlans: [], outreachSequences: [], replyPlaybooks: [] };

function issuePanel(title, issues, blocking) {
  return issues.length ? el('section', { class: blocking ? 'banner error' : 'info-card import-notes', ...(blocking ? { role: 'alert' } : {}), 'aria-label': title }, el('strong', { text: title }), el('ul', { class: 'issue-list' }, ...issues.map((issue) => el('li', { text: issueText(issue) })))) : null;
}
function storagePanel(pack) {
  const receipt = pack.cloudReceipt || {};
  const execution = receipt.executionReady ?? receipt.accepted;
  const scheduled = pack.manifest?.publishingPlans?.length || pack.manifest?.outreachSequences?.length || pack.manifest?.replyPlaybooks?.length;
  return el('section', { class: 'info-card package-storage', 'aria-label': 'Handoff status' }, el('h3', { text: receiptSummary(pack) }), el('p', { text: execution ? 'Exact work has been prepared for approval or scheduling. Delivery is confirmed separately.' : scheduled ? 'Execution has not been prepared. Map the intended accounts, choose future times, then review the exact plan.' : 'This report has no scheduled work. Open its supported links and email drafts below.' }), receipt.placement === 'local' ? el('p', { class: 'field-help', text: 'Connect the Daytona workspace before relying on work continuing while your computer is off.' }) : receipt.originalRemoteReady === false ? el('p', { class: 'field-help', text: 'Re-upload the original HTML to complete its cloud file storage before preparing work.' }) : null);
}
function appendManifestSections(content, manifest) {
  const hasPosts = Boolean(manifest.publishingPlans?.length);
  const sections = [
    ['Posts', manifest.publishingPlans || [], (post) => `${platform(post.channel).name} · ${post.accountRef} · ${post.scheduledFor ? dateText(post.scheduledFor, manifest.timezone) : 'Time needed'}\n${post.text || '(Media-only post)'}${post.firstComment ? `\nFirst comment: ${post.firstComment}` : ''}`],
    ['People', manifest.contacts || [], null],
    ['Outreach sequences', manifest.outreachSequences || [], (sequence) => `${sequence.name} · ${sequence.contacts.length} contacts · ${sequence.steps.map((step) => step.kind).join(', ')} · ${sequence.scheduledFor ? dateText(sequence.scheduledFor, manifest.timezone) : 'Start time needed'}`],
    ['Reply playbooks', manifest.replyPlaybooks || [], (rule) => `${rule.channel} · when reply contains “${rule.contains}”\n${rule.text}`],
  ];
  for (const [title, rows, format] of sections) {
    const section = el('details', { ...((title === 'Posts' && hasPosts) || (!hasPosts && ['People', 'Outreach sequences'].includes(title) && rows.length) ? { open: '' } : {}) }, el('summary', { class: 'field-label', text: `${title} · ${rows.length}` }));
    const list = el('div', { class: 'review-list' });
    for (const row of rows) list.append(title === 'People' ? personTile(row) : el('div', { class: 'review-tile' }, el('p', { text: format(row) }), ...(row.sources || []).map((url) => sourceLink(url)).filter(Boolean)));
    section.append(list); content.append(section);
  }
}
export function showPackage(pack, data, refresh) {
  const m = modal(pack.name || 'HTML handoff', `Revision ${pack.revision || 1} · ${pack.status || 'Uploaded'}`);
  const manifest = manifestFor(pack); const content = el('div', { class: 'review-content stack' }); const { blocking, notes } = splitIssues(pack.issues);
  const executable = Boolean(manifest.publishingPlans?.length || manifest.outreachSequences?.length || manifest.replyPlaybooks?.length);
  content.append(el('div', { class: 'steps' }, ...[['1', 'Upload'], ['2', 'Map & schedule'], ['3', 'Review'], ['4', 'Approve']].map(([number, label]) => el('span', { class: 'step-chip' }, el('strong', { text: number }), label))), storagePanel(pack));
  if (blocking.length) content.append(issuePanel('Resolve before preparing', blocking, true));
  if (notes.length) content.append(issuePanel('Import notes', notes, false));
  content.append(renderHtmlActions(pack.extractedActions || []));
  const changedNote = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite', text: 'Account and schedule changes are saved when you choose Save repairs or prepare the plan.' });
  const changed = () => { changedNote.textContent = 'You have unsaved changes. Save repairs or prepare the plan to save them.'; };
  const mappings = packageMappings(manifest, pack, data, refresh, changed); if (mappings.panel) content.append(mappings.panel);
  const schedules = scheduleEditor(manifest, canEdit(data), changed); if (schedules.panel) content.append(schedules.panel);
  if (mappings.panel || schedules.panel) content.append(changedNote);
  if ((pack.tables || pack.extractedTables || pack.extracted?.tables || []).length) content.append(mappingWizard(pack, manifest, data, async (mapped) => {
    const value = await api('work-package-repair', { packageId: pack.id, input: { manifest: schedules.apply(mapped), accountMap: mappings.accountMap, mediaMap: mappings.mediaMap } }); m.close(); await refresh(); showPackage(value.package, data, refresh);
  }));
  appendManifestSections(content, manifest);
  const editor = el('textarea', { class: 'field-control code-field', 'aria-label': 'Repair manifest JSON', name: 'manifest', spellcheck: 'false', autocomplete: 'off', readonly: !canEdit(data) }); editor.value = JSON.stringify(manifest, null, 2); editor.addEventListener('input', changed);
  content.append(el('details', {}, el('summary', { class: 'field-label', text: 'Advanced manifest repair' }), el('p', { class: 'field-help', text: 'Edit missing data or account references. Saving changes invalidates prior approval. Executable scripts and approval claims are not accepted.' }), editor));
  const errors = el('p', { class: 'validation-errors', role: 'alert', hidden: '', tabindex: '-1' }); content.append(errors); m.content.append(content); m.bottom.append(button('Close', m.close));
  const input = (requireFuture = false) => ({ manifest: schedules.apply(JSON.parse(editor.value), requireFuture), accountMap: mappings.accountMap, mediaMap: mappings.mediaMap });
  const run = (control, action) => busy(control, async () => { errors.hidden = true; try { await action(); } catch (error) { errors.textContent = error.message; errors.hidden = false; errors.focus(); } });
  if (canEdit(data)) {
    const save = button('Save repairs', () => run(save, async () => { const value = await api('work-package-repair', { packageId: pack.id, input: input() }); m.close(); await refresh(); showPackage(value.package, data, refresh); })); m.bottom.append(save);
    if (executable) {
      const onlyConnects = !manifest.publishingPlans?.length && !manifest.replyPlaybooks?.length && manifest.outreachSequences?.every((sequence) => sequence.steps.every((step) => step.kind === 'connect'));
      const prepare = button(onlyConnects ? 'Prepare connection requests' : 'Prepare exact plan', () => run(prepare, async () => {
        const repaired = await api('work-package-repair', { packageId: pack.id, input: input(true) }); const value = await api('work-package-prepare', { packageId: repaired.package.id });
        m.close(); await refresh(); if (splitIssues(value.preview?.issues || value.package?.issues).blocking.length) showPackage(value.package, data, refresh); else showPrepared(value, data, refresh);
      }), 'primary'); m.bottom.append(prepare);
    } else content.append(el('p', { class: 'field-help', text: 'This report has no scheduled work. Its supported links and email drafts are ready to open above.' }));
  }
  if (pack.authorizationId && pack.operationHash && canApprove(data) && pack.status === 'awaiting_approval') m.bottom.append(button('Review approval', async () => { const value = await api('work-package-prepare', { packageId: pack.id }); m.close(); showPrepared(value, data, refresh); }, 'primary'));
}
export function showPrepared(value, data, refresh) {
  const m = modal('Approve the exact plan', 'Review the accounts, recipients, content, media and schedules covered by this approval.'); const preview = value.preview || {}; const { blocking, notes } = splitIssues(preview.issues || value.package?.issues);
  const content = el('div', { class: 'review-content stack' }); if (preview.executionWindowUntil) content.append(el('p', { class: 'field-help', text: `Execution window ends ${new Date(preview.executionWindowUntil).toLocaleString()}` }));
  if (blocking.length) content.append(issuePanel('Resolve before approval', blocking, true)); if (notes.length) content.append(issuePanel('Import notes', notes, false));
  for (const [name, rows] of [['Publications', preview.posts || []], ['Recipients', preview.contacts || []], ['Sequences', preview.sequences || []], ['Reply playbooks', preview.replyPlaybooks || []], ['Exact rendered actions', preview.renderedActions || []]]) {
    const section = el('section', { class: 'stack' }, el('h3', { text: `${name} · ${rows.length}` })); for (const row of rows) section.append(name === 'Recipients' ? personTile(row) : el('article', { class: 'review-tile' }, el('p', { text: row.text || row.name || row.subject || row.id || name }), el('small', { text: JSON.stringify(row, null, 2) }))); content.append(section);
  }
  content.append(el('p', { class: 'field-help', text: 'Approved work executes in Daytona subject to login, holds, budgets and delivery checks. Reply playbooks require separate approval in Inbox. Opening a link or composing an email does not approve any scheduled work.' })); m.content.append(content); m.bottom.append(button('Back', m.close));
  if (value.authorizationId && value.operationHash && !blocking.length && canApprove(data)) {
    const approve = button('Approve this exact plan', () => busy(approve, async () => { await api('plan-approve', { authorizationId: value.authorizationId, operationHash: value.operationHash }); m.close(); await refresh(); }), 'primary');
    m.bottom.append(button('Reject this exact plan', () => rejectExactPlan(value.authorizationId, value.operationHash, async () => { m.close(); await refresh(); }), 'danger'), approve);
  } else content.append(el('div', { class: 'banner', text: blocking.length ? 'Resolve the listed issues before an approval can be created.' : 'An approver must sign in to approve this exact plan.' }));
}
