/* global structuredClone */
import { el, button, field, modal, busy, notify } from './utils.js';
import { PLATFORMS, platform, accountsFor, accountName, validatePost, scheduleInZone, zonedISO } from './model.js';
import { api } from './service.js';
import { mediaPicker } from './media-ui.js';
import { renderPreview } from './preview.js';
import { reviewDraft } from './review.js';
export function openComposer(data, refresh, original) {
  const zone = original?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const draft = original ? structuredClone(original) : { name: '', timezone: zone, scheduledFor: new Date(Date.now() + 3600000).toISOString(), posts: [{ channel: 'linkedin', text: '', mediaIds: [], accountId: accountsFor(data, 'linkedin')[0]?.id }] };
  let active = draft.posts[0].channel; let picker; let uploading = false;
  const m = modal(original ? 'Make it your own' : 'Your next post starts here', 'Write once, tailor each platform, and give your ideas a time to shine.');
  const fields = el('div', { class: 'composer-fields' }); const preview = el('aside', { class: 'composer-preview', 'aria-label': 'Post preview' }); const grid = el('div', { class: 'composer-grid' }, fields, preview);
  const name = el('input', { class: 'field-control', id: 'post-title', placeholder: 'Give this post a working title', maxlength: 200, required: '' }); name.value = draft.name;
  const choices = el('div', { class: 'platform-choices' }); const tabs = el('div', { class: 'caption-tabs', role: 'tablist', 'aria-label': 'Platform caption' }); const postFields = el('div', { class: 'field-group' });
  const date = el('input', { class: 'field-control', type: 'datetime-local', id: 'post-date', required: '' }); date.value = scheduleInZone(draft.scheduledFor, zone);
  const timeZone = el('input', { class: 'field-control', id: 'post-timezone', required: '', list: 'timezones' }); timeZone.value = zone;
  const zones = el('datalist', { id: 'timezones' }, ...[zone, 'UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney'].filter((v, i, all) => all.indexOf(v) === i).map((v) => el('option', { value: v })));
  const errors = el('div', { class: 'validation-errors', role: 'alert', hidden: '' });
  const save = button('Save draft', () => busy(save, async () => { const saved = await persist(); if (saved) { m.close(); await refresh(); notify('Draft saved privately. Come back whenever you are ready.'); } }));
  const review = button('Review & schedule', () => busy(review, async () => { const messages = validate(true); if (messages.length) { showErrors(messages); return; } const saved = await persist(); if (saved) { m.close(); await refresh(); reviewDraft(saved, data, refresh, (item) => openComposer(data, refresh, item)); } }), 'primary');
  const controls = [save, review];
  function setUploading(value) { uploading = value; controls.forEach((b) => { b.disabled = value; }); [...choices.querySelectorAll('input'), ...tabs.querySelectorAll('button')].forEach((b) => { b.disabled = value; }); }
  const previewToggle = button('Show platform preview', () => { preview.classList.toggle('mobile-visible'); previewToggle.textContent = preview.classList.contains('mobile-visible') ? 'Hide platform preview' : 'Show platform preview'; }, 'small preview-mobile-toggle');
  fields.append(field('Working title', name), el('div', { class: 'field-group' }, el('span', { class: 'field-label', text: 'Where would you like to post?' }), choices), tabs, postFields, field('When should it go out?', el('div', { class: 'schedule-grid' }, field('Date & time', date), field('Time zone', timeZone), zones), 'Choose a future time. Every post waits for your approval before publishing.'), errors, previewToggle);
  m.content.append(grid); m.bottom.append(el('small', { text: 'Private uploads · Separate approval\nSave your draft before closing.' }), el('div', { class: 'actions' }, save, review));
  m.dialog.addEventListener('close', () => picker?.cancel());
  function showErrors(messages) { errors.hidden = !messages.length; errors.textContent = messages.join('\n'); }
  function validate(forSubmit) {
    const messages = []; if (!name.value.trim()) messages.push('Give your draft a working title.'); if (!draft.posts.length) messages.push('Choose at least one platform.');
    try { draft.timezone = timeZone.value.trim(); draft.scheduledFor = zonedISO(date.value, draft.timezone); if (forSubmit && Date.parse(draft.scheduledFor) <= Date.now()) messages.push('Choose a scheduled time in the future.'); } catch (error) { messages.push(error.message); }
    if (forSubmit) for (const post of draft.posts) messages.push(...validatePost(post, data.media, data.accounts));
    return messages;
  }
  async function persist() {
    const messages = validate(false); if (uploading) messages.push('Wait for the upload to finish or cancel it.'); if (messages.length) { showErrors(messages); return null; }
    draft.name = name.value.trim(); const input = { ...(original?.id || draft.id ? { id: original?.id || draft.id } : {}), name: draft.name, timezone: draft.timezone, scheduledFor: draft.scheduledFor, posts: draft.posts.map((p) => ({ channel: p.channel, ...(p.accountId ? { accountId: p.accountId } : {}), text: p.text, mediaIds: p.mediaIds })) };
    const result = await api('publishing-draft-save', { input }); draft.id = result.draft.id; return result.draft;
  }
  function updatePreview() { const post = draft.posts.find((p) => p.channel === active); if (post) renderPreview(preview, post, data); }
  function renderChoices() {
    choices.replaceChildren(...PLATFORMS.map((p) => { const check = el('input', { type: 'checkbox', checked: draft.posts.some((post) => post.channel === p.id), 'aria-label': `Publish to ${p.name}` }); check.addEventListener('change', () => { if (check.checked) { const base = draft.posts[0]; draft.posts.push({ channel: p.id, text: base?.text || '', mediaIds: [...(base?.mediaIds || [])], accountId: accountsFor(data, p.id)[0]?.id }); active = p.id; } else { if (draft.posts.length === 1) { check.checked = true; notify('Keep at least one platform selected.'); return; } draft.posts = draft.posts.filter((post) => post.channel !== p.id); if (active === p.id) active = draft.posts[0].channel; } renderPost(); }); return el('label', { class: 'platform-choice' }, check, el('span', { class: `platform-icon ${p.id}`, text: p.icon }), p.name); }));
  }
  function renderPost() {
    picker?.cancel(); const post = draft.posts.find((p) => p.channel === active); const p = platform(active);
    tabs.replaceChildren(...draft.posts.map((entry) => el('button', { type: 'button', class: `caption-tab ${entry.channel === active ? 'active' : ''}`, role: 'tab', 'aria-selected': entry.channel === active, text: platform(entry.channel).name, onclick: () => { active = entry.channel; renderPost(); } })));
    const account = el('select', { class: 'field-control', id: 'post-account' }, el('option', { value: '', text: 'Connect an account later' }), ...accountsFor(data, active).map((a) => el('option', { value: a.id, text: `${accountName(a)} · ${a.externalAccountId}` }))); account.value = post.accountId || ''; account.addEventListener('change', () => { post.accountId = account.value || undefined; updatePreview(); });
    const caption = el('textarea', { class: 'field-control caption-editor', id: 'post-caption', placeholder: `What would you like to share on ${p.name}?` }); caption.value = post.text;
    const count = el('span'); const footer = el('div', { class: 'caption-footer' }, el('span', { text: 'A separate caption for each platform' }), count);
    const updateCount = () => { const total = [...post.text].length; count.textContent = `${total.toLocaleString()} / ${p.cap.toLocaleString()}`; footer.classList.toggle('over', total > p.cap); };
    caption.addEventListener('input', () => { post.text = caption.value; updateCount(); updatePreview(); }); updateCount();
    picker = mediaPicker(data, post, updatePreview, setUploading);
    const copy = button('Apply this caption & media to all selected platforms', () => { for (const other of draft.posts) if (other !== post) { other.text = post.text; other.mediaIds = [...post.mediaIds]; } notify('Caption and media copied. Review each platform’s requirements before scheduling.'); }, 'small');
    postFields.replaceChildren(field(`Publish as · ${p.name}`, account, accountsFor(data, active).length ? 'The signed-in identity is checked again before publishing.' : 'You can draft now. Connect this platform in Accounts before scheduling.'), field('Caption', caption), footer, picker.root, copy, el('p', { class: 'field-help', text: `${p.hint}. These are conservative composer limits; codecs, crops and platform processing can still affect delivery.` }));
    updatePreview();
  }
  renderChoices(); renderPost(); name.focus();
}
