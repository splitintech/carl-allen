/* global URL */
import { canonicalProfile } from './identity.js';
import { el, button, modal, field, busy, notify, badge } from './utils.js';
import { PLATFORMS, platform, accountsFor, accountName } from './model.js';
import { api } from './service.js';
export function loginLink(url) {
  try { const value = new URL(url); if (value.protocol !== 'https:' || value.username || value.password) return null; return el('a', { href: value.href, class: 'button small', target: '_blank', rel: 'noopener noreferrer', text: 'Open private browser login' }); } catch { return null; }
}
export function connectPlatform(channel, data, refresh) {
  const p = platform(channel); const m = modal(`Connect ${p.name}`, 'Sign in once in Daytona. Your own computer’s browser session is never copied.', true);
  const form = el('form', { class: 'account-form' }); const identity = el('input', { class: 'field-control', type: 'url', required: '', id: 'connection-profile', placeholder: channel === 'linkedin' ? 'https://www.linkedin.com/in/your-name/' : `https://www.${p.host}/${channel === 'tiktok' ? '@' : ''}your-name` });
  const name = el('input', { class: 'field-control', required: '', id: 'connection-name', maxlength: 200, autocomplete: 'name' }); const email = el('input', { class: 'field-control', type: 'email', required: '', id: 'connection-email', autocomplete: 'email' });
  const notice = el('p', { class: 'field-help', role: 'status', 'aria-live': 'polite' }); const submit = el('button', { type: 'submit', class: 'button primary', text: 'Create browser connection' });
  form.append(field(`Your ${p.name} profile URL`, identity), field('Your name', name), field('Account email', email), el('p', { class: 'field-help', text: 'Use your own canonical profile, not a post or sign-in URL. Your password, verification codes and cookies do not belong in this form.' }), notice, submit);
  form.addEventListener('submit', (event) => { event.preventDefault(); void busy(submit, async () => {
    if (!name.value.trim()) throw new Error('Enter the name on this account.');
    const profileUrl = canonicalProfile(channel, identity.value.trim());
    const result = await api('account-register', { input: { provider: 'social-browser', externalAccountId: profileUrl, profileUrl, sender: { name: name.value.trim(), address: email.value.trim() }, purposes: ['social_publishing', ...(channel === 'linkedin' ? ['social_messaging', 'manual_correspondence'] : [])], secretRef: 'env:OUTREACH_BROWSER_SESSION', executionPlacement: 'daytona-browser' } });
    if (!result.accountId) throw new Error('The connection could not be confirmed. Refresh Accounts before trying again.');
    notice.textContent = 'Connection created. Open the private browser, sign in, then check your identity.';
    const check = button('Check session after login', () => busy(check, async () => { const status = await api('account-check', { accountId: result.accountId }); notice.textContent = status.status === 'ok' ? 'Your account identity is verified. You can now prepare posts for approval.' : `${status.status}: ${status.detail || 'Finish sign-in in the private browser, then check again.'}`; await refresh(); }), 'primary');
    form.replaceChildren(el('h3', { text: 'Your browser connection is ready' }), loginLink(data.liveViewUrl) || el('p', { class: 'field-help', text: 'The private login link is not configured. Ask the runtime administrator to refresh it, then return to Accounts.' }), notice, check); await refresh();
  }); });
  m.content.append(form); m.bottom.append(el('small', { text: 'Nothing is posted during account connection.' }), button('Finish later', m.close)); identity.focus();
}
export function renderAccounts(data, refresh) {
  const root = el('section', { class: 'content-panel' }, el('div', { class: 'panel-toolbar' }, el('h2', { text: 'Your channels, all together' })), el('p', { class: 'section-hint', text: 'Add accounts whenever you are ready. Sign in inside the private Daytona browser, then verify the account before scheduling.' }));
  const cards = el('div', { class: 'account-grid' });
  for (const p of PLATFORMS) {
    const accounts = accountsFor(data, p.id); const card = el('article', { class: 'account-card' }, el('div', { class: 'account-title' }, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), el('h3', { text: p.name })), el('p', { text: p.hint }));
    if (!accounts.length) card.append(badge('Not connected'), el('p', { text: 'Draft now, connect later. A verified browser identity is required before publishing.' }));
    for (const account of accounts) {
      const health = account.health || 'unknown'; const check = button('Check connection', () => busy(check, async () => { const result = await api('account-check', { accountId: account.id }); notify(result.status === 'ok' ? `${p.name} account verified.` : `${p.name}: ${result.detail || result.status}`); await refresh(); }), 'small');
      const reconnect = button('Reconnect', () => busy(reconnect, async () => { await api('account-reconnect', { accountId: account.id }); notify('Reconnect requested. Open private browser login, finish sign-in and check again.'); await refresh(); }), 'small');
      card.append(el('strong', { style: 'font-size:12px', text: accountName(account) }), el('p', { text: account.externalAccountId }), badge(health === 'ok' ? 'Connected' : health), el('div', { class: 'toolbar-group' }, check, reconnect), loginLink(data.liveViewUrl));
    }
    card.append(button(accounts.length ? 'Add another account' : `Connect ${p.name}`, () => connectPlatform(p.id, data, refresh), 'small')); cards.append(card);
  }
  root.append(cards, el('p', { class: 'inline-note', text: 'Native posting is validated for the selected account at queue and execution time. Platform challenges pause work for sign-in. Messages and connection requests are available for LinkedIn in the Outreach console; they are not enabled for X, Instagram or TikTok here.' })); return root;
}
