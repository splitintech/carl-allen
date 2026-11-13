import { el, button, busy } from './utils.js';
import { accountName, platform } from './model.js';
import { api } from './service.js';
import { socialConnect } from './social-connect.js';
import { openMailboxConnection } from './mailbox-connect.js';

export function packageMappings(manifest, pack, data, refresh, changed) {
  const accountMap = { ...(pack.accountMap || {}) }; const mediaMap = { ...(pack.mediaMap || {}) };
  const grid = el('div', { class: 'mapping-grid' }); const redraw = [];
  const canEdit = data.roles?.some((role) => ['admin', 'operator', 'approver'].includes(role)); const admin = data.roles?.includes('admin');
  const updateAccounts = async () => { const value = await api('publishing-overview'); if (value.accounts) data.accounts = value.accounts; redraw.forEach((draw) => draw()); await refresh(); };
  for (const ref of manifest.accountRefs || []) {
    const control = el('select', { class: 'field-control', id: `map-account-${ref.id}`, 'aria-label': `Map account ${ref.label}`, disabled: !canEdit });
    const status = el('div', { class: 'mapping-account-status', role: 'status', 'aria-live': 'polite' });
    const column = el('div', { class: 'stack mapping-account-control' }, control, status);
    const draw = () => {
      const available = (data.accounts || []).filter((account) => ref.channel === 'email' ? ['gmail', 'outlook', 'zoho', 'fake-email'].includes(account.provider) : account.capabilities?.socialChannels?.includes(ref.channel));
      control.replaceChildren(el('option', { value: '', text: 'Choose a connected account…' }), ...available.map((account) => el('option', { value: account.id, text: `${accountName(account)} · ${account.externalAccountId || account.provider} · ${account.health === 'ok' ? 'Connected' : 'Needs attention'}` })));
      if (accountMap[ref.id] && !available.some((account) => account.id === accountMap[ref.id])) control.append(el('option', { value: accountMap[ref.id], text: 'Previously mapped account is unavailable' }));
      control.value = accountMap[ref.id] || '';
      const account = available.find((item) => item.id === control.value); const healthy = account?.health === 'ok' && !account.lifecycle;
      const detail = !control.value ? 'Choose an account before preparing this plan.' : !account ? 'This account is unavailable. Choose another connected account.' : healthy ? 'Account connection is healthy.' : `${accountName(account)} needs attention: ${account.health === 'reauth_required' ? 'sign in again in the private browser' : account.lifecycle?.status || account.health || 'connection status unknown'}.`;
      status.replaceChildren(el('p', { class: healthy ? 'field-help' : 'field-help account-needs-attention', text: detail }));
      if (account && !healthy) {
        const reconnect = button(ref.channel === 'email' ? 'Reconnect mailbox' : `Reconnect ${platform(ref.channel).name}`, () => ref.channel === 'email' ? openMailboxConnection(data, updateAccounts, { provider: account.provider, accountId: account.id }) : socialConnect(ref.channel, updateAccounts, account), 'small'); reconnect.disabled = !admin;
        status.append(reconnect); if (!admin) status.append(el('p', { class: 'field-help', text: 'An administrator must complete sign-in for this account.' }));
      }
      if (account) {
        const check = button('Check connection', () => busy(check, async () => { const result = await api('account-check', { accountId: account.id }); account.health = result.status; await updateAccounts(); }), 'small'); check.disabled = !canEdit; status.append(check);
      } else if (!control.value && admin) status.append(button(ref.channel === 'email' ? 'Connect mailbox' : `Connect ${platform(ref.channel).name}`, () => ref.channel === 'email' ? openMailboxConnection(data, updateAccounts) : socialConnect(ref.channel, updateAccounts), 'small'));
    };
    control.addEventListener('change', () => { if (control.value) accountMap[ref.id] = control.value; else delete accountMap[ref.id]; draw(); changed(); });
    redraw.push(draw); draw(); grid.append(el('label', { for: control.id, text: `${ref.label} · ${ref.channel}` }), column);
  }
  for (const ref of manifest.media || []) {
    const control = el('select', { class: 'field-control', id: `map-media-${ref.id}`, 'aria-label': `Map media ${ref.name}`, disabled: !canEdit }, el('option', { value: '', text: 'Choose an uploaded file…' }), ...(data.media || []).map((asset) => el('option', { value: asset.id, text: `${asset.name} · ${(asset.size / 1048576).toFixed(1)} MB` })));
    control.value = mediaMap[ref.id] || ''; control.addEventListener('change', () => { if (control.value) mediaMap[ref.id] = control.value; else delete mediaMap[ref.id]; changed(); }); grid.append(el('label', { for: control.id, text: ref.name }), control);
  }
  return { accountMap, mediaMap, panel: grid.childNodes.length ? el('section', { class: 'info-card' }, el('h3', { text: 'Connect the plan to your workspace' }), grid) : null };
}
