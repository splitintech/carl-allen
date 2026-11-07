import { applyCapabilities } from './model.js';
/* global document, location, history, URL, URLSearchParams, setInterval, clearInterval */
import './navigation.js';
import { sendingControl } from './kill.js';
import { $, el, button, notify } from './utils.js';
import { platform, accountName } from './model.js';
import { api } from './service.js';
import { openComposer } from './composer.js';
import { renderCalendar } from './calendar.js';
import { renderDrafts, renderQueue } from './queue.js';
import { renderLibrary } from './library.js';
import { reviewAction } from './review.js';
import { renderCreate, openImport } from './work-packages.js';
import { renderHome, renderPeople, renderOutreach, renderInbox, renderInsights, renderSettings } from './panels.js';
import { icon, mountIcons } from './icons.js';
let data = { accounts: [], drafts: [], media: [], actions: [], approvals: [], roles: [], workPackages: [], people: [], sequences: [], threads: [], members: [], invitations: [], metrics: {}, errors: {} };
const query = new URLSearchParams(location.search);
const state = { view: query.get('view') || 'calendar', month: query.get('month') && /^\d{4}-\d{2}$/.test(query.get('month')) ? new Date(`${query.get('month')}-01T12:00:00`) : new Date(), channel: query.get('channel') || '', accountId: query.get('account') || '', timezone: query.get('timezone') || 'America/New_York', calendarMode: query.get('mode') || 'month', status: query.get('status') || '', tag: query.get('tag') || '', createTab: 'packages', settingsTab: 'accounts', inboxTab: 'conversations' }; let refreshing = false;
const views = { home: ['Home', 'Keep your work moving', 'Your upcoming work, pending reviews and account health.', 'home'], create: ['Create', 'Bring your next idea to life', 'Research in Papr or ChatGPT. Prepare the exact work here.', 'spark'], calendar: ['Publish', 'Publish', 'Your calendar, your channels, your timing.', 'calendar'], queue: ['Publish', 'Publishing queue', 'Every publication and its actual delivery state.', 'list'], drafts: ['Create', 'Drafts & plans', 'Keep your work private until it is ready for review.', 'spark'], media: ['Create', 'Media library', 'Upload once and reuse immutable files in your plans.', 'grid'], people: ['People', 'Know who you are reaching', 'Real contacts, explicit channel identities and retained research sources.', 'people'], outreach: ['Outreach', 'Start the right conversation', 'Reviewed sequences, coordinated follow-ups and independent cloud execution.', 'send'], inbox: ['Inbox', 'Keep the conversation together', 'Supported account conversations, assignments and mailbox drafts.', 'inbox'], insights: ['Insights', 'Follow the work through', 'Delivery and outreach outcomes from the engine.', 'chart'], accounts: ['Settings', 'Accounts & connections', 'Sign in inside Daytona. Verify the right identity before publishing.', 'settings'], settings: ['Settings', 'Your workspace, your rules', 'Manage accounts, teammates and integration settings.', 'settings'] };
if (!views[state.view]) state.view = 'calendar';
function create(draft) { openComposer(data, refresh, draft?.posts ? draft : undefined); }
function detail(action) { reviewAction(action, data, refresh, create); }
function change(view) { state.view = view; render(); }
function setState() {
  const url = new URL(location.href); for (const [key, value] of Object.entries({ view: state.view, month: `${state.month.getFullYear()}-${String(state.month.getMonth() + 1).padStart(2, '0')}`, channel: state.channel, account: state.accountId, timezone: state.timezone, mode: state.calendarMode, status: state.status, tag: state.tag })) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); } history.replaceState(null, '', url);
}
function sidebar() {
  const accounts = data.accounts.filter((a) => a.capabilities?.socialPublish); const root = $('sidebar-channels');
  if (!accounts.length) { root.replaceChildren(el('p', { class: 'privacy-note', text: 'Connect your first account when you are ready.' })); return; }
  root.replaceChildren(...accounts.map((account) => { const channel = account.capabilities.socialChannels?.[0] || 'linkedin'; const p = platform(channel); const pending = data.actions.filter((action) => action.providerAccountId === account.id && !['succeeded', 'cancelled', 'failed'].includes(action.state)).length; const name = accountName(account); const control = button('', () => { state.accountId = state.accountId === account.id ? '' : account.id; state.view = 'calendar'; render(); void refresh(); }, `channel-row ${state.accountId === account.id ? 'selected' : ''}`); control.setAttribute('aria-label', `Filter calendar by ${p.name} account ${name}`); control.setAttribute('aria-pressed', String(state.accountId === account.id)); control.append(el('span', { class: 'channel-avatar', 'aria-hidden': 'true', text: name.slice(0, 2).toUpperCase() }, el('span', { class: `tiny-icon ${p.id}`, text: p.icon })), el('span', { class: 'channel-name', text: name }), el('span', { class: 'channel-count', text: pending.toLocaleString() })); return control; }));
}
function render() {
  const [name, title, description, symbol] = views[state.view]; $('view-breadcrumb').textContent = name; $('view-title').textContent = title; $('view-description').textContent = description; $('view-icon').replaceChildren(icon(symbol)); $('page-heading').hidden = state.view === 'calendar';
  document.querySelectorAll('[data-view]').forEach((control) => { const active = control.dataset.view === state.view || (control.dataset.view === 'create' && ['drafts', 'media'].includes(state.view)) || (control.dataset.view === 'settings' && state.view === 'accounts'); control.classList.toggle('active', active); control.setAttribute('aria-current', active ? 'page' : 'false'); });
  $('draft-count').textContent = String(data.drafts.filter((draft) => !draft.actionIds?.length).length);
  const paused = Boolean(data.sendingStopped); const globalPause = data.sendingStopScopes?.includes('global'); const stop = $('stop-studio'); const resumeAllowed = data.roles.some((role) => ['admin', 'approver'].includes(role));
  stop.textContent = globalPause ? 'Sending paused' : paused ? 'Resume sending' : 'Stop all sending'; stop.disabled = globalPause || (paused ? !resumeAllowed : !data.roles.some((role) => ['admin', 'operator'].includes(role)));
  $('sending-banner').hidden = !paused; $('sending-banner').textContent = globalPause ? 'A global administrator hold has paused sending. Contact an administrator before resuming.' : 'Workspace sending is paused. Drafts and approved schedules are kept. An approver can resume sending.';
  $('new-post').disabled = !data.roles.some((role) => ['admin', 'operator'].includes(role)); $('sidebar-new').disabled = $('new-post').disabled;
  let content;
  if (state.view === 'calendar') content = renderCalendar(data, state, create, detail, () => { setState(); render(); void refresh(); }, create);
  else if (state.view === 'queue') content = renderQueue(data, detail, create);
  else if (state.view === 'drafts') content = renderDrafts(data, create, refresh, create);
  else if (state.view === 'media') content = renderLibrary(data, refresh);
  else if (state.view === 'create') content = renderCreate(data, state, refresh, (kind) => kind === 'media' ? renderLibrary(data, refresh) : renderDrafts(data, create, refresh, create), (tab) => { state.createTab = tab; render(); });
  else if (state.view === 'people') content = renderPeople(data, refresh);
  else if (state.view === 'outreach') content = renderOutreach(data, refresh);
  else if (state.view === 'inbox') content = renderInbox(data, refresh, state.inboxTab, (tab) => { state.inboxTab = tab; render(); });
  else if (state.view === 'insights') content = renderInsights(data);
  else if (['settings', 'accounts'].includes(state.view)) content = renderSettings(data, refresh, state.view === 'accounts' ? 'accounts' : state.settingsTab, (tab) => { state.view = 'settings'; state.settingsTab = tab; render(); });
  else content = renderHome(data, change, refresh);
  const dependency = { calendar: 'publishing-page', create: 'work-packages-list', people: 'people-list', outreach: 'outreach-list', inbox: 'inbox-list', insights: 'insights', settings: 'team-list' }[state.view];
  $('studio-body').replaceChildren(...(dependency && data.errors[dependency] ? [el('div', { class: 'banner error', role: 'status', text: `${data.errors[dependency]} This area could not refresh; any shown data is from the last successful snapshot.` })] : []), content);
  sidebar(); setState();
}
async function pages(action, key, params = {}) {
  const rows = []; const seen = new Set(); let cursor;
  do { const value = await api(action, { ...params, ...(cursor ? { cursor } : {}), limit: 200 }); if (!Array.isArray(value[key])) return null; rows.push(...value[key]); if (rows.length > 20000) throw new Error('This view has more than 20,000 items. Narrow the date range before continuing.'); cursor = value.nextCursor; if (cursor && seen.has(cursor)) throw new Error('The server returned a repeated page. Refresh before relying on this view.'); if (cursor) seen.add(cursor); } while (cursor);
  return rows;
}
export async function refresh() {
  if (refreshing) return; refreshing = true; $('refresh-studio').disabled = true;
  try {
    const snapshot = await api('publishing-overview'); applyCapabilities(snapshot.limits); data = { ...data, ...snapshot }; for (const key of ['accounts', 'drafts', 'media', 'actions', 'approvals', 'roles']) data[key] ||= [];
    const requests = [['work-packages-list', 'workPackages', 'packages'], ['people-list', 'people', 'people'], ['outreach-list', 'sequences', 'sequences'], ['inbox-list', 'threads', 'threads'], ['team-list', 'members', 'members'], ['insights', 'metrics', 'metrics'], ['storage-settings','storage','storage'],['policy-settings','executionPolicy','policy']];
    const results = await Promise.allSettled(requests.map(async ([action]) => { if (['work-packages-list','people-list','outreach-list','inbox-list'].includes(action)) { const key={'work-packages-list':'packages','people-list':'people','outreach-list':'sequences','inbox-list':'threads'}[action]; const items=await pages(action,key); return {[key]:items||[]}; } return api(action); }));
    for (let i = 0; i < requests.length; i++) { const [action, target, key] = requests[i]; const result = results[i]; if (result.status === 'fulfilled') { data[target] = result.value[key] || (target === 'metrics' ? {} : []); if (action === 'team-list') data.invitations = result.value.invitations || []; delete data.errors[action]; } else data.errors[action] = result.reason?.message || 'Data is unavailable.'; }
    const from = Date.UTC(state.month.getFullYear(), state.month.getMonth(), -6); const to = Date.UTC(state.month.getFullYear(), state.month.getMonth() + 1, 8);
    const paged = await Promise.allSettled([pages('publishing-actions-page', 'actions', { from, to }), pages('publishing-drafts-page', 'drafts')]);
    for (let i = 0; i < paged.length; i++) { const result = paged[i]; if (result.status === 'fulfilled' && result.value) data[i === 0 ? 'actions' : 'drafts'] = result.value; else if (result.status === 'rejected') data.errors['publishing-page'] = result.reason?.message || 'Publication pagination failed.'; }
    if (paged.every((value) => value.status === 'fulfilled')) delete data.errors['publishing-page'];
    $('runtime-state').textContent = 'Workspace connected'; $('runtime-dot').classList.add('ready'); $('connection-banner').hidden = true; $('workspace-name').textContent = snapshot.workspaceName || 'Your workspace'; render();
  } catch (error) {
    $('runtime-state').textContent = 'Connection needs attention'; $('runtime-dot').classList.remove('ready'); const banner = $('connection-banner'); banner.hidden = false; banner.replaceChildren(el('span', { text: `${error.message} Latest status is unavailable. Your existing approved schedules may continue in Daytona.` })); if (/sign.in|authentication|session/i.test(error.message)) banner.append(el('a', { class: 'button small', href: '/auth/login', text: 'Continue with Google' })); banner.classList.add('error'); render();
  } finally { refreshing = false; $('refresh-studio').disabled = false; }
}
function newWork() { const area = el('div', { class: 'banner', role: 'region', 'aria-label': 'New work' }, button('Create a post', () => { area.remove(); create(); }, 'primary'), button('Import HTML & media', () => { area.remove(); openImport(data, refresh); }), button('Connect an account', () => { area.remove(); change('accounts'); }), button('Close', () => area.remove(), 'small')); $('studio-body').prepend(area); }
mountIcons(); $('stop-studio').addEventListener('click', () => sendingControl(refresh, Boolean(data.sendingStopped)));
$('new-post').addEventListener('click', () => create()); $('sidebar-new').addEventListener('click', newWork); $('refresh-studio').addEventListener('click', () => { void refresh(); });
document.querySelectorAll('[data-view]').forEach((control) => control.addEventListener('click', () => change(control.dataset.view)));
if (location.protocol === 'file:') { notify('Offline interface preview. Open Carl-Allen through the trusted server or Papr to use the private workspace.'); }
void refresh(); const timer = setInterval(() => { if (!document.querySelector('dialog[open]')) void refresh(); }, 30000); globalThis.addEventListener('pagehide', () => clearInterval(timer));
