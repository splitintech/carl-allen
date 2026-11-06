import { el, button, badge, empty, dateText, busy, notify } from './utils.js';
import { platform, accountName, draftStatus } from './model.js';
import { api } from './service.js';
export function renderDrafts(data, edit, refresh, create) {
  const root = el('section', { class: 'content-panel' }, el('div', { class: 'panel-toolbar' }, el('h2', { text: 'Ideas, plans & published work' }), el('span', { class: 'muted', style: 'font-size:10px', text: `${data.drafts.length} saved items` })));
  if (!data.drafts.length) { root.append(empty('Good ideas deserve a place to land.', 'Save a thought, add your media, and come back when it is ready. Drafts never publish on their own.', create)); return root; }
  const list = el('div', { class: 'queue-list' });
  for (const draft of [...data.drafts].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const p = platform(draft.posts[0]?.channel); const locked = data.actions.some((a) => draft.actionIds?.includes(a.id) && ['executing', 'succeeded', 'uncertain', 'reconciling', 'review'].includes(a.state)); const controls = el('div', { class: 'queue-actions' }, locked ? button('Duplicate as new draft', () => edit({ ...draft, id: undefined, actionIds: [], status: 'draft', name: `${draft.name} (copy)`, scheduledFor: new Date(Date.now() + 3600000).toISOString() }), 'small') : button('Edit draft', () => edit(draft), 'small'));
    const remove = button('Delete', () => {
      const warning = el('div', { class: 'banner', text: 'Delete this draft? Pending posts created from it will be cancelled. This cannot be undone.' });
      const yes = button('Delete this draft', () => busy(yes, async () => { await api('publishing-draft-delete', { draftId: draft.id }); await refresh(); notify('Draft deleted.'); }), 'small danger');
      controls.replaceChildren(warning, button('Keep draft', () => refresh(), 'small'), yes);
    }, 'small'); if (!locked) controls.append(remove);
    list.append(el('article', { class: 'queue-card' }, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), el('div', {}, el('h3', { text: draft.name }), el('p', { text: draft.posts[0]?.text || 'Media post' }), el('div', { class: 'queue-meta' }, badge(draftStatus(draft, data.actions)), el('span', { text: draft.posts.map((post) => platform(post.channel).name).join(' · ') }), el('span', { text: dateText(draft.scheduledFor, draft.timezone) })), ...(draft.blocked || []).map((item) => el('p', { class: 'field-help', text: `${platform(item.channel).name}: ${item.reason}` }))), controls));
  }
  root.append(list); return root;
}
export function renderQueue(data, detail, create) {
  const pending = data.actions.filter((a) => !['cancelled', 'failed', 'succeeded'].includes(a.state)); const approved = data.actions.filter((a) => a.state === 'scheduled'); const waiting = data.actions.filter((a) => a.state === 'awaiting_approval');
  const summary = el('div', { class: 'summary-row' }, ...[['In your queue', pending.length], ['Waiting for approval', waiting.length], ['Ready for their time', approved.length]].map(([label, value]) => el('div', { class: 'summary-box', text: label }, el('strong', { text: String(value) }))));
  const panel = el('section', { class: 'content-panel' }, el('div', { class: 'panel-toolbar' }, el('h2', { text: 'Every post, every step' }), el('span', { class: 'muted', style: 'font-size:10px', text: 'Actual engine delivery states' })));
  if (!data.actions.length) panel.append(empty('Nothing in the queue. Yet.', 'Once a draft is submitted, its platform posts appear here for approval and delivery tracking.', create));
  else { const list = el('div', { class: 'queue-list' }); for (const action of [...data.actions].sort((a, b) => a.dueAt - b.dueAt)) { const p = platform(action.channel); list.append(el('article', { class: 'queue-card' }, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), el('div', {}, el('h3', { text: `${p.name} · ${accountName(data.accounts.find((a) => a.id === action.providerAccountId))}` }), el('p', { text: action.text || 'Media-only post' }), el('div', { class: 'queue-meta' }, badge(action.state), el('span', { text: dateText(action.dueAt) }), el('span', { text: `${action.mediaIds.length} attachment${action.mediaIds.length === 1 ? '' : 's'}` })), action.reason ? el('p', { class: 'field-help', text: action.reason }) : null), el('div', { class: 'queue-actions' }, button(action.state === 'awaiting_approval' ? 'Review & approve' : 'View details', () => detail(action), 'small')))); } panel.append(list); }
  return el('div', {}, summary, panel);
}
