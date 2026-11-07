import { cell, nextId, mappingContext, https, email, result } from './import-mapping-values.js';
export function mapContacts(manifest, rows, spec) {
  const context = mappingContext(manifest); const contacts = [...(manifest.contacts || [])]; const id = nextId(contacts, 'contact');
  const mapped = rows.map((row, i) => {
    const name = cell(row, spec, 'name').trim(); if (!name) context.errors.push(`Row ${i + 1}: choose a nonempty full name.`);
    const contact = { id: id(), name, sources: cell(row, spec, 'sources').split(/\r?\n/).map((url) => url.trim()).filter(Boolean), notes: cell(row, spec, 'notes'), consentBasis: 'unknown', jurisdiction: 'unknown' };
    for (const key of ['email', 'linkedin', 'instagram']) { const value = cell(row, spec, key).trim(); if (value) { contact[key] = value; if (!(key === 'email' ? email(value) : https(value))) context.errors.push(`Row ${i + 1}: ${key} must be ${key === 'email' ? 'a valid email address' : 'a credential-free HTTPS profile URL'}.`); } }
    if (contact.sources.some((url) => !https(url))) context.errors.push(`Row ${i + 1}: source URLs must use credential-free HTTPS (one per line).`);
    return contact;
  });
  return result(manifest, { contacts: [...contacts, ...mapped] }, context, mapped);
}
