/* global document */
import { el } from './dom.js';
let editing = false;
/** A native iframe modal: labels, explicit Save, browser validation, Escape/cancel and restored focus. */
export function editFields(title, fields, submitText = 'Save draft', restoreFocus) {
  if (editing) return Promise.resolve(null);
  editing = true;
  return new Promise((resolve) => {
    const previous = restoreFocus ?? document.activeElement;
    const dialog = el('dialog', { class: 'decision-dialog editor-dialog', 'aria-labelledby': 'editor-title' });
    const form = el('form', {}, el('h2', { id: 'editor-title', text: title }));
    const inputs = new Map();
    for (const field of fields) {
      const id = `field-${field.name}`;
      const input = el(field.options ? 'select' : field.multiline ? 'textarea' : 'input', { id, name: field.name, ...(field.multiline || field.options ? {} : { type: field.type || 'text' }), ...(field.required ? { required: '' } : {}), ...(field.max ? { maxlength: String(field.max) } : {}) });
      if (field.options) for (const option of field.options) input.append(el('option', { value: option.value, text: option.label }));
      input.value = field.value ?? '';
      inputs.set(field.name, input);
      form.append(el('label', { for: id, text: field.label }), input);
    }
    for (const field of fields) if (field.onChange) inputs.get(field.name).addEventListener('change', () => field.onChange(inputs.get(field.name).value, inputs));
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    const save = el('button', { type: 'submit', class: 'primary', text: submitText });
    form.append(el('p', { class: 'hint', text: 'Saving never sends immediately. Scheduled actions wait for approval.' }), el('div', { class: 'row' }, cancel, save));
    let settled = false;
    function finish(value) {
      if (settled) return; settled = true; editing = false;
      globalThis.removeEventListener('pagehide', dismiss);
      if (dialog.open) dialog.close(); dialog.remove();
      (previous?.isConnected ? previous : document.getElementById('refresh'))?.focus(); resolve(value);
    }
    const dismiss = () => finish(null);
    cancel.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', dismiss);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = {};
      for (const field of fields) {
        const input = inputs.get(field.name);
        if (field.required && !input.value.trim()) { input.focus(); return; }
        data[field.name] = input.value;
      }
      finish(data);
    });
    dialog.append(form); document.body.append(dialog); globalThis.addEventListener('pagehide', dismiss, { once: true });
    try { dialog.showModal(); (inputs.values().next().value || cancel).focus(); } catch { dismiss(); }
  });
}
