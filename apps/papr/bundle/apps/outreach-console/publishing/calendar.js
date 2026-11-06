import { el, button, dateText } from './utils.js';
import { platform } from './model.js';
export function renderCalendar(data, state, onEdit, onAction, onChange, onCreate) {
  const root = el('section', { class: 'content-panel', 'aria-label': 'Publishing calendar' });
  const month = new Date(state.month.getFullYear(), state.month.getMonth(), 1); const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month);
  const filter = el('select', { class: 'filter-select', 'aria-label': 'Filter by platform' }, el('option', { value: '', text: 'All platforms' }), ...['linkedin', 'x', 'instagram', 'tiktok'].map((id) => el('option', { value: id, text: platform(id).name }))); filter.value = state.channel;
  filter.addEventListener('change', () => { state.channel = filter.value; onChange(); });
  const move = (amount) => { state.month = new Date(month.getFullYear(), month.getMonth() + amount, 1); onChange(); };
  const toolbar = el('div', { class: 'panel-toolbar' }, el('div', { class: 'toolbar-group' }, el('h2', { text: title }), el('button', { type: 'button', class: 'text-button', 'aria-label': 'Previous month', text: '‹', onclick: () => move(-1) }), el('button', { type: 'button', class: 'text-button', 'aria-label': 'Next month', text: '›', onclick: () => move(1) }), button('Today', () => { state.month = new Date(); onChange(); }, 'small')), el('div', { class: 'toolbar-group' }, filter));
  const weekdays = el('div', { class: 'calendar-weekdays' }, ...['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((day) => el('div', { text: day })));
  const grid = el('div', { class: 'calendar-grid' }); const start = new Date(month); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); const today = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const events = [...data.actions.map((a) => ({ ...a, when: new Date(a.dueAt), click: () => onAction(a), label: a.text || 'Media post' })), ...data.drafts.filter((d) => !d.actionIds?.length).flatMap((d) => d.posts.map((p) => ({ ...p, when: new Date(d.scheduledFor), state: d.status, label: d.name, click: () => onEdit(d) })))].filter((e) => e.state !== 'cancelled' && (!state.channel || e.channel === state.channel));
  const days = Math.ceil((((month.getDay() + 6) % 7) + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
  for (let i = 0; i < days; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i); const cell = el('div', { class: `calendar-cell ${day.getMonth() !== month.getMonth() ? 'other' : ''}` }, el('time', { class: `calendar-number ${sameDay(day, today) ? 'today' : ''}`, datetime: day.toISOString(), text: String(day.getDate()) }));
    for (const event of events.filter((e) => sameDay(e.when, day))) { const p = platform(event.channel); const label = `${p.name} · ${event.label} · ${dateText(event.when)}`; cell.append(el('button', { type: 'button', class: `calendar-post ${['draft', 'blocked', 'awaiting_approval', 'queued'].includes(event.state) ? 'waiting' : ['failed', 'uncertain', 'review'].includes(event.state) ? 'failed' : ''}`, title: label, 'aria-label': label, onclick: event.click }, el('span', { class: 'tiny-icon', text: p.icon }), el('span', { text: event.label }))); }
    grid.append(cell);
  }
  root.append(toolbar, weekdays, grid, el('div', { class: 'panel-caption' }, el('span', { text: events.length ? `${events.length} platform post${events.length === 1 ? '' : 's'} in your workspace · times displayed in your browser’s time zone` : 'A clean slate. Make space for your first post.' }), el('div', { class: 'legend' }, el('span', {}, el('i'), 'Scheduled'), el('span', {}, el('i', { class: 'amber' }), 'Draft / approval'))));
  if (!events.length) root.append(el('div', { class: 'section-hint' }, 'Plan a post, choose its channels, then review and approve it before it publishes. ', button('Plan your first post', onCreate, 'small')));
  return root;
}
