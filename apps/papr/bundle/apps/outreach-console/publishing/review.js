import { el, button, modal, busy, notify, badge, dateText } from './utils.js';
import { platform, accountName } from './model.js';
import { api } from './service.js';
export function reviewDraft(draft, data, refresh, edit) {
  const m = modal('One last look before it goes out', 'Review every caption, account, attachment and scheduled time.'); const area = el('div', { class: 'review-content' });
  for (const post of draft.posts) {
    const p = platform(post.channel); const account = data.accounts.find((a) => a.id === post.accountId);
    area.append(el('article', { class: 'review-entry' }, el('div', { class: 'review-heading' }, el('div', { class: 'account-title' }, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), el('strong', { text: `${p.name} · ${accountName(account)}` })), badge(account ? 'awaiting_approval' : 'blocked')), el('p', { text: post.text || '(Media-only post)' }), el('div', { class: 'review-media' }, ...post.mediaIds.map((id) => el('span', { text: data.media.find((a) => a.id === id)?.name || 'Unavailable attachment' }))), el('small', { text: `${dateText(draft.scheduledFor, draft.timezone)} · ${draft.timezone}` }), !account ? el('small', { text: 'Connect an account before submitting. Your content stays saved as a draft.' }) : null));
  }
  const errors = draft.posts.some((p) => !p.accountId);
  area.append(el('p', { class: 'field-help', text: 'Submitting creates approval requests. Approval is separate, and no post is sent from this screen. If any platform is blocked, the entire draft stays saved without scheduling.' }));
  m.content.append(area);
  const submit = button('Submit for approval', () => busy(submit, async () => {
    const result = await api('publishing-submit', { draftId: draft.id });
    if (result.blocked?.length) { notify(`Not scheduled: ${result.blocked.map((b) => `${platform(b.channel).name}: ${b.reason}`).join(' · ')}`); area.append(el('div', { class: 'validation-errors', role: 'alert', text: result.blocked.map((b) => `${platform(b.channel).name}: ${b.reason}`).join('\n') })); await refresh(); return; }
    m.close(); await refresh(); notify(`${result.actions.length} post${result.actions.length === 1 ? '' : 's'} queued for approval. Nothing has been published yet.`);
  }), 'primary'); submit.disabled = errors;
  m.bottom.append(button('Back to edit', () => { m.close(); edit(draft); }), el('small', { text: errors ? 'One or more accounts still need connecting.' : 'You stay in control of the final approval.' }), submit);
}
export function reviewAction(action, data, refresh) {
  const p = platform(action.channel); const account = data.accounts.find((a) => a.id === action.providerAccountId); const m = modal(`${p.name} post details`, 'Current engine state and approved content.'); const content = el('div', { class: 'review-content' });
  content.append(el('div', { class: 'review-entry' }, el('div', { class: 'review-heading' }, el('strong', { text: accountName(account) }), badge(action.state)), el('p', { text: action.text }), el('small', { text: dateText(action.dueAt) }), el('div', { class: 'review-media' }, ...action.mediaIds.map((id) => el('span', { text: data.media.find((a) => a.id === id)?.name || 'Media attachment' }))), el('details', {}, el('summary', { class: 'field-help', text: 'Approval details' }), el('small', { text: `Content hash: ${action.operationHash}` })), action.reason ? el('p', { class: 'field-help', text: action.reason }) : null));
  if (['uncertain', 'review', 'failed'].includes(action.state)) content.append(el('p', { class: 'field-help', text: 'Check the account and resolve this result in the Outreach console before creating another attempt. A post may already exist when its result is uncertain.' }), el('a', { class: 'button small', href: 'index.html#review', text: 'Open delivery review' }));
  m.content.append(content); m.bottom.append(button('Close', m.close));
  if (action.state === 'awaiting_approval' && action.approvalId && (!data.roles?.length || data.roles.some((role) => ['admin', 'approver'].includes(role)))) {
    const approve = button('Approve this exact post', () => busy(approve, async () => { await api('approval-decide', { approvalId: action.approvalId, decision: 'approved', operationHash: action.operationHash, reason: 'Reviewed in Publishing Studio' }); m.close(); await refresh(); notify('Post approved. The Daytona worker will publish at its scheduled time.'); }), 'primary');
    m.bottom.append(approve);
  }
  if (['planned', 'awaiting_approval', 'scheduled', 'retryable'].includes(action.state)) {
    const cancel = button('Cancel this post', () => busy(cancel, async () => { await api('action-cancel', { actionId: action.id, reason: 'Cancelled from Publishing Studio' }); m.close(); await refresh(); notify('Post cancelled.'); }), 'danger'); m.bottom.append(cancel);
  }
}
