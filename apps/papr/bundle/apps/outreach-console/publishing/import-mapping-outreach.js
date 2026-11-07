import { cell, list, nextId, mappingContext, checkSchedule, result } from './import-mapping-values.js';
function recipients(value, contacts, channel, row, errors) {
  const ids = [];
  for (const recipient of list(value)) {
    const exact = contacts.filter((contact) => contact.id === recipient); const matches = exact.length ? exact : contacts.filter((contact) => channel === 'email' ? contact.email?.toLowerCase() === recipient.toLowerCase() : contact[channel] === recipient);
    if (matches.length !== 1) { errors.push(`Row ${row}: recipient ${recipient} must match exactly one imported contact ID or ${channel} address. Map contacts first.`); continue; }
    if (!matches[0][channel]) errors.push(`Row ${row}: contact ${matches[0].id} has no ${channel} address. Repair the contact first.`);
    if (!ids.includes(matches[0].id)) ids.push(matches[0].id);
  }
  if (!ids.length) errors.push(`Row ${row}: select at least one existing imported recipient.`);
  return ids.sort();
}
export function mapOutreach(manifest, rows, spec) {
  const context = mappingContext(manifest); const sequences = [...(manifest.outreachSequences || [])]; const contacts = manifest.contacts || []; const sequenceId = nextId(sequences, 'sequence'); const stepId = nextId(sequences.flatMap((sequence) => sequence.steps), 'step'); const groups = new Map();
  rows.forEach((row, i) => {
    const read = (key) => cell(row, spec, key); const number = i + 1; const channel = read('channel').trim().toLowerCase(); const accountRef = read('accountRef').trim(); const kind = read('kind').trim().toLowerCase(); const scheduledFor = read('scheduledFor').trim();
    if (!['linkedin', 'instagram', 'email'].includes(channel)) context.errors.push(`Row ${number}: outreach channel must be LinkedIn, Instagram or email.`);
    else context.account(accountRef, channel, number);
    if (!(channel === 'email' ? kind === 'email' : kind === 'message' || channel === 'linkedin' && kind === 'connect')) context.errors.push(`Row ${number}: use email for email, message for social outreach, or connect for LinkedIn.`);
    checkSchedule(scheduledFor, number, context.errors); const ids = recipients(read('recipient').trim(), contacts, channel, number, context.errors);
    const text = read('text'); const subject = read('subject'); if (!text.trim()) context.errors.push(`Row ${number}: choose nonempty outreach text.`); if (channel === 'email' && !subject.trim()) context.errors.push(`Row ${number}: email requires an explicit subject.`);
    const rawWait = read('waitHours').trim(); const waitHours = Number(rawWait); if (!rawWait || !Number.isFinite(waitHours) || waitHours < 0 || waitHours > 2160) context.errors.push(`Row ${number}: wait hours must be an explicit number from 0 to 2160.`);
    const waitFor = read('waitFor').trim() || 'elapsed'; if (!['elapsed', 'connected'].includes(waitFor) || waitFor === 'connected' && channel !== 'linkedin') context.errors.push(`Row ${number}: connection waits apply only to LinkedIn; otherwise choose elapsed.`);
    const name = read('sequence').trim(); const key = name ? `group:${name}` : `row:${number}`; let sequence = groups.get(key);
    if (sequence && (sequence.scheduledFor !== scheduledFor || JSON.stringify(sequence.contacts) !== JSON.stringify(ids))) context.errors.push(`Row ${number}: grouped sequence ${name} must keep the same schedule and recipients on every row.`);
    if (!sequence) { sequence = { id: sequenceId(), name: name || `Mapped outreach ${number}`, contacts: ids, scheduledFor, steps: [] }; groups.set(key, sequence); }
    sequence.steps.push({ id: stepId(), accountRef, channel, kind, text, ...(subject ? { subject } : {}), waitHours, waitFor });
    if (sequence.steps.length > 20) context.errors.push(`Row ${number}: a sequence can contain at most 20 steps.`);
    if (channel === 'email' && ids.some((id) => contacts.find((contact) => contact.id === id)?.consentBasis === 'unknown')) context.repairs.push('Review email consent basis in contact repair before preparing outreach. Mapping does not establish consent.');
  });
  const mapped = [...groups.values()]; return result(manifest, { outreachSequences: [...sequences, ...mapped] }, context, mapped);
}
