/* global window,sessionStorage,URL,location,setTimeout,clearTimeout */
import { el, button, field, modal, busy, notify } from './utils.js';
import { api } from './service.js';
export async function openMailboxConnection(data, refresh = () => {}, options = {}) {
  if (!data.roles.includes('admin')) return notify('An administrator must connect or reconnect a mailbox.');
  const m = modal(options.accountId ? 'Reconnect mailbox' : 'Connect a mailbox', 'Sign in with the provider. Credentials remain on the server; no passwords or tokens are entered here.'); let stopped = false; let sessionId = options.sessionId; let timer; m.dialog.addEventListener('close', () => { stopped = true; clearTimeout(timer); });
  const provider = el('select', { class: 'field-control', 'aria-label': 'Mail provider' }, ...['gmail', 'outlook', 'zoho'].map(name => el('option', { value: name, text: name === 'zoho' ? 'Zoho Mail · inbox and drafts' : name === 'gmail' ? 'Gmail' : 'Microsoft Outlook' }))); provider.value = options.provider || 'gmail'; provider.disabled = !!options.accountId;
  const region = el('select', { class: 'field-control', 'aria-label': 'Zoho data center' }, ...[['us','United States'],['eu','Europe'],['in','India'],['au','Australia'],['jp','Japan'],['ca','Canada'],['cn','China'],['ae','United Arab Emirates'],['sa','Saudi Arabia']].map(([value,text]) => el('option', {value,text})));
  const outreach = el('input', {type:'checkbox',disabled:true}); const outreachField = field('I confirm this mailbox permits reviewed automated outreach under its provider policy',outreach); let outreachAllowed = new Set();
  const regionField = field('Zoho data center', region); const state = el('div', { role: 'status', 'aria-live': 'polite', class: 'flow-note', text: 'Checking configured providers…' }); const controls = el('div'); m.content.append(field('Mail provider', provider), regionField, ...(!options.accountId?[outreachField]:[]), state, controls);
  function showRegion() { regionField.hidden = provider.value !== 'zoho'; outreach.disabled = !!options.accountId || !outreachAllowed.has(provider.value); if(outreach.disabled)outreach.checked=false; outreachField.hidden = !!options.accountId || !outreachAllowed.has(provider.value); } provider.addEventListener('change', showRegion); showRegion();
  const close = () => { stopped = true; clearTimeout(timer); m.close(); }; m.bottom.append(button('Close', close));
  async function poll() {
    if (stopped || !sessionId) return;
    try {
      const value = await api('mailbox-oauth-status', { sessionId });
      if (value.status === 'connected') { sessionStorage.removeItem('carl-mailbox-session'); state.textContent = 'Mailbox connected. Future work still requires its own review.'; controls.replaceChildren(); await refresh(); return; }
      if (['failed', 'expired'].includes(value.status)) { state.className = 'banner error'; state.textContent = value.detail || 'Connection expired. Close this window and start again.'; return; }
      if (value.status === 'select_mailbox') {
        state.textContent = options.accountId ? 'Choose the original mailbox to finish reconnecting.' : 'The provider verified these mailboxes. Choose one to connect.';
        const picker = el('select', { class: 'field-control', 'aria-label': 'Verified mailbox' }, ...(value.mailboxes || []).map(mailbox => el('option', { value: mailbox.id, text: `${mailbox.name} · ${mailbox.address}` })));
        const complete = button('Connect selected mailbox', () => busy(complete, async () => { await api('mailbox-oauth-complete', { sessionId, mailboxId: picker.value }); await poll(); }), 'primary'); controls.replaceChildren(field('Mailbox', picker), complete); return;
      }
      state.textContent = 'Waiting for provider consent. Complete sign-in in the other tab; this screen checks automatically.'; timer = setTimeout(poll, 2000);
    } catch (error) { state.className = 'banner error'; state.textContent = error.message; controls.append(button('Check connection again', poll, 'small')); }
  }
  if (sessionId) { await poll(); return m; }
  try {
    const config = await api('mailbox-oauth-config'); outreachAllowed = new Set(config.providers.filter(p=>p.automatedOutreachAllowed).map(p=>p.provider)); const enabled = new Set(config.providers.filter(p => p.configured).map(p => p.provider));
    for (const option of provider.options) option.disabled = !enabled.has(option.value); if (!enabled.has(provider.value) && !options.accountId) provider.value = [...enabled][0] || 'gmail'; showRegion();
    state.textContent = enabled.size ? 'Provider permissions include reading and editing mailbox drafts. Gmail/Outlook sends still require separately approved work. Zoho has no automated sending.' : 'No web mailbox provider is configured. An administrator must set the deployment OAuth client credentials and approved callback URLs.';
    const start = button('Continue to provider', () => busy(start, async () => {
      const popup = window.open('about:blank', '_blank'); let result; try { result = await api('mailbox-oauth-start', { input: { provider: provider.value, region: region.value, accountId: options.accountId, redirectOrigin: location.origin, automatedOutreach: outreach.checked } }); } catch (error) { popup?.close(); throw error; }
      sessionId = result.sessionId; sessionStorage.setItem('carl-mailbox-session', sessionId); provider.disabled = true; region.disabled = true; start.remove();
      if (popup) { popup.opener = null; popup.location.replace(result.authorizationUrl); } controls.append(el('a', { class: 'button', href: result.authorizationUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Open provider sign-in' })); await poll();
    }), 'primary'); start.disabled = !enabled.size || !enabled.has(provider.value); provider.addEventListener('change', () => { start.disabled = !enabled.has(provider.value); }); m.bottom.append(start);
  } catch (error) { state.className = 'banner error'; state.textContent = error.message; }
  return m;
}
export function resumeMailboxConnection(data, refresh) { const sessionId = new URL(location.href).searchParams.get('mailboxSession') || sessionStorage.getItem('carl-mailbox-session'); if (sessionId && data.roles.includes('admin')) return openMailboxConnection(data, refresh, { sessionId }); }
export function disconnectMailbox(account, refresh) {
  const m = modal('Disconnect mailbox', 'Future work and approvals for this account will be stopped. Existing receipts and uncertain outcomes remain available.'); const reason = el('textarea', { class: 'field-control', rows: 3, required: true, 'aria-label': 'Disconnect reason' }); m.content.append(field('Reason', reason));
  const confirm = button('Disconnect and revoke grant', () => busy(confirm, async () => { if (!reason.value.trim()) throw new Error('Enter a disconnect reason.'); const result = await api('mailbox-disconnect', { accountId: account.id, reason: reason.value.trim() }); m.content.replaceChildren(el('p', { class: 'flow-note', text: `${result.revocation.detail} ${result.localGrantRemoved ? 'The private grant file was removed.' : 'No private file removal was confirmed.'}` })); m.bottom.replaceChildren(button('Close', m.close)); if (result.revocation.url) m.content.append(el('a', { class: 'button', href: result.revocation.url, target: '_blank', rel: 'noopener noreferrer', text: 'Manage provider consent' })); await refresh(); }), 'danger'); m.bottom.append(button('Keep connected', m.close), confirm);
}
