/* global document, location, setInterval, clearInterval */
import './navigation.js';
import { sendingControl } from './kill.js';
import { $, el, notify } from './utils.js';
import { PLATFORMS, accountsFor } from './model.js';
import { api } from './service.js';
import { openComposer } from './composer.js';
import { renderCalendar } from './calendar.js';
import { renderDrafts, renderQueue } from './queue.js';
import { renderLibrary } from './library.js';
import { renderAccounts } from './accounts.js';
import { reviewAction } from './review.js';
let data = { accounts: [], drafts: [], media: [], actions: [], approvals: [], roles: [] };
const state = { view: 'calendar', month: new Date(), channel: '' }; let refreshing = false;
const views = {
  calendar: ['Calendar', 'A little planning.\nA bigger presence.', 'One place for the posts you want to put into the world.'],
  queue: ['Publishing queue', 'Good things,\nright on time.', 'Review, approve and follow every post through to delivery.'],
  drafts: ['Drafts & plans', 'Keep the idea.\nFind the right words.', 'A quiet space for the things you are not quite ready to share.'],
  media: ['Media library', 'Your creative work,\nready for its moment.', 'Upload once. Reuse across your platform-specific posts.'],
  accounts: ['Accounts', 'Show up where\nyour people are.', 'Connect LinkedIn, X, Instagram and TikTok when you are ready.'],
};
function create(draft) { openComposer(data, refresh, draft); }
function detail(action) { reviewAction(action, data, refresh); }
function change(view) { state.view = view; render(); }
function render() {
  const [name, title, description] = views[state.view]; $('view-breadcrumb').textContent = name; $('view-title').textContent = title; $('view-title').style.whiteSpace = 'pre-line'; $('view-description').textContent = description;
  document.querySelectorAll('[data-view]').forEach((control) => { control.classList.toggle('active', control.dataset.view === state.view); control.setAttribute('aria-current', control.dataset.view === state.view ? 'page' : 'false'); });
  $('draft-count').textContent = String(data.drafts.filter((d) => !d.actionIds?.length).length);
  const paused = Boolean(data.sendingStopped); const globalPause = data.sendingStopScopes?.includes('global'); const stop = $('stop-studio'); const resumeAllowed = !data.roles.length || data.roles.some((role) => ['admin', 'approver'].includes(role));
  stop.textContent = globalPause ? 'Sending paused' : paused ? 'Resume sending' : 'Stop all sending'; stop.disabled = globalPause || (paused ? !resumeAllowed : data.roles.length > 0 && !data.roles.some((role) => ['admin', 'operator'].includes(role)));
  $('sending-banner').hidden = !paused; $('sending-banner').textContent = globalPause ? 'Sending is paused by a global administrator hold. Contact your administrator before resuming.' : 'Workspace sending is paused. Your drafts and approved schedules are kept, and posts will wait until an approver resumes sending.';
  $('platform-strip').replaceChildren(...PLATFORMS.map((p) => { const accounts = accountsFor(data, p.id); const connected = accounts.filter((a) => a.health === 'ok').length; return el('button', { type: 'button', class: 'platform-card', onclick: () => change('accounts'), 'aria-label': `${p.name}: ${accounts.length ? `${connected} verified accounts` : 'connect an account'}` }, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), el('span', {}, el('strong', { text: p.name }), el('small', { text: accounts.length ? `${connected} verified · ${accounts.length} added` : 'Add your account' })), el('span', { class: 'platform-more', 'aria-hidden': 'true', text: '↗' })); }));
  const content = state.view === 'calendar' ? renderCalendar(data, state, create, detail, render, create) : state.view === 'queue' ? renderQueue(data, detail, create) : state.view === 'drafts' ? renderDrafts(data, create, refresh, create) : state.view === 'media' ? renderLibrary(data, refresh) : renderAccounts(data, refresh);
  $('studio-body').replaceChildren(content);
}
export async function refresh() {
  if (refreshing) return; refreshing = true; $('refresh-studio').disabled = true;
  try {
    const snapshot = await api('publishing-overview'); data = { ...data, ...snapshot }; for (const key of ['accounts', 'drafts', 'media', 'actions', 'approvals']) data[key] ||= [];
    $('new-post').disabled = data.roles.length > 0 && !data.roles.some((role) => ['admin', 'operator'].includes(role)); $('runtime-state').textContent = 'Workspace connected'; $('runtime-dot').classList.add('ready'); $('connection-banner').hidden = true; render();
  } catch (error) {
    $('runtime-state').textContent = 'Connection needs attention'; $('runtime-dot').classList.remove('ready'); const banner = $('connection-banner'); banner.hidden = false; banner.textContent = `${error.message} Latest status is unavailable. Your existing approved schedules may continue in Daytona.`; banner.classList.add('error'); render();
  } finally { refreshing = false; $('refresh-studio').disabled = false; }
}
$('stop-studio').addEventListener('click', () => sendingControl(refresh, Boolean(data.sendingStopped)));
$('new-post').addEventListener('click', () => create()); $('refresh-studio').addEventListener('click', () => { void refresh(); });
document.querySelectorAll('[data-view]').forEach((control) => control.addEventListener('click', () => change(control.dataset.view)));
if (location.protocol === 'file:') { $('new-post').disabled = true; notify('Offline interface preview. Open this page through Papr or the local studio server to use your private workspace.'); }
void refresh(); const timer = setInterval(() => { if (!document.querySelector('dialog[open]')) void refresh(); }, 30000);
globalThis.addEventListener('pagehide', () => clearInterval(timer));
