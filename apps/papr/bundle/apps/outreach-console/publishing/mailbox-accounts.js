import { el, button, badge, busy, notify } from './utils.js';
import { accountName } from './model.js';
import { api } from './service.js';
import { openMailboxConnection, disconnectMailbox } from './mailbox-connect.js';
export function mailboxAccounts(data, refresh) {
  const root = el('section', {class:'content-panel'}, el('div', {class:'panel-toolbar'}, el('h2', {text:'Email accounts'}))); const grid = el('div', {class:'account-grid'}); const admin = data.roles.includes('admin');
  for (const [provider,name] of [['gmail','Gmail'],['outlook','Outlook'],['zoho','Zoho Mail']]) {
    const accounts = data.accounts.filter(account => account.provider === provider); const card = el('article', {class:'account-card'}, el('h3', {text:name}), el('p', {text:provider === 'zoho'?'Inbox and drafts · send manually in Zoho':'Inbox, drafts and separately reviewed email sequences'}));
    if (!accounts.length) card.append(el('p', {text:'No mailbox connected. An administrator can sign in securely through the provider.'}));
    for (const account of accounts) {
      const check = button('Check mailbox connection', () => busy(check, async () => { const result = await api('account-check', {accountId:account.id}); notify(result.status === 'ok'?'Mailbox connection verified.':result.detail || result.status); await refresh(); }), 'small'); check.disabled = !data.roles.some(role => ['operator','approver','admin'].includes(role)); check.setAttribute('aria-label', 'Check mailbox connection for ' + accountName(account));
      card.append(el('div', {class:'account-meta'}, el('strong', {text:accountName(account)}), el('p', {text:account.sender?.address || account.externalAccountId}), badge(account.health), ...(account.lifecycle ? [el('p',{class:'flow-note',text:`Account ${account.lifecycle.status}: ${account.lifecycle.reason || 'Reconnect before using this mailbox.'}`})] : []), check));
      if (admin) card.append(button('Reconnect ' + accountName(account), () => openMailboxConnection(data,refresh,{provider,accountId:account.id}), 'small'), button('Disconnect ' + accountName(account), () => disconnectMailbox(account,refresh), 'small'));
    }
    if (admin) card.append(button('Connect ' + name, () => openMailboxConnection(data,refresh,{provider}), 'small')); else card.append(el('p',{class:'field-help',text:'Only an administrator can connect, reconnect or revoke a mailbox grant.'})); grid.append(card);
  }
  root.append(grid); return root;
}
