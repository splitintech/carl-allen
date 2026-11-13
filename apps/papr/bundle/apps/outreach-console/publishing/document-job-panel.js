/* global setTimeout, clearTimeout */
import { el, button, field, busy, badge, dateText } from './utils.js';
import { api } from './service.js';
import { zonedISO, scheduleInZone } from './model.js';

const terminal = new Set(['completed', 'cancelled']);
const statusText = (value) => ({ draft: 'Draft', paused: 'Paused', scheduled: 'Scheduled', running: 'Running', completed: 'Completed', succeeded: 'Completed', needs_attention: 'Needs attention', cancelled: 'Cancelled', failed: 'Failed' })[value] || 'Recorded';
function jobBadge(value) { const node = badge(value); node.textContent = statusText(value); return node; }
function draftPreview(draft) {
  const panel = el('div', { class: 'document-email-draft stack' });
  for (const [name, value] of [['To', draft.to?.join(', ')], ['Cc', draft.cc?.join(', ')], ['Bcc', draft.bcc?.join(', ')], ['Subject', draft.subject]]) if (value) panel.append(el('p', { text: `${name}: ${value}` }));
  if (draft.body !== undefined) panel.append(field('Saved email draft', el('textarea', { class: 'field-control', readonly: '', rows: 5, text: draft.body })));
  panel.append(el('small', { text: 'Draft retained inside this job. No email was sent.' })); return panel;
}
function resultsPanel(job) {
  const root = el('details', {}, el('summary', { class: 'field-label', text: `Run results · ${(job.results || []).length}` }));
  for (const result of job.results || []) {
    const action = (job.actions || []).find((item) => item.id === result.actionId);
    const card = el('article', { class: 'review-tile' }, el('h4', { text: action?.label || result.label || result.kind || 'Trigger result' }), jobBadge(result.status || 'recorded'));
    if (result.title) card.append(el('p', { text: result.title }));
    if (result.requestedUrl || result.finalUrl) card.append(el('p', { text: result.finalUrl || result.requestedUrl }));
    if (result.httpStatus !== undefined) card.append(el('small', { text: `Page response: ${result.httpStatus}` }));
    if (result.detail) card.append(el('p', { text: result.detail }));
    if (result.draft || result.email) card.append(draftPreview(result.draft || result.email));
    root.append(card);
  }
  return root;
}
export function documentJobPanel(pack, data, options) {
  let jobs = []; let loaded = false; let stale = false; let timer; let stopped = false; let ready = false; let readinessDetail = 'The original document is loading.'; let requestKey; let requestValue;
  const editable = data.roles?.some((role) => ['admin', 'operator', 'approver'].includes(role));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const root = el('section', { class: 'info-card stack document-job-panel', 'aria-label': 'Background job schedule' });
  const name = el('input', { class: 'field-control', maxlength: 200, value: pack.name || 'Document job', 'aria-label': 'Job name', disabled: !editable });
  const timezone = el('select', { class: 'field-control', 'aria-label': 'Job time zone', disabled: !editable }, ...[...new Set([zone, pack.manifest?.timezone, 'UTC'].filter(Boolean))].map((value) => el('option', { value, text: value })));
  const time = el('input', { class: 'field-control', type: 'datetime-local', 'aria-label': 'Job start time', disabled: !editable, min: scheduleInZone(Date.now(), zone) });
  const selection = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
  const errors = el('p', { class: 'validation-errors', role: 'alert', hidden: '' });
  const receipt = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'stack document-job-list', 'aria-live': 'polite' });
  const listing = el('p', { class: 'field-help', role: 'status', text: 'Loading saved jobs…' });
  const run = (control, action) => busy(control, async () => { errors.hidden = true; try { await action(); } catch (error) { errors.textContent = error.message; errors.hidden = false; } }).finally(() => updateSelection());
  function scheduleValue(required) {
    if (!time.value) { if (required) throw new Error('Choose a future job start time.'); return null; }
    const value = zonedISO(time.value, timezone.value); const due = Date.parse(value);
    if (required && (due <= Date.now() || due > Date.now() + 90 * 86400000)) throw new Error('Choose a job time in the next 90 days.');
    return value;
  }
  async function create(paused) {
    const selectedActionIds = options.getSelected(); if (!ready) throw new Error('Wait for the original document to open before saving this job.'); if (!selectedActionIds.length) throw new Error('Choose at least one supported trigger before saving or scheduling a job.'); if (selectedActionIds.length > 20) throw new Error('Choose up to 20 triggers for each background job.');
    const input = { name: name.value.trim() || pack.name, sourceHash: options.getSourceHash(), selectedActionIds, scheduledFor: scheduleValue(!paused), timezone: timezone.value, paused };
    const serialized = JSON.stringify(input); if (requestValue !== serialized) { requestValue = serialized; requestKey = globalThis.crypto.randomUUID(); }
    const value = await api('document-job-create', { packageId: pack.id, input: { ...input, idempotencyKey: requestKey } });
    if (!value.job?.id) throw new Error('The server did not return a saved job. Refresh saved jobs before trying again.');
    jobs = [value.job, ...jobs.filter((job) => job.id !== value.job.id)]; loaded = true; stale = false; receipt.textContent = `Job saved · ${statusText(value.job.status)}. ${value.job.detail || ''}`; draw(); await refreshJobs();
  }
  const draft = button('Save job draft', () => run(draft, () => create(true)));
  const schedule = button('Schedule background job', () => run(schedule, () => create(false)), 'primary');
  const updateSelection = () => { const count = options.getSelected().length; selection.textContent = `${count} trigger${count === 1 ? '' : 's'} selected. ${ready ? count ? 'Choose the time for this job.' : 'Choose triggers before saving a job draft or scheduling.' : readinessDetail}`; draft.disabled = schedule.disabled = !editable || !ready || !count; for (const control of list.querySelectorAll('[data-requires-document-ready]')) control.disabled = !ready; };
  timezone.addEventListener('change', () => { time.min = scheduleInZone(Date.now(), timezone.value); });
  root.append(el('div', {}, el('h3', { text: 'Schedule a background job' }), el('p', { text: 'At the chosen time, Carl-Allen opens selected pages in its isolated worker and saves email drafts inside this app. This does not send email or approve outreach.' })), selection, field('Job name', name), field('Job time zone', timezone), field('Job start time', time), el('div', { class: 'document-job-actions' }, draft, schedule), errors, receipt, el('div', { class: 'document-saved-heading' }, el('h3', { text: 'Saved jobs' }), button('Refresh jobs', () => refreshJobs(), 'small')), listing, list);
  function jobCard(job) {
    const card = el('article', { class: 'review-tile document-job-card' }, el('div', { class: 'document-job-heading' }, el('h4', { text: job.name }), jobBadge(job.status)), el('p', { text: job.scheduledFor ? `${dateText(job.scheduledFor, job.timezone)} · ${job.timezone}` : 'No run time chosen' }), el('small', { text: `${job.selectedActionIds?.length || 0} selected triggers` }));
    if (job.detail) card.append(el('p', { text: job.detail })); if (job.results?.some((result) => result.status === 'failed')) card.append(el('p', { class: 'validation-errors', role: 'alert', text: 'One or more triggers need attention. Review the recorded outcomes below.' })); if (job.results?.length) card.append(resultsPanel(job));
    if (!editable || terminal.has(job.status)) return card;
    const controls = el('div', { class: 'document-job-actions' }); const jobTime = el('input', { class: 'field-control', type: 'datetime-local', 'aria-label': `Run time for job ${job.name}` });
    jobTime.value = job.scheduledFor ? scheduleInZone(job.scheduledFor, job.timezone) : '';
    const patch = async (input) => { if (!ready && (input.scheduledFor !== undefined || input.paused === false)) throw new Error('Reload the original file before scheduling this job.'); const value = await api('document-job-update', { jobId: job.id, input: { expectedRevision: job.revision, ...input } }); if (!value.job?.id) throw new Error('No updated job was returned. Refresh saved jobs to check its state.'); jobs = jobs.map((item) => item.id === value.job.id ? value.job : item); draw(); };
    if (!job.selectedActionIds?.length || !job.actions?.length) {
      card.append(el('p', { class: 'field-help', text: 'This saved job has no frozen trigger selection and cannot be scheduled. Select triggers above and create a new job.' }));
      const resume = button('Schedule this job', () => {}, 'small'); resume.disabled = true;
      const cancel = button('Cancel job', () => run(cancel, () => patch({ cancel: true })), 'small danger'); controls.append(resume, cancel); card.append(controls); return card;
    }
    if (job.status !== 'running') {
      card.append(field(`Run time for job ${job.name}`, jobTime, `Time zone: ${job.timezone}`));
      const saveTime = button('Save job time', () => run(saveTime, async () => { if (!jobTime.value) throw new Error('Choose a complete job time.'); const value = zonedISO(jobTime.value, job.timezone); if (Date.parse(value) <= Date.now()) throw new Error('Choose a future job time.'); await patch({ scheduledFor: value }); }), 'small'); saveTime.dataset.requiresDocumentReady = 'true'; saveTime.disabled = !ready; controls.append(saveTime);
    }
    if (['scheduled', 'running'].includes(job.status)) { const pause = button('Pause job', () => run(pause, () => patch({ paused: true })), 'small'); controls.append(pause); }
    else { const resume = button('Schedule this job', () => run(resume, async () => { const value = jobTime.value ? zonedISO(jobTime.value, job.timezone) : job.scheduledFor; if (!value || Date.parse(value) <= Date.now()) throw new Error('Choose a future job time before scheduling.'); await patch({ scheduledFor: value, paused: false }); }), 'small'); resume.dataset.requiresDocumentReady = 'true'; resume.disabled = !ready; controls.append(resume); }
    const cancel = button('Cancel job', () => run(cancel, () => patch({ cancel: true })), 'small danger'); controls.append(cancel); card.append(controls); return card;
  }
  function draw() { listing.textContent = !loaded ? 'Loading saved jobs…' : stale ? 'Showing the last saved status. Refresh to confirm the current state.' : jobs.length ? 'Job status comes from the server and continues independently of this window.' : 'No background jobs have been saved for this file.'; list.replaceChildren(...jobs.map(jobCard)); }
  async function refreshJobs() {
    clearTimeout(timer); if (stopped) return;
    try { const value = await api('document-job-list', { packageId: pack.id }); if (stopped) return; jobs = value.jobs || []; loaded = true; stale = false; draw(); }
    catch (error) { if (stopped) return; stale = true; draw(); listing.textContent = `Job status unavailable: ${error.message}${loaded ? ' Last saved status is shown below.' : ''}`; }
    if (!stopped && jobs.some((job) => ['scheduled', 'running'].includes(job.status))) timer = setTimeout(refreshJobs, jobs.some((job) => job.status === 'running') ? 3000 : 10000);
  }
  updateSelection(); void refreshJobs();
  return { root, updateSelection, focusSchedule() { root.scrollIntoView({ block: 'start', behavior: 'smooth' }); time.focus({ preventScroll: true }); }, setReady(value, detail) { ready = value; readinessDetail = detail || 'The original document is loading.'; updateSelection(); }, stop() { stopped = true; clearTimeout(timer); }, refreshJobs };
}
