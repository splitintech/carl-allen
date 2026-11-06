import { $, el, toast } from './dom.js';
import { call } from './api.js';
import { editFields } from './editor.js';
export function mountMailDrafts(getData, act) {
  let selected = '';
  async function edit(button, account, draft) {
    const values = await editFields(draft ? 'Edit mailbox draft' : 'Create mailbox draft', [
      { name: 'to', label: 'To (comma-separated email addresses)', required: true, value: draft?.content.to.map((v) => v.address).join(', ') },
      { name: 'subject', label: 'Subject', value: draft?.content.subject, max: 1000 },
      { name: 'text', label: 'Message', multiline: true, value: draft?.content.text, max: 100000 },
      { name: 'html', label: 'HTML body (optional)', multiline: true, value: draft?.content.html, max: 200000 },
    ], 'Save draft', button);
    if (!values) return;
    const input = { ...draft?.content, ...(draft?.id ? { id: draft.id } : {}), from: { address: account.sender.address, name: account.sender.name }, to: values.to.split(',').map((address) => ({ address: address.trim() })).filter((r) => r.address), subject: values.subject, text: values.text, headers: draft?.content.headers ?? {}, html: values.html || undefined };
    await act(button, 'drafts-save', { accountId: account.id, input }, 'Mailbox draft saved. Nothing was sent.');
    await load(account);
  }
  async function load(account) {
    selected = account.id;
    try {
      const data = await call('drafts-list', { accountId: account.id });
      if (selected !== account.id) return;
      $('mail-drafts').replaceChildren(...data.drafts.map((draft) => el('li', { class: 'card' }, el('strong', { text: draft.content.subject || '(No subject)' }), el('p', { text: draft.content.to.map((v) => v.address).join(', ') }), el('pre', { text: draft.content.text.slice(0, 500) }), el('div', { class: 'row' }, el('button', { type: 'button', text: 'Edit draft', onclick: (e) => edit(e.currentTarget, account, draft) }), el('button', { type: 'button', text: 'Delete draft', onclick: async (e) => { await act(e.currentTarget, 'drafts-delete', { accountId: account.id, draftId: draft.id }, 'Mailbox draft deleted'); await load(account); } })))));
      if (!data.drafts.length) $('mail-drafts').replaceChildren(el('li', { class: 'empty', text: 'No drafts in this mailbox.' }));
    } catch (error) { toast(error.message); }
  }
  return (accounts) => {
    const mailboxes = accounts.filter((a) => a.drafts);
    $('mail-accounts').replaceChildren(...mailboxes.map((account) => el('div', { class: 'row' }, el('strong', { text: `${account.provider} · ${account.sender.address}` }), el('button', { type: 'button', text: 'Load drafts', onclick: () => load(account) }), el('button', { type: 'button', text: 'New draft', onclick: (e) => edit(e.currentTarget, account) }))));
    if (!mailboxes.length) $('mail-accounts').replaceChildren(el('p', { class: 'hint', text: 'Connect a Gmail or Outlook account in the runtime to manage mailbox drafts.' }));
  };
}
