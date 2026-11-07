import { el, button, field, busy } from './utils.js';
import { sourceTable } from './import-mapping-values.js';
import { columnControls } from './import-mapping-fields.js';
import { mapContacts } from './import-mapping-contacts.js';
import { mapPublications } from './import-mapping-posts.js';
import { mapOutreach } from './import-mapping-outreach.js';
export const mapImportRows = (manifest, rows, spec) => ({ contacts: mapContacts, publications: mapPublications, outreach: mapOutreach })[spec.destination](manifest, rows, spec);
export function mappingWizard(pack, manifest, data, onSave) {
  const tables = pack.tables || pack.extractedTables || pack.extracted?.tables || []; let spec; let reviewed;
  const root = el('section', { class: 'info-card stack', 'aria-label': 'Guided report mapping' }, el('h3', { text: 'Map research columns' }), el('p', { class: 'field-help', text: 'Map one table at a time. Existing rows stay in your handoff. Source content remains inert text; saving creates a revision for normal validation and approval.' }));
  const destination = el('select', { class: 'field-control', 'aria-label': 'Mapping destination' }, ...[['contacts', 'Contacts'], ['publications', 'Publications'], ['outreach', 'Outreach steps']].map(([value, text]) => el('option', { value, text })));
  const table = el('select', { class: 'field-control', 'aria-label': 'Research table' }, ...tables.map((_, index) => el('option', { value: index, text: `Table ${index + 1} · ${sourceTable(pack, index).rows.length} rows` })));
  const controls = el('div', { class: 'stack' }); const preview = el('div', { class: 'stack' }); const errors = el('div', { class: 'validation-errors', role: 'alert', tabindex: '-1', hidden: '' });
  function invalidate() { reviewed = null; save.disabled = true; preview.replaceChildren(el('p', { class: 'field-help', text: 'Preview this mapping before saving. Shared values apply only where no source column is selected.' })); errors.hidden = true; }
  function draw() { spec = { destination: destination.value || 'contacts', columns: {}, defaults: {} }; controls.replaceChildren(columnControls(spec.destination, sourceTable(pack, Number(table.value) || 0), manifest, spec, invalidate)); invalidate(); }
  const inspect = button('Preview mapped rows', () => {
    const source = sourceTable(pack, Number(table.value) || 0); reviewed = mapImportRows(manifest, source.rows, spec); if (!source.rows.length) reviewed.errors.push('Choose a table with at least one source row.');
    errors.textContent = reviewed.errors.join('\n'); errors.hidden = !reviewed.errors.length;
    const sourceText = el('textarea', { class: 'field-control code-field', readonly: '', 'aria-label': 'Source row preview', rows: '6' }); sourceText.value = JSON.stringify(source.rows.slice(0, 5), null, 2);
    const mappedText = el('textarea', { class: 'field-control code-field', readonly: '', 'aria-label': 'Mapped row preview', rows: '9' }); mappedText.value = JSON.stringify(reviewed.rows.slice(0, 5), null, 2);
    preview.replaceChildren(el('p', { class: 'field-help', text: `${source.rows.length} source rows → ${reviewed.rows.length} mapped ${spec.destination === 'outreach' ? 'sequences' : spec.destination}. Preview shows up to five. Outreach rows in the same named group keep source order and must share recipients and start time.` }), field('Source row preview', sourceText), field('Mapped row preview', mappedText), ...reviewed.repairs.map((text) => el('p', { class: 'banner', text })), el('p', { class: 'field-help', text: 'Account connections, files, consent, provider capabilities and scheduling rules are checked again by the server. Saving does not approve or execute work.' }));
    save.disabled = reviewed.errors.length > 0 || !data.roles?.some((role) => ['admin', 'operator', 'approver'].includes(role)); if (reviewed.errors.length) errors.focus();
  }, 'small');
  const save = button('Save mapped rows', () => busy(save, async () => { if (!reviewed || reviewed.errors.length) return; await onSave(reviewed.manifest); }), 'primary'); save.disabled = true;
  destination.addEventListener('change', draw); table.addEventListener('change', draw); draw(); root.append(field('Mapping destination', destination), field('Research table', table), controls, errors, preview, el('div', { class: 'toolbar-group' }, inspect, save)); return root;
}
