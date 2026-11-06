/* global document, clearTimeout, setTimeout */
export const $ = (id) => document.getElementById(id);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined) node.append(child);
  return node;
}
export function notify(text) {
  const node = $('studio-toast'); node.textContent = text; node.classList.add('visible');
  clearTimeout(notify.timer); notify.timer = setTimeout(() => node.classList.remove('visible'), 5000);
}
export function button(text, onclick, kind = '') { return el('button', { type: 'button', class: `button ${kind}`, text, onclick }); }
export function field(label, control, help) {
  const id = control.id || `field-${globalThis.crypto.randomUUID()}`; control.id = id;
  return el('div', { class: 'field-group' }, el('label', { class: 'field-label', for: id, text: label }), control, help ? el('p', { class: 'field-help', text: help }) : null);
}
export function modal(title, description, compact = false) {
  const previous = document.activeElement;
  const titleId = `dialog-${globalThis.crypto.randomUUID()}`;
  const dialog = el('dialog', { class: `studio-dialog ${compact ? 'compact-dialog' : ''}`, 'aria-labelledby': titleId });
  const top = el('div', { class: 'dialog-top' }, el('div', {}, el('h2', { id: titleId, text: title }), el('p', { text: description })));
  const content = el('div', { class: 'dialog-body' }); const bottom = el('div', { class: 'dialog-bottom' });
  const close = () => { dialog.close(); dialog.remove(); if (previous?.isConnected) previous.focus(); };
  top.append(button('×', close, 'close-button')); top.lastChild.setAttribute('aria-label', 'Close dialog');
  dialog.append(top, content, bottom); document.body.append(dialog);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal(); return { dialog, content, bottom, close };
}
export async function busy(control, task) {
  const before = control.textContent; control.disabled = true;
  try { return await task(); } catch (error) { notify(error.message); return null; }
  finally { if (control.isConnected) { control.disabled = false; control.textContent = before; } }
}
export function statusLabel(state) {
  return ({ awaiting_approval: 'Needs approval', scheduled: 'Scheduled', queued: 'Queued', completed: 'Completed', succeeded: 'Published', failed: 'Failed', uncertain: 'Needs review', review: 'Needs review', cancelled: 'Cancelled', executing: 'Publishing', claimed: 'Preparing', reauth_required: 'Sign-in needed' })[state] || state || 'Draft';
}
export function badge(state) { return el('span', { class: `badge ${['awaiting_approval', 'queued', 'blocked', 'reauth_required'].includes(state) ? 'amber' : ['failed', 'uncertain', 'review'].includes(state) ? 'red' : state === 'draft' ? 'blue' : ''}`, text: statusLabel(state) }); }
export function empty(title, description, onCreate) {
  return el('div', { class: 'empty-state' }, el('div', { class: 'empty-art', 'aria-hidden': 'true', text: '✳' }), el('h3', { text: title }), el('p', { text: description }), onCreate ? button('Create your first post', onCreate, 'primary') : null);
}
export const bytes = (size) => size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
export const dateText = (value, zone) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}) }).format(new Date(value));
