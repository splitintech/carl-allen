/* global document, URL */
import { el } from './dom.js';
let open = false;

export function privateLoginLink(url, text = 'Open secure browser login') {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return el('a', { class: 'connection-login', href: parsed.href, target: '_blank', rel: 'noopener noreferrer', text });
  } catch { return null; }
}

/** A resumable account connection. Credentials are entered only in the provider's browser. */
export function connectAccount(kind, liveViewUrl, act, restoreFocus) {
  if (open) return;
  open = true;
  const linkedIn = kind === 'linkedin';
  const mailbox = kind === 'gmail' || kind === 'outlook';
  const providerName = linkedIn ? 'LinkedIn' : kind === 'gmail' ? 'Gmail' : kind === 'outlook' ? 'Outlook' : 'Configured browser';
  const dialog = el('dialog', { class: 'decision-dialog connection-dialog', 'aria-labelledby': 'connection-title', 'aria-describedby': 'connection-description' });
  const title = el('h2', { id: 'connection-title', text: `Connect ${providerName}` });
  const description = el('p', { id: 'connection-description', class: 'hint', text: mailbox ? 'Mailbox connections use the provider’s permission screen. Passwords and access tokens never belong in this form.' : 'Create your connection now, or come back when you are ready. Sign in happens in your private Daytona browser.' });
  const content = el('div', { class: 'connection-content' });
  const cancel = el('button', { type: 'button', text: 'Set up later' });
  const notice = el('p', { class: 'connection-notice', role: 'status', 'aria-live': 'polite' });
  let busy = false;
  let closed = false;
  function finish() {
    if (closed || busy) return;
    closed = true; open = false;
    globalThis.removeEventListener('pagehide', hide);
    if (dialog.open) dialog.close();
    dialog.remove();
    (restoreFocus?.isConnected ? restoreFocus : document.getElementById('refresh'))?.focus();
  }
  const hide = () => { busy = false; finish(); };
  cancel.addEventListener('click', finish);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(); });
  dialog.addEventListener('close', finish);
  dialog.append(title, description, content, notice, el('div', { class: 'row' }, cancel));
  document.body.append(dialog);
  globalThis.addEventListener('pagehide', hide, { once: true });
  if (mailbox) {
    content.append(el('div', { class: 'connection-step', text: 'Mailbox setup is required' }), el('p', { text: `Ask your runtime administrator to connect ${providerName} with OAuth and grant draft access. Then refresh this console: the mailbox will appear under Connected accounts and Mailbox drafts.` }), el('p', { class: 'hint', text: 'This console does not yet open mailbox OAuth consent. Browser login alone does not connect a mailbox. Draft controls only save drafts; sending requires a separate approved workflow.' }));
  } else {
    const form = el('form', { class: 'connection-form' });
    const inputs = {};
    const fields = [
      { name: linkedIn ? 'profileUrl' : 'externalAccountId', label: linkedIn ? 'Your canonical LinkedIn profile URL' : 'Configured browser account ID', type: linkedIn ? 'url' : 'text', placeholder: linkedIn ? 'https://www.linkedin.com/in/your-name/' : 'Account ID supplied by your administrator' },
      { name: 'name', label: 'Your name', type: 'text', placeholder: 'Name on this account' },
      { name: 'address', label: 'Account email', type: 'email', placeholder: 'you@example.com' },
    ];
    form.append(el('p', { class: 'connection-step', text: '01 / Account details' }));
    for (const field of fields) {
      const id = `connect-${field.name}`;
      const input = el('input', { id, type: field.type, required: '', maxlength: field.name === 'name' ? '200' : '500', placeholder: field.placeholder, autocomplete: field.name === 'address' ? 'email' : field.name === 'name' ? 'name' : 'off' });
      inputs[field.name] = input;
      form.append(el('label', { for: id, text: field.label }), input);
    }
    form.append(el('p', { class: 'hint', text: linkedIn ? 'Use your own /in/ profile, not a company page. The session check will confirm you signed into this identity.' : 'An administrator must first configure this account’s permitted site, identity and tasks. This form cannot enable an unsupported social network.' }));
    const submit = el('button', { type: 'submit', class: 'primary', text: linkedIn ? 'Create browser connection' : 'Register configured account' });
    form.append(submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy) return;
      const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value.trim()]));
      if (linkedIn) {
        const url = new URL(values.profileUrl);
        if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || !/^\/in\/[^/?#]+\/?$/.test(url.pathname) || url.search || url.hash || url.username || url.password) {
          notice.textContent = 'Enter a profile URL such as https://www.linkedin.com/in/your-name/.'; inputs.profileUrl.focus(); return;
        }
        values.profileUrl = `https://www.linkedin.com${url.pathname.replace(/\/?$/, '/')}`;
      }
      busy = true; cancel.disabled = true; notice.textContent = 'Creating your connection…';
      const result = await act(submit, 'account-register', { input: { provider: 'social-browser', externalAccountId: linkedIn ? values.profileUrl : values.externalAccountId, ...(linkedIn ? { profileUrl: values.profileUrl } : {}), sender: { name: values.name, address: values.address }, purposes: linkedIn ? ['social_publishing', 'social_messaging', 'manual_correspondence'] : ['manual_correspondence'], secretRef: 'env:OUTREACH_BROWSER_SESSION', executionPlacement: 'daytona-browser' } }, 'Account saved. Sign in, then check the connection.');
      busy = false; cancel.disabled = false;
      if (closed) return;
      if (!result?.accountId) { notice.textContent = 'Connection was not confirmed. Check the error below, correct the details, then try again. If the request timed out, close this window and refresh before retrying.'; return; }
      showLogin(result.accountId);
    });
    content.append(form);
  }
  function showLogin(accountId) {
    notice.textContent = '';
    cancel.textContent = 'Finish later';
    const login = privateLoginLink(liveViewUrl);
    const check = el('button', { type: 'button', class: 'primary', text: 'Check session after login', onclick: async () => {
      if (busy) return; busy = true; cancel.disabled = true; notice.textContent = 'Checking the signed-in account…';
      const result = await act(check, 'account-check', { accountId }, 'Connection checked');
      busy = false; cancel.disabled = false;
      if (closed) return;
      if (result?.status === 'ok') {
        content.replaceChildren(el('p', { class: 'connection-step', text: '03 / Ready to use' }), el('h3', { class: 'connection-ready', text: 'Your account is connected' }), el('p', { text: 'You can now create drafts and queue actions for approval. Nothing has been posted or sent.' }));
        cancel.textContent = 'Done'; notice.textContent = ''; cancel.focus();
      } else {
        notice.textContent = result ? `${result.status === 'reauth_required' ? 'Sign-in is still needed' : 'The connection needs attention'}. ${result.detail || 'Open browser login, confirm the account identity, and try the check again.'}` : 'The check could not finish. Confirm the runtime is available, then try again.';
      }
    } });
    content.replaceChildren(el('p', { class: 'connection-step', text: '02 / Sign in & verify' }), el('h3', { text: 'Your browser connection is saved' }), el('p', { text: 'Open the private browser and sign into the account you just added. Complete any verification there, return here, then check the session. You can also finish later from Connected accounts.' }), login || el('p', { class: 'connection-notice', text: 'Browser login is not available yet. Ask your runtime administrator to configure the private login link, then refresh the console.' }), check);
    (login || check).focus();
  }
  try { dialog.showModal(); (content.querySelector('input') || cancel).focus(); } catch { finish(); }
}
