import { el, button, badge, modal, busy, notify } from './utils.js';
import { accountName } from './model.js';
import { api } from './service.js';
function setup(provider) {
 const m=modal('Configure '+provider+' OAuth','Use the trusted runtime administrator setup. No passwords, cookies or grant files belong in an HTML handoff.');
 m.content.append(el('div',{class:'review-content'},el('p',{text:'The administrator configures the provider OAuth client, completes its consent flow and registers the owner-only grant in Daytona. Refresh this screen after account registration.'}),el('pre',{class:'code-field',text:'node packages/outreach-cli/dist/bin.js account connect '+provider+' --help'}),el('p',{class:'field-help',text:provider==='zoho'?'Choose the matching Zoho region. This workspace reads inboxes and saves drafts; complete sending manually in Zoho.':'Sending also requires a permitted account purpose, an approved plan and the runtime sending gate.'}),el('p',{class:'field-help',text:'Run the documented account setup through a trusted terminal with access to Daytona. This help command does not connect an account or upload credentials.'})));m.bottom.append(button('Close',m.close));
}
export function mailboxAccounts(data,refresh){
 const root=el('section',{class:'content-panel'},el('div',{class:'panel-toolbar'},el('h2',{text:'Email accounts'})));const grid=el('div',{class:'account-grid'});
 for(const [provider,name] of [['gmail','Gmail'],['outlook','Outlook'],['zoho','Zoho Mail']]){const accounts=data.accounts.filter(a=>a.provider===provider);const card=el('article',{class:'account-card'},el('h3',{text:name}),el('p',{text:provider==='zoho'?'Inbox & drafts · manual sending':'Inbox, drafts & reviewed email sequences'}));
 if(!accounts.length)card.append(el('p',{text:'No mailbox connected. Configure an OAuth grant through the trusted administrator setup.'}));
 for(const account of accounts){const check=button('Check mailbox connection',()=>busy(check,async()=>{const result=await api('account-check',{accountId:account.id});notify(result.status==='ok'?'Mailbox connection verified.':result.detail||result.status);await refresh();}),'small');check.disabled=!data.roles.some(role=>['operator','approver','admin'].includes(role));check.setAttribute('aria-label','Check mailbox connection for '+accountName(account));card.append(el('strong',{text:accountName(account)}),el('p',{text:account.sender?.address||account.externalAccountId}),badge(account.health),check);}
 if(data.roles.includes('admin'))card.append(button('OAuth setup instructions',()=>setup(provider),'small'));grid.append(card);
 }root.append(grid);return root;
}
