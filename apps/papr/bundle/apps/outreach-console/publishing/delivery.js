/* global URL */
import { el, badge, dateText } from './utils.js';
import { accountName } from './model.js';
import { api } from './service.js';
const label=(kind,state)=>kind==='social.comment'&&state==='succeeded'?'Comment sent':state==='succeeded'?'Published':null;
function nativeLink(value) {
  try { const url=new URL(value); if(url.protocol!=='https:'||url.username||url.password||!['www.linkedin.com','linkedin.com','x.com','www.x.com','www.instagram.com','instagram.com','www.tiktok.com','tiktok.com'].includes(url.hostname))return null; return el('a',{href:url.href,target:'_blank',rel:'noopener noreferrer',class:'source-link',text:'Open native publication'}); } catch { return null; }
}
function outcome(value,title) {
  const state=badge(value.state);const text=label(value.kind,value.state);if(text)state.textContent=text;
  const result=el('section',{class:'review-tile','aria-label':title},el('div',{class:'review-heading'},el('h3',{text:title}),state));
  if(value.state_reason)result.append(el('p',{class:'field-help',text:value.state_reason}));
  if(['uncertain','review','reconciling'].includes(value.state))result.append(el('p',{class:'banner',text:'The effect may already exist. Check its native receipt and account before making a new plan. This screen does not retry or resolve delivery.'}));
  if(!value.attempts?.length)result.append(el('p',{class:'field-help',text:'No execution attempt or native receipt recorded.'}));
  for(const attempt of value.attempts||[]) {
    const receipt=attempt.receipt;const row=el('div',{},el('strong',{text:`Attempt ${attempt.attempt_no} · ${attempt.outcome}`}),el('small',{class:'field-help',text:attempt.finished_at?dateText(attempt.finished_at):'Attempt has no recorded completion'}));
    if(receipt?.providerMessageId){row.append(el('p',{text:`Native identifier: ${receipt.providerMessageId}`}));if(receipt.acceptedAt)row.append(el('small',{text:`Provider acceptance: ${dateText(receipt.acceptedAt)}`}));const link=nativeLink(receipt.raw?.url||receipt.providerMessageId);if(link)row.append(link);}
    else row.append(el('p',{class:'field-help',text:'No confirmed native receipt for this attempt.'}));
    if(attempt.error_class)row.append(el('p',{class:'field-help',text:`Provider result: ${attempt.error_class}`}));result.append(row);
  }
  return result;
}
export function renderDelivery(action) {
  const root=el('section',{class:'stack','aria-label':'Delivery receipts','aria-live':'polite'},el('h3',{text:'Delivery receipts'}),el('p',{class:'field-help',text:'Loading the latest execution records…'}));
  void (async()=>{try {
    const records=await Promise.all([api('action-details',{actionId:action.id}),...(action.dependentActions||[]).map(child=>api('action-details',{actionId:child.id}))]);
    root.replaceChildren(el('h3',{text:'Delivery receipts'}),outcome(records[0],'Publication'),...records.slice(1).map(record=>outcome(record,'First comment')));
    if(records.length>1)root.append(el('p',{class:'field-help',text:'First-comment delivery is independent. A failed or uncertain comment never changes a confirmed publication into a retry.'}));
  }catch(error){root.replaceChildren(el('h3',{text:'Delivery receipts'}),el('p',{class:'banner error',role:'alert',text:`Receipt data could not refresh: ${error.message}. Reopen these details to load the latest records.`}));}})();
  return root;
}
export function renderInboxMonitoring(data) {
  const root=el('section',{class:'info-card','aria-label':'Account inbox monitoring'},el('h2',{text:'Account inbox monitoring'}));
  if(data.errors?.['inbox-monitoring'])root.append(el('p',{class:'banner error',text:'Inbox monitoring status could not refresh. Any status below is from the last successful snapshot.'}));
  if(!data.inboxMonitoring?.length)root.append(el('p',{class:'field-help',text:'No inbox monitoring result is available. Follow-ups stay held until their account has a successful, recent inbox sync.'}));
  for(const monitor of data.inboxMonitoring||[]) {
    const account=data.accounts.find(a=>a.id===monitor.accountId);const name=accountName(account);const status={fresh:'Monitoring current',stale:'Monitoring stale',error:'Inbox sync failed',never_polled:'Never polled',connection_issue:'Connection needs attention'}[monitor.status]||'Monitoring unavailable';
    root.append(el('article',{class:'review-tile'},el('div',{class:'review-heading'},el('strong',{text:`${name} · ${monitor.channel}`}),el('span',{class:`badge ${monitor.held?'amber':''}`,text:status})),el('p',{class:'field-help',text:monitor.lastPolledAt?`Last successful inbox sync: ${dateText(monitor.lastPolledAt)}`:'No successful inbox sync has been recorded.'}),monitor.error?el('p',{class:'field-help',text:monitor.error}):null,el('p',{class:'field-help',text:monitor.held?`Automatic follow-ups and replies held: ${monitor.holdReason}`:'Inbox freshness is healthy. Approvals, reply conditions and account policies still apply.'})));
  }
  return root;
}
