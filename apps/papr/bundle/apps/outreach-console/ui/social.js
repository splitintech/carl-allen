import { $, el } from './dom.js';
import { connectAccount, privateLoginLink } from './connection-dialog.js';

const PROVIDERS = [
  { kind: 'linkedin', monogram: 'in', name: 'LinkedIn', description: 'Posts, messages and connection requests.', button: 'Connect LinkedIn account', tag: 'Private browser' },
  { kind: 'browser', monogram: '↗', name: 'Configured browser', description: 'Tasks for sites your administrator has configured.', button: 'Connect configured browser account', tag: 'Configured tasks' },
  { kind: 'gmail', monogram: 'G', name: 'Gmail', description: 'Create and edit drafts in your mailbox.', button: 'Set up Gmail', tag: 'OAuth setup required' },
  { kind: 'outlook', monogram: 'O', name: 'Outlook', description: 'Create and edit drafts in your mailbox.', button: 'Set up Outlook', tag: 'OAuth setup required' },
];

function state(account) {
  if (account.health === 'ok') return { className: 'ready', label: 'Connected', help: 'Account identity checked. Ready for drafts and approved actions.' };
  if (account.health === 'reauth_required' || account.reconnectNeeded) return { className: 'hold', label: 'Sign-in needed', help: 'Open browser login, sign into this account, then check the session.' };
  return { className: 'stop', label: 'Needs attention', help: 'Check the connection to see what needs to be fixed.' };
}

export function renderSocial(status, act) {
  const root = $('social');
  if (!status) {
    root.replaceChildren(el('p', { role: 'status', class: 'hint', text: 'Connections are unavailable. Refresh when the outreach engine is connected.' }));
    return;
  }
  const accounts = [...(status.allAccounts || [])];
  for (const social of status.accounts || []) {
    const existing = accounts.find((account) => account.id === social.id);
    if (existing) Object.assign(existing, social); else accounts.push(social);
  }
  const providers = el('div', { class: 'connection-providers' }, ...PROVIDERS.map((provider) => el('div', { class: 'connection-provider' },
    el('span', { class: `provider-mark provider-${provider.kind}`, 'aria-hidden': 'true', text: provider.monogram }),
    el('div', {}, el('h3', { text: provider.name }), el('p', { class: 'hint', text: provider.description })),
    el('span', { class: 'connection-provider-tag', text: provider.tag }),
    el('button', { type: 'button', text: provider.button, onclick: (event) => connectAccount(provider.kind, status.liveViewUrl, act, event.currentTarget) }),
  )));
  const intro = el('div', { class: 'connection-intro' }, el('div', {}, el('p', { class: 'connection-eyebrow', text: 'Your accounts, your timing' }), el('h3', { text: accounts.length ? 'Add another connection' : 'Start with one account. Add the rest later.' }), el('p', { class: 'hint', text: 'Choose a service below. Connect when you are ready; nothing is posted or sent during setup.' })), el('span', { class: 'connection-count', text: `${accounts.length} added account${accounts.length === 1 ? '' : 's'}` }));
  const list = el('ul', { class: 'cards connection-accounts' });
  for (const account of accounts) {
    const isBrowser = account.executionPlacement === 'daytona-browser' || account.capabilities?.executionPlacement === 'daytona-browser' || account.provider === 'social-browser';
    const isLinkedIn = isBrowser && /^https:\/\/(www\.)?linkedin\.com\/in\//.test(account.externalAccountId);
    const label = isLinkedIn ? 'LinkedIn' : account.provider === 'gmail' ? 'Gmail' : account.provider === 'outlook' ? 'Outlook' : isBrowser ? 'Configured browser' : account.provider;
    const health = state(account);
    const login = isBrowser ? privateLoginLink(status.liveViewUrl, 'Open browser login') : null;
    list.append(el('li', { class: 'card connection-account' },
      el('div', { class: 'connection-account-head' }, el('strong', { text: `${label}${account.sender?.name ? ` · ${account.sender.name}` : ''}` }), el('span', { class: `chip ${health.className}`, text: health.label })),
      el('p', { class: 'connection-identity', text: account.externalAccountId }),
      el('p', { class: 'hint', text: account.detail || health.help }),
      el('div', { class: 'row' }, login,
        el('button', { type: 'button', text: isLinkedIn ? 'Check session after login' : isBrowser ? 'Check configured browser session' : 'Check mailbox connection', onclick: (event) => act(event.currentTarget, 'account-check', { accountId: account.id }, 'Connection checked') }),
        el('button', { type: 'button', text: 'Reconnect', onclick: (event) => act(event.currentTarget, 'account-reconnect', { accountId: account.id }, isBrowser ? 'Connection checked. Open browser login if sign-in is needed.' : 'Mailbox checked. If consent expired, ask your administrator to renew OAuth access.') }),
      ),
      isBrowser && !login ? el('p', { class: 'hint', text: 'Browser login link is unavailable. Ask your runtime administrator to refresh the private connection.' }) : null,
    ));
  }
  root.replaceChildren(intro, providers, el('p', { class: 'connection-footnote', text: 'LinkedIn has built-in browser actions. Other social networks require an administrator-configured recipe. Gmail and Outlook use mailbox OAuth.' }), el('h3', { text: 'Connected accounts' }), accounts.length ? list : el('p', { class: 'connection-empty', text: 'No accounts yet. You can explore the console now and return here to connect later.' }));
}
