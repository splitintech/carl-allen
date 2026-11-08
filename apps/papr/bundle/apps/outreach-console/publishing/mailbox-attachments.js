/* global crypto,btoa */
import { el, button, field, busy } from './utils.js';
import { api } from './service.js';
export function draftAttachments(account, initial, enabled) {
  let values = [...(initial || [])]; const list = el('div'); const input = el('input', { type: 'file', class: 'field-control', 'aria-label': 'Draft attachment' }); const progress = el('p', { role: 'status', class: 'flow-note' });
  const upload = button('Upload attachment', () => busy(upload, async () => {
    const file = input.files?.[0]; if (!file) throw new Error('Choose an attachment.'); if (file.size > 20 * 1024 * 1024 || !file.size) throw new Error('Choose a file between 1 byte and 20 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer()); const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    const created = await api('draft-upload-start', { accountId: account.id, input: { name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, sha256: hash } });
    for (let offset = 0, index = 0; offset < bytes.length; offset += created.chunkBytes, index++) { const chunk = bytes.subarray(offset, offset + created.chunkBytes); let binary = ''; for (const byte of chunk) binary += String.fromCharCode(byte); await api('draft-upload-chunk', { accountId: account.id, uploadId: created.uploadId, index, data: btoa(binary) }); progress.textContent = `Uploading ${Math.min(100, Math.round((offset + chunk.length) / bytes.length * 100))}%`; }
    values.push(await api('draft-upload-complete', { accountId: account.id, uploadId: created.uploadId })); input.value = ''; progress.textContent = 'Attachment stored with this mailbox. Save the draft to include it.'; render();
  }), 'small');
  function render() { list.replaceChildren(...values.map(value => el('div', { class: 'panel-toolbar' }, el('span', { text: `${value.name} · ${Math.ceil(value.size / 1024)} KB${value.inline ? ' · inline image' : ''}` }), ...(enabled ? [button('Remove attachment', () => { values = values.filter(item => item !== value); render(); }, 'small')] : [])))); }
  render(); const root = el('div', {}, list); if (enabled) root.append(field('Add a file (maximum 20 MB)', input), upload, progress); return { root, values: () => values };
}
