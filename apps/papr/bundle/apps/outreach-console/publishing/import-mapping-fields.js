import { el, field } from './utils.js';
export const mappingFields = {
  contacts: [['name', 'Full name', ['name', 'fullname']], ['email', 'Email', ['email', 'emailaddress']], ['linkedin', 'LinkedIn profile', ['linkedin', 'linkedinprofile']], ['instagram', 'Instagram profile', ['instagram', 'instagramprofile']], ['sources', 'Source URLs', ['source', 'sources', 'sourceurl']], ['notes', 'Notes', ['notes']]],
  publications: [['text', 'Caption', ['caption', 'text', 'post']], ['scheduledFor', 'Schedule', ['scheduledfor', 'schedule', 'date', 'datetime']], ['accountRef', 'Logical account', ['accountref', 'account', 'accountid']], ['channel', 'Platform', ['platform', 'channel']], ['media', 'Media filenames', ['media', 'mediafilenames', 'filename', 'filenames']], ['format', 'Format', ['format']], ['firstComment', 'First comment', ['firstcomment']]],
  outreach: [['recipient', 'Recipient IDs or addresses', ['recipient', 'recipients', 'contactid', 'email', 'linkedin', 'instagram']], ['sequence', 'Sequence group', ['sequence', 'sequencegroup', 'sequencename']], ['scheduledFor', 'Sequence start', ['scheduledfor', 'schedule', 'date', 'start']], ['accountRef', 'Logical account', ['accountref', 'account', 'accountid']], ['channel', 'Channel', ['channel', 'platform']], ['kind', 'Step kind', ['kind', 'stepkind']], ['text', 'Message text', ['text', 'message', 'body']], ['subject', 'Email subject', ['subject']], ['waitHours', 'Wait hours', ['waithours', 'wait']], ['waitFor', 'Wait condition', ['waitfor', 'waitcondition']]],
};
const normalized = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const options = (values) => values.map(([value, text]) => el('option', { value, text }));
function sharedControl(key, destination, manifest, spec, changed) {
  let control; const defaults = spec.defaults;
  if (key === 'accountRef') {
    control = el('select', { class: 'field-control', 'aria-label': 'Shared logical account' }, ...options([['', 'Choose a logical account…'], ...(manifest.accountRefs || []).map((ref) => [ref.id, `${ref.label} · ${ref.channel}`]), ['__new', 'New logical account reference…']]));
    const name = el('input', { class: 'field-control', type: 'text', maxlength: '120', placeholder: 'e.g. founder-linkedin', 'aria-label': 'New logical account reference', disabled: true });
    control.addEventListener('change', () => { name.disabled = control.value !== '__new'; defaults.accountRef = control.value === '__new' ? name.value.trim() : control.value; changed(); });
    name.addEventListener('input', () => { if (control.value === '__new') defaults.accountRef = name.value.trim(); changed(); });
    return el('div', { class: 'stack' }, field('Shared logical account', control), field('New logical account reference', name, 'A logical reference still needs a connected workspace account after saving.'));
  }
  const choices = key === 'channel' ? (destination === 'publications' ? ['linkedin', 'instagram', 'x', 'tiktok'] : ['linkedin', 'instagram', 'email']) : key === 'kind' ? ['message', 'connect', 'email'] : key === 'format' ? ['feed', 'carousel', 'video', 'reel'] : key === 'waitFor' ? ['elapsed', 'connected'] : null;
  if (choices) { control = el('select', { class: 'field-control' }, ...options([['', 'Choose a shared value…'], ...choices.map((value) => [value, value])])); if (key === 'format' || key === 'waitFor') { control.value = choices[0]; defaults[key] = choices[0]; } }
  else if (key === 'recipient') control = el('select', { class: 'field-control' }, ...options([['', 'Match the source column or choose one contact…'], ...(manifest.contacts || []).map((person) => [person.id, `${person.name} · ${person.id}`])]));
  else control = el('input', { class: 'field-control', type: key === 'waitHours' ? 'number' : 'text', ...(key === 'waitHours' ? { min: '0', max: '2160', step: 'any', value: '0' } : { placeholder: '2026-11-10T09:00:00-05:00' }) });
  if (key === 'waitHours') defaults[key] = '0';
  control.setAttribute('aria-label', `Shared ${key}`); control.addEventListener('change', () => { defaults[key] = control.value; changed(); }); control.addEventListener('input', () => { defaults[key] = control.value; changed(); });
  return field(`Shared ${key}`, control, key === 'scheduledFor' ? 'Include seconds and Z or a UTC offset. No local dates or timezone guessing.' : 'Used only when no source column is selected.');
}
export function columnControls(destination, source, manifest, spec, changed) {
  const root = el('div', { class: 'stack' }); const columns = el('div', { class: 'mapping-grid' }); const shared = el('div', { class: 'schedule-grid' });
  for (const [key, label, aliases] of mappingFields[destination]) {
    const control = el('select', { class: 'field-control', 'aria-label': `${label} column` }, ...options([['', 'No source column'], ...source.headers.map((head) => [head, `${head} · ${String(source.rows[0]?.[head] ?? '').slice(0, 60)}`])]));
    const guess = source.headers.find((head) => aliases.includes(normalized(head))); if (guess) { control.value = guess; spec.columns[key] = guess; }
    control.addEventListener('change', () => { spec.columns[key] = control.value; changed(); }); columns.append(field(`${label} column`, control));
    if (['accountRef', 'channel', 'scheduledFor', 'recipient', 'kind', 'waitHours', 'format', 'waitFor'].includes(key)) shared.append(sharedControl(key, destination, manifest, spec, changed));
  }
  root.append(columns); if (shared.childNodes.length) root.append(el('details', { open: '' }, el('summary', { class: 'field-label', text: 'Shared values for rows without a selected column' }), shared)); return root;
}
