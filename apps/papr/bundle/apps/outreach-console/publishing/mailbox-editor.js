import { el, button, field, modal, busy, notify } from './utils.js';
import { api } from './service.js';
import { draftAttachments } from './mailbox-attachments.js';
export function editMailboxDraft(data, account, draft, info, reload) {
  const content = draft?.content || {}; const mayEdit = data.roles.some(role => ['admin','operator','approver'].includes(role)); const m = modal(draft ? 'Edit mailbox draft' : 'Create mailbox draft', 'This saves an unsent provider draft. Zoho sending remains manual.');
  const addressInput = (name, values) => { const input = el('input', { class: 'field-control', name, autocomplete: 'off', readonly: !mayEdit }); input.value = (values || []).map(value => value.address).join(', '); return input; };
  const to = addressInput('to', content.to); const cc = addressInput('cc', content.cc); const bcc = addressInput('bcc', content.bcc); const subject = el('input', { class: 'field-control', name: 'subject', maxlength: 1000, readonly: !mayEdit }); subject.value = content.subject || '';
  const text = el('textarea', { class: 'field-control', name: 'text', rows: 9, readonly: !mayEdit }); text.value = content.text || '';
  const format = el('p', { class: 'flow-note', role: 'status', text: content.html ? 'Existing rich formatting is retained until you edit the message text. Editing converts the body to plain text.' : 'This message will be saved as plain text.' }); let bodyChanged = false; text.addEventListener('input', () => { bodyChanged = true; format.textContent = 'Edited message will be saved as plain text. Existing HTML will be removed.'; });
  const attachments = draftAttachments(account, content.attachments, mayEdit && info.attachmentUpload); m.content.append(el('div', { class: 'review-content' }, field('To (comma-separated email addresses)', to), field('CC', cc), field('BCC', bcc), field('Subject', subject), field('Message', text), format, attachments.root));
  if (content.attachments?.some(a => a.inline)) m.content.append(el('p', { class: 'banner', text: 'Inline images require editing in the provider to preserve their placement. Carl-Allen will hold this save rather than alter those images.' }));
  const addresses = input => input.value.split(',').map(value => ({address:value.trim()})).filter(value => value.address);
  const save = button('Save mailbox draft', () => busy(save, async () => {
    const { html, ...base } = content; const rich = !!html && !bodyChanged; const input = { ...base, ...(rich ? {html} : {}), bodyFormat: rich ? 'html' : 'plaintext', ...(draft?.id ? {id:draft.id} : {}), from: content.from || {address:account.sender.address,name:account.sender.name}, to:addresses(to), cc:addresses(cc), bcc:addresses(bcc), subject:subject.value, text:text.value, headers:content.headers || {}, ...(account.provider === 'zoho' ? {attachments:attachments.values()} : {}) };
    await api('drafts-save', { accountId:account.id,input }); m.close(); await reload(); notify('Mailbox draft saved. Nothing was sent.');
  }), 'primary'); save.disabled = !mayEdit; m.bottom.append(button('Close', m.close), save);
  if (info.webUrl) m.bottom.append(el('a', {class:'button',href:info.webUrl,target:'_blank',rel:'noopener noreferrer',text:account.provider === 'zoho'?'Open in Zoho':'Open mailbox'}));
  if (draft && mayEdit) m.bottom.append(button('Delete draft', () => { const remove = button('Delete this mailbox draft', () => busy(remove, async () => { await api('drafts-delete', {accountId:account.id,draftId:draft.id}); m.close(); await reload(); notify('Mailbox draft deleted.'); }), 'danger'); m.bottom.replaceChildren(button('Keep draft', m.close), remove); }, 'danger'));
}
