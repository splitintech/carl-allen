import { el, field } from './utils.js';
import { scheduleInZone, zonedISO } from './model.js';

export function scheduleEditor(manifest, canEdit, changed) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fields = [];
  const panel = el('section', { class: 'info-card stack', 'aria-label': 'Plan schedule' }, el('div', {}, el('h3', { text: 'Choose when the plan starts' }), el('p', { text: `Enter times in your local time zone: ${zone}. The saved plan keeps the exact instant. Nothing runs until its required approval.` })));
  for (const [key, rows] of [['publishingPlans', manifest.publishingPlans || []], ['outreachSequences', manifest.outreachSequences || []]]) for (const row of rows) {
    const label = key === 'outreachSequences' ? `Start time for ${row.name || row.id}` : `Publish time for ${row.id}`;
    const control = el('input', { class: 'field-control', type: 'datetime-local', 'aria-label': label, min: scheduleInZone(Date.now(), zone), disabled: !canEdit });
    control.value = row.scheduledFor && Number.isFinite(Date.parse(row.scheduledFor)) ? scheduleInZone(row.scheduledFor, zone) : '';
    const help = el('p', { class: 'field-help', 'aria-live': 'polite' });
    const entry = { key, id: row.id, control, dirty: false };
    const describe = () => { const time = Date.parse(control.value); help.textContent = !control.value ? 'Choose a start time before preparing this plan.' : !Number.isFinite(time) || time <= Date.now() ? 'This time has passed. Choose a future date and time.' : 'This time will be saved with your account mapping.'; };
    control.addEventListener('input', () => { entry.dirty = true; describe(); changed(); }); describe(); fields.push(entry);
    panel.append(field(label, control), help);
  }
  function apply(value, requireFuture = false) {
    for (const entry of fields) {
      const row = value[entry.key]?.find((item) => item.id === entry.id); if (!row) continue;
      if (entry.dirty) { if (!entry.control.value && entry.key === 'publishingPlans') { entry.control.focus(); throw new Error(`Choose a complete date and time for ${row.id}.`); } row.scheduledFor = entry.control.value ? zonedISO(entry.control.value, zone) : null; }
      const time = Date.parse(row.scheduledFor || '');
      if (requireFuture && (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 90 * 86400000)) { entry.control.focus(); throw new Error(`Choose a future time within 90 days for ${row.name || row.id}.`); }
    }
    return value;
  }
  return { panel: fields.length ? panel : null, apply };
}
