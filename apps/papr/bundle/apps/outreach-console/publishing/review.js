import { renderDelivery } from './delivery.js';
import { el, button, field, modal, busy, notify, badge, dateText } from './utils.js';
import { platform, accountName } from './model.js';
import { api } from './service.js';
export function reviewDraft(draft, data, refresh, edit) {
  const m = modal('One last look before it goes out', 'Review every caption, account, attachment and scheduled time.'); const area = el('div', { class: 'review-content' });
  for (const post of draft.posts) {
    const p = platform(post.channel); const account = data.accounts.find((a) => a.id === post.accountId);
    area.append(el('article', { class: 'review-entry' }, el('div', { class: 'review-heading' }, el('div', { class: 'account-title' }, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), el('strong', { text: `${p.name} · ${accountName(account)}` })), badge(account ? 'awaiting_approval' : 'blocked')), el('p', { text: post.text || '(Media-only post)' }), post.firstComment ? el('p', { class: 'field-help', text: `First comment: ${post.firstComment}` }) : null, el('div', { class: 'review-media' }, ...post.mediaIds.map((id) => el('span', { text: data.media.find((a) => a.id === id)?.name || 'Unavailable attachment' }))), el('small', { text: `${dateText(post.scheduledFor || draft.scheduledFor, draft.timezone)} · ${draft.timezone}` }), !account ? el('small', { text: 'Connect an account before submitting. Your content stays saved as a draft.' }) : null));
  }
  const errors = draft.posts.some((p) => !p.accountId);
  area.append(el('p', { class: 'field-help', text: 'Submitting creates approval requests. Approval is separate, and no post is sent from this screen. If any platform is blocked, the entire draft stays saved without scheduling.' }));
  m.content.append(area);
  const submit = button('Submit for approval', () => busy(submit, async () => {
    const result = await api('publishing-plan-prepare', { draftId: draft.id });
    if (result.blocked?.length) { notify(`Not scheduled: ${result.blocked.map((b) => `${platform(b.channel).name}: ${b.reason}`).join(' · ')}`); area.append(el('div', { class: 'validation-errors', role: 'alert', text: result.blocked.map((b) => `${platform(b.channel).name}: ${b.reason}`).join('\n') })); await refresh(); return; }
    if (result.authorizationId && result.operationHash && data.roles?.some((role) => ['admin', 'approver'].includes(role))) {
      const approve = button('Approve this exact plan', () => busy(approve, async () => { await api('plan-approve', { authorizationId: result.authorizationId, operationHash: result.operationHash }); m.close(); await refresh(); notify('Plan approved. Each account keeps its own delivery state.'); }), 'primary');
      area.append(el('div', { class: 'import-receipt', text: `${result.actions.length} publications prepared. Review the complete plan above before approving.` })); m.bottom.replaceChildren(button('Close', m.close), button('Reject this exact plan',()=>rejectExactPlan(result.authorizationId,result.operationHash,async()=>{m.close();await refresh();notify('Plan rejected. No work was approved.');}),'danger'), approve); await refresh(); return;
    }
    m.close(); await refresh(); notify(`${result.actions.length} post${result.actions.length === 1 ? '' : 's'} queued for approval. Nothing has been published yet.`);
  }), 'primary'); submit.disabled = errors;
  m.bottom.append(button('Back to edit', () => { m.close(); edit(draft); }), el('small', { text: errors ? 'One or more accounts still need connecting.' : 'You stay in control of the final approval.' }), submit);
}
export function reviewAction(action, data, refresh, edit,reviewPackage) {
  const p = platform(action.channel); const account = data.accounts.find((a) => a.id === action.providerAccountId); const m = modal(`${p.name} post details`, 'Current engine state and approved content.'); const content = el('div', { class: 'review-content' });
  content.append(el('div', { class: 'review-entry' }, el('div', { class: 'review-heading' }, el('strong', { text: accountName(account) }), badge(action.state)), el('p', { text: action.text }), el('small', { text: dateText(action.dueAt) }), el('div', { class: 'review-media' }, ...action.mediaIds.map((id) => el('span', { text: data.media.find((a) => a.id === id)?.name || 'Media attachment' }))), el('details', {}, el('summary', { class: 'field-help', text: 'Approval details' }), el('small', { text: `Content hash: ${action.operationHash}` })), action.reason ? el('p', { class: 'field-help', text: action.reason }) : null));
  content.append(renderDelivery(action));
  m.content.append(content); m.bottom.append(button('Close', m.close));
  if (action.state === 'awaiting_approval' && action.authorizationId) { const draft = data.drafts.find((item) => item.id === action.draftId); content.append(el('p', { class: 'field-help', text: 'This publication belongs to a complete plan. Review all accounts and posts before approving the full manifest.' })); if(action.workPackageId&&reviewPackage)m.bottom.append(button('Review HTML handoff',()=>{m.close();reviewPackage(action.workPackageId);},'primary')); if (draft && edit) m.bottom.append(button('Review complete plan', () => { m.close(); reviewDraft(draft, data, refresh, edit); }, 'primary')); }
  if (action.state === 'awaiting_approval' && !action.authorizationId && action.approvalId && (!data.roles?.length || data.roles.some((role) => ['admin', 'approver'].includes(role)))) {
    const approve = button('Approve this exact post', () => busy(approve, async () => { await api('approval-decide', { approvalId: action.approvalId, decision: 'approved', operationHash: action.operationHash, reason: 'Reviewed in Publishing Studio' }); m.close(); await refresh(); notify('Post approved. The Daytona worker will publish at its scheduled time.'); }), 'primary');
    m.bottom.append(approve);
  }
  if (['planned', 'awaiting_approval', 'scheduled', 'retryable'].includes(action.state)) {
    const cancel = button('Cancel this post', () => busy(cancel, async () => { await api('action-cancel', { actionId: action.id, reason: 'Cancelled from Publishing Studio' }); m.close(); await refresh(); notify('Post cancelled.'); }), 'danger'); m.bottom.append(cancel);
  }
}

export function rejectExactPlan(approvalId,operationHash,done) {
  const m=modal('Reject this exact plan','Explain the changes needed. Rejection cancels its unattempted work and creates no external effects.',true);
  const reason=el('textarea',{class:'field-control',rows:4,maxlength:500,required:'',name:'rejectionReason',autocomplete:'off'});const error=el('p',{class:'validation-errors',role:'alert',hidden:''});m.content.append(field('Reason for rejection',reason),error);
  const reject=button('Confirm rejection',()=>busy(reject,async()=>{const text=reason.value.trim();if(!text){error.hidden=false;error.textContent='Enter a reason before rejecting this plan.';reason.focus();return;}await api('approval-decide',{approvalId,operationHash,decision:'rejected',reason:text});m.close();await done();}),'danger');m.bottom.append(button('Keep reviewing',m.close),reject);reason.focus();
}
