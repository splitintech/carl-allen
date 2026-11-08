import { el, button, busy, notify } from './utils.js';
import { api } from './service.js';
import { accountName } from './model.js';
import { editMailboxDraft } from './mailbox-editor.js';
import { openMailboxConnection, disconnectMailbox } from './mailbox-connect.js';
export function renderMailbox(data, refresh = () => {}) {
  const accounts = data.accounts.filter(account => ['gmail','outlook','zoho'].includes(account.provider)); const body = el('div'); let selected; let cursor; let info; const picker = el('select', {class:'field-control','aria-label':'Mailbox account','data-retain-input':'true'}, el('option', {value:'',text:'Choose a mailbox…'}), ...accounts.map(account => el('option', {value:account.id,text:`${accountName(account)} · ${account.provider}`})));
  const toolbar = el('div', {class:'panel-toolbar'}, el('h2', {text:'Mailbox drafts'}), picker); if (data.roles.includes('admin')) toolbar.append(button('Connect mailbox', () => openMailboxConnection(data,refresh), 'small'));
  const root = el('section', {class:'content-panel'}, toolbar, el('p', {class:'inline-note',text:'Manage unsent drafts in Gmail, Outlook and Zoho. Zoho messages are sent manually in Zoho.'}), body);
  async function load(more = false) {
    const account = accounts.find(value => value.id === picker.value); selected = account; if (!account) {body.replaceChildren(el('p', {class:'inline-note',text:accounts.length?'Select a connected mailbox to load drafts.':'Connect a mailbox to begin. An administrator configures provider OAuth once; team members never paste tokens here.'}));return;}
    if (!more) {cursor = undefined;body.replaceChildren(el('div', {class:'loading-state',text:'Loading mailbox drafts…'}));}
    try {
      const [value, details] = await Promise.all([api('drafts-list', {accountId:account.id,cursor:more?cursor:undefined}), more ? Promise.resolve(info) : api('mailbox-info', {accountId:account.id})]); if (selected !== account) return; info = details; cursor = value.nextCursor; let list = more ? body.querySelector('[data-mailbox-list]') : el('div', {'data-mailbox-list':'true'});
      if (!more) { const create = button('Create mailbox draft', () => editMailboxDraft(data,account,null,info,load), 'small'); create.disabled = !data.roles.some(role => ['admin','operator','approver'].includes(role)); const actions = el('div', {class:'panel-toolbar'}, create); if (data.roles.includes('admin')) actions.append(button('Reconnect mailbox', () => openMailboxConnection(data,refresh,{provider:account.provider,accountId:account.id}), 'small'), button('Disconnect mailbox', () => disconnectMailbox(account,refresh), 'small')); body.replaceChildren(actions,list); }
      for (const draft of value.drafts) list.append(el('article', {class:'queue-card'}, el('span', {class:'badge',text:'Draft'}), el('div', {}, el('h3', {text:draft.content?.subject || draft.subject || '(No subject)'}), el('p', {text:(draft.content?.text || draft.snippet || '').slice(0,180)})), button('Edit draft', async () => {try{editMailboxDraft(data,account,await api('drafts-get',{accountId:account.id,draftId:draft.id}),info,load);}catch(error){notify(error.message);}}, 'small')));
      if (!more && !value.drafts.length) list.append(el('p', {class:'empty-state',text:'No drafts in this mailbox. Create one when you are ready.'})); body.querySelector('[data-more-drafts]')?.remove(); if (cursor) { const next = button('Load more drafts', () => busy(next, () => load(true)), 'small'); next.dataset.moreDrafts = 'true'; body.append(next); }
    } catch (error) {if(more)notify(error.message);else body.replaceChildren(el('div', {class:'banner error',text:error.message}), button('Try again', () => load(), 'small'));}
  }
  picker.addEventListener('change', () => { void load(); }); void load(); return root;
}
