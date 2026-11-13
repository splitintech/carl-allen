/* global URL */
import { el } from './utils.js';
import { safeActionHref, emailHref } from './work-package-state.js';

export function sourceLink(href, label) {
  const url = safeActionHref(href);
  return url ? el('a', { class: 'source-link', href: url, target: '_blank', rel: 'noopener noreferrer', text: label || new URL(url).hostname }) : null;
}
export function personTile(person) {
  const status = /status:([a-z_]+)/i.exec(person.notes || '')?.[1];
  const label = { connect_first: 'Connect first', connection_requested: 'Connection requested', review_required: 'Review required' }[status];
  const links = el('div', { class: 'toolbar-group' });
  for (const channel of ['linkedin', 'instagram']) if (person[channel]) { const link = sourceLink(person[channel], `Open ${channel === 'linkedin' ? 'LinkedIn' : 'Instagram'} profile`); if (link) links.append(link); }
  const mailto = emailHref(person.email);
  if (mailto) links.append(el('a', { class: 'source-link', href: mailto, text: `Compose email to ${person.email}` }));
  return el('article', { class: 'review-tile' }, el('h3', { text: person.name }), label ? el('small', { text: label }) : null, links, ...(person.sources || []).map((url) => sourceLink(url)).filter(Boolean));
}
export function renderHtmlActions(actions = []) {
  const supported = actions.filter((action) => action.kind !== 'unsupported' && safeActionHref(action.href, action.kind));
  const unsupported = actions.filter((action) => !supported.includes(action));
  const panel = el('section', { class: 'info-card stack', 'aria-label': 'HTML interactions' }, el('div', {}, el('h3', { text: 'Links & email drafts' }), el('p', { text: `${supported.length} supported interactions · ${unsupported.length} need review` }), el('p', { class: 'field-help', text: 'Open links or compose an email yourself. These controls do not prepare or approve outreach.' })));
  if (!actions.length) panel.append(el('p', { class: 'field-help', text: 'No extracted link inventory is available for this report. Contact links are available below. Re-import the original HTML to check all supported interactions.' }));
  const list = el('div', { class: 'html-action-list' });
  for (const action of supported) {
    const email = action.kind === 'compose_email'; const href = safeActionHref(action.href, action.kind);
    const control = el('a', { class: 'button small', href, ...(!email ? { target: '_blank', rel: 'noopener noreferrer' } : {}), text: email ? 'Compose email' : 'Open link', 'aria-label': `${email ? 'Compose email' : 'Open link'}: ${action.label}` });
    const tile = el('article', { class: 'review-tile html-action-row' }, el('div', {}, el('h3', { text: action.label }), el('p', { class: 'html-action-destination', text: email ? action.email?.to?.join(', ') || href : href }), email ? el('small', { text: 'Opens a draft in your mail app. You choose whether to send.' }) : null), control);
    if (email && action.email && (action.email.subject || action.email.body || action.email.cc?.length || action.email.bcc?.length)) tile.append(el('details', { class: 'html-draft-details' }, el('summary', { class: 'field-help', text: 'Email draft details' }), ...[['To', action.email.to?.join(', ')], ['Cc', action.email.cc?.join(', ')], ['Bcc', action.email.bcc?.join(', ')], ['Subject', action.email.subject], ['Message', action.email.body]].filter(([, value]) => value).map(([name, value]) => el('p', { text: `${name}: ${value}` }))));
    list.append(tile);
  }
  panel.append(list);
  if (unsupported.length) {
    const review = el('details', { open: '', class: 'html-unsupported' }, el('summary', { class: 'field-label', text: `${unsupported.length} unsupported interactions` }));
    for (const action of unsupported) review.append(el('article', { class: 'review-tile' }, el('h3', { text: action.label || 'HTML interaction' }), el('p', { text: action.reason || 'This destination is unavailable. Check the original report or export a supported link.' }), el('small', { text: `Source: ${action.source || 'HTML'}` })));
    panel.append(review);
  }
  return panel;
}
