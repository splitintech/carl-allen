/* global window, setTimeout, clearTimeout */
import { el, button, modal } from './utils.js';
import { api } from './service.js';
import { receiptSummary } from './work-package-state.js';
import { showPackage } from './work-package-review.js';
import { documentJobPanel } from './document-job-panel.js';

export function showDocumentWorkspace(initialPack, data, refresh) {
  let pack = initialPack; let document; let active = true; let activeActionId; let ready = false; let awaitingReady = false; let readinessTimer; let requestGeneration = 0; const selected = new Set();
  const m = modal(pack.name || 'Uploaded document', 'File workspace · document, detected triggers and background jobs'); m.dialog.classList.add('document-workspace-dialog');
  const layout = el('div', { class: 'document-workspace' });
  const loading = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite', text: 'Loading your uploaded document in the background…' });
  const sourceState = el('small', { class: 'field-help', text: receiptSummary(pack) });
  const transfer = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite', hidden: '' });
  const makeFrame = () => el('iframe', { class: 'document-preview-frame', title: `Original document: ${pack.name}`, sandbox: 'allow-scripts', referrerpolicy: 'no-referrer' });
  let frame = makeFrame(); frame.hidden = true;
  const omissions = el('details', { class: 'document-preview-omissions', hidden: '' }, el('summary', { class: 'field-help', text: 'Preview changes' }));
  const preview = el('section', { class: 'document-preview-pane', 'aria-label': 'Original uploaded file' }, el('div', { class: 'document-preview-heading' }, el('div', {}, el('h3', { text: 'Your original file' }), sourceState), button('Reload file', () => loadDocument(), 'small')), loading, transfer, frame, el('p', { class: 'field-help', text: 'The file stays inside Carl-Allen. Select a highlighted link or a detected trigger beside it to inspect its behavior. This does not navigate away or send anything.' }), omissions);
  const summary = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
  const triggers = el('div', { class: 'document-trigger-list' }); const detail = el('div', { class: 'document-trigger-detail', 'aria-live': 'polite' });
  const sidebar = el('aside', { class: 'document-workspace-sidebar', 'aria-label': 'Document triggers and schedule' }, el('section', { class: 'info-card stack' }, el('div', {}, el('h3', { text: 'Detected triggers' }), summary, el('p', { class: 'field-help', text: 'Inspect a trigger, then explicitly include it in the background job.' })), triggers, detail));
  const jobs = documentJobPanel(pack, data, { getSelected: () => [...selected], getSourceHash: () => document?.sourceHash || pack.cloudReceipt?.sourceHash || '' }); sidebar.append(jobs.root);
  const execution = button('Execution plan', () => { m.close(); showPackage(pack, data, refresh); }, 'small'); execution.setAttribute('aria-label', 'Review execution plan');
  layout.append(preview, sidebar); m.content.append(layout); m.bottom.append(button('Close file', m.close), execution, button('Set up job', () => jobs.focusSchedule(), 'primary'));
  const actions = () => document?.actions || pack.extractedActions || [];
  function inspect(actionId) {
    const action = actions().find((item) => item.id === actionId); if (!action) return; activeActionId = actionId;
    for (const control of triggers.querySelectorAll('[data-inspect-action]')) control.setAttribute('aria-pressed', String(control.dataset.inspectAction === actionId));
    detail.replaceChildren(el('h4', { text: action.label }), el('p', { text: action.kind === 'open_url' ? 'Open this page in the isolated background worker.' : action.kind === 'compose_email' ? 'Save this email draft inside Carl-Allen when the job runs.' : action.reason || 'This interaction cannot run automatically.' }));
    if (action.href) detail.append(el('p', { class: 'document-trigger-destination', text: action.href }));
    if (action.email) for (const [name, value] of [['To', action.email.to?.join(', ')], ['Cc', action.email.cc?.join(', ')], ['Bcc', action.email.bcc?.join(', ')], ['Subject', action.email.subject], ['Message', action.email.body]]) if (value) detail.append(el('p', { text: `${name}: ${value}` }));
    detail.append(el('small', { text: selected.has(action.id) ? 'Included in the next job you save.' : 'Inspection does not include this trigger in a job.' }));
  }
  function drawTriggers() {
    const all = actions(); const supported = all.filter((action) => action.kind !== 'unsupported');
    summary.textContent = `${supported.length} supported · ${all.length - supported.length} unsupported`;
    triggers.replaceChildren();
    for (const action of all) {
      const include = el('input', { type: 'checkbox', checked: selected.has(action.id), disabled: action.kind === 'unsupported', 'aria-label': `Include trigger ${action.label}` });
      include.addEventListener('change', () => { if (include.checked) selected.add(action.id); else selected.delete(action.id); jobs.updateSelection(); if (activeActionId === action.id) inspect(action.id); });
      const inspectButton = button(action.label || 'HTML trigger', () => inspect(action.id), 'small'); inspectButton.dataset.inspectAction = action.id; inspectButton.setAttribute('aria-label', `Inspect trigger ${action.label}`); inspectButton.setAttribute('aria-pressed', String(activeActionId === action.id));
      triggers.append(el('article', { class: `document-trigger-row ${action.kind === 'unsupported' ? 'unsupported' : ''}` }, include, el('div', {}, inspectButton, el('small', { text: action.kind === 'unsupported' ? action.reason : action.kind === 'compose_email' ? 'In-app email draft' : 'Background page' }))));
    }
    if (!all.length) triggers.append(el('p', { class: 'field-help', text: 'No triggers have been detected in this file.' }));
    if (activeActionId && all.some((action) => action.id === activeActionId)) inspect(activeActionId); else detail.replaceChildren(el('p', { class: 'field-help', text: 'Select a detected trigger or a supported control in the document to inspect it here.' }));
    jobs.updateSelection();
  }
  const receive = (event) => {
    const value = event.data;
    if (!active || !document || event.source !== frame.contentWindow || event.origin !== 'null' || value?.sourceHash !== document.sourceHash) return;
    if (value.type === 'carl-allen-document-ready') {
      if (!awaitingReady) return;
      clearTimeout(readinessTimer); awaitingReady = false; ready = true;
      loading.className = 'field-help'; loading.textContent = 'Original file open inside Carl-Allen. Uploaded scripts and external resources remain inactive.'; jobs.setReady(true); return;
    }
    if (!ready || value.type !== 'carl-allen-document-action' || typeof value.actionId !== 'string' || !document.boundActionIds?.includes(value.actionId)) return;
    inspect(value.actionId);
  };
  window.addEventListener('message', receive);
  async function loadDocument() {
    const generation = ++requestGeneration; clearTimeout(readinessTimer); awaitingReady = false; ready = false; document = undefined;
    jobs.setReady(false); loading.textContent = 'Loading your uploaded document in the background…'; loading.className = 'field-help'; frame.hidden = true; frame.srcdoc = '';
    try {
      const value = await api('work-package-document', { packageId: pack.id }); if (!active || generation !== requestGeneration) return;
      const next = value.document;
      if (!next || next.packageId !== pack.id || typeof next.html !== 'string' || !/^[a-f0-9]{64}$/.test(next.sourceHash || '') || pack.cloudReceipt?.sourceHash && pack.cloudReceipt.sourceHash !== next.sourceHash || next.policy?.sandbox !== 'allow-scripts' || next.policy?.messageType !== 'carl-allen-document-action' || next.policy?.readyMessageType !== 'carl-allen-document-ready') throw new Error('The stored file could not be matched to this upload. Reload or re-upload the original document.');
      document = next; const known = new Set(next.actions.filter((action) => action.kind !== 'unsupported').map((action) => action.id)); for (const id of selected) if (!known.has(id)) selected.delete(id);
      awaitingReady = true; readinessTimer = setTimeout(() => {
        if (!active || generation !== requestGeneration || !awaitingReady) return;
        awaitingReady = false; ready = false; loading.className = 'validation-errors'; loading.textContent = 'The file preview did not initialize its trusted controls. Choose Reload file to retry. Scheduling remains unavailable.'; jobs.setReady(false, 'Reload the original file before saving or scheduling a job.');
      }, 12000);
      // A new browsing context avoids racing a previous blank srcdoc navigation
      // and makes readiness messages belong to exactly one document load.
      const nextFrame = makeFrame(); nextFrame.srcdoc = next.html;
      frame.replaceWith(nextFrame); frame = nextFrame; loading.textContent = 'Opening your original file. Waiting for its controls to initialize…';
      omissions.replaceChildren(el('summary', { class: 'field-help', text: 'Preview changes' }), ...(next.omissions || []).map((omission) => el('p', { class: 'field-help', text: omission.message })));
      omissions.hidden = !next.omissions?.length; drawTriggers();
    } catch (error) { if (!active || generation !== requestGeneration) return; clearTimeout(readinessTimer); awaitingReady = false; ready = false; document = undefined; loading.className = 'validation-errors'; loading.textContent = `The original file could not open: ${error.message}`; jobs.setReady(false, 'Reload the original file before saving or scheduling a job.'); }
  }
  m.dialog.addEventListener('close', () => { active = false; requestGeneration++; clearTimeout(readinessTimer); awaitingReady = false; ready = false; window.removeEventListener('message', receive); jobs.stop(); frame.srcdoc = ''; });
  drawTriggers(); void loadDocument();
  return { updatePackage(value) { pack = value; sourceState.textContent = receiptSummary(value); if (!document) drawTriggers(); }, setTransferState(text, failed = false) { transfer.hidden = !text; transfer.textContent = text; transfer.className = failed ? 'validation-errors' : 'field-help'; } };
}
