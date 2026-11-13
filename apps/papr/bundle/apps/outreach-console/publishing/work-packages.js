/* global Blob, URL */
import { el, button, field, modal, busy, notify, badge, dateText } from './utils.js';
import { api, upload } from './service.js';
import { manifestFor, showPackage } from './work-package-review.js';
import { receiptSummary } from './work-package-state.js';
import { icon } from './icons.js';
const canEdit = (data) => data.roles?.some((role) => ['admin', 'operator', 'approver'].includes(role));
function download(name, text) { const url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' })); const link = el('a', { href: url, download: name }); link.click(); URL.revokeObjectURL(url); }
export function renderCreate(data, state, refresh, edit, onTab) {
  const root = el('div', { class: 'stack' });
  root.append(el('div', { class: 'template-card' }, icon('upload'), el('div', {}, el('h2', { text: 'From research to ready' }), el('p', { text: 'Upload an HTML report to open its links and email drafts. Map accounts and choose a time for any scheduled work.' }), el('div', { class: 'toolbar-group' }, button('Import HTML & media', () => openImport(data, refresh), 'primary'), button('Download HTML template', async () => { try { const value = await api('work-package-template'); download('carl-allen-plan.html', value.html); } catch (error) { notify(error.message); } }, 'small'), button('Papr & ChatGPT instructions', openInstructions, 'small')))));
  const tabs = el('div', { class: 'view-tabs' }, ...[['packages', 'HTML handoffs'], ['drafts', 'Drafts & plans'], ['media', 'Media library']].map(([id, label]) => button(label, () => onTab(id), state.createTab === id ? 'active' : ''))); root.append(tabs);
  if ((state.createTab || 'packages') === 'packages') {
    const panel = el('section', { class: 'content-panel' }, el('div', { class: 'panel-toolbar' }, el('h2', { text: 'Your handoffs' }), el('span', { class: 'muted', text: `${(data.workPackages || []).length.toLocaleString()} packages` })));
    if (!data.workPackages?.length) panel.append(el('div', { class: 'empty-state' }, el('h3', { text: 'Bring your next month of work' }), el('p', { text: 'A handoff can contain posts, sourced people, outreach sequences and reply playbooks. Files stay drafts until everything is mapped and approved.' }), button('Import HTML & media', () => openImport(data, refresh), 'primary')));
    else for (const pack of data.workPackages) panel.append(el('article', { class: 'queue-card' }, icon('upload'), el('div', {}, el('h3', { text: pack.name || 'HTML work package' }), el('div', { class: 'queue-meta' }, badge(pack.status), el('span', { text: `Revision ${pack.revision || 1}` }), pack.updatedAt ? el('span', { text: dateText(pack.updatedAt) }) : null), el('small', { class: 'item-meta', text: receiptSummary(pack) })), button('Open handoff', () => openPackage(pack.id, data, refresh), 'small')));
    root.append(panel);
  } else if (state.createTab === 'drafts') root.append(edit()); else root.append(edit('media'));
  return root;
}
function openInstructions() {
  const m = modal('Prepare a handoff in Papr or ChatGPT', 'Keep research in the tool you already use. Carl-Allen owns the reviewed execution.');
  const prompt = 'Use the Carl-Allen HTML template. Put the complete version-1 manifest in one application/json script with id="carl-allen-manifest". Keep real source links on contacts. Include separate publishing targets for every account, ISO dates with timezone offsets, local media filenames, reviewed outreach steps, and explicit reply rules. Do not include passwords, tokens, approval claims, executable browser scripts, or invented contact information. Export one .html file and its media files for review in Carl-Allen.';
  m.content.append(el('div', { class: 'review-content' }, el('ol', { class: 'flow-note' }, el('li', {}, 'Download the HTML template and use it as the handoff contract.'), el('li', {}, 'Research and draft in Papr or ChatGPT. Keep media as separate files.'), el('li', {}, 'Upload the HTML here. Map accounts, repair any missing fields and review.'), el('li', {}, 'Approve the exact plan in Carl-Allen. Wait for its cloud receipt before closing your Mac.')), field('Generation instructions', el('textarea', { class: 'field-control code-field', readonly: '', text: prompt })), el('p', { class: 'flow-note', text: 'The authenticated MCP connection can retrieve the template, inspect accounts, prepare work and return review links. Uploading a ChatGPT attachment does not automatically grant the MCP server access to that file.' })));
  m.bottom.append(button('Close', m.close));
}
export function openImport(data, refresh) {
  const m = modal('Import HTML & media', 'Your uploaded report is read as data. Its scripts and external resources are never executed.');
  const html = el('input', { class: 'field-control', type: 'file', accept: '.html,.htm,text/html', name: 'html' });
  const media = el('input', { class: 'field-control', type: 'file', multiple: '', accept: 'image/jpeg,image/png,image/webp,video/mp4', name: 'media' });
  const progress = el('div', { role: 'status', class: 'flow-note', 'aria-live': 'polite' }); const errors = el('div', { class: 'validation-errors', hidden: '', role: 'alert', tabindex: '-1' });
  m.content.append(el('div', { class: 'review-content' }, field('HTML plan or research report', html, 'We keep supported links and email drafts. Scheduled work also needs account mapping and a reviewed start time.'), field('Accompanying images & videos', media, 'Use the filenames referenced in the HTML. You can resolve missing files in the next step.'), progress, errors));
  const submit = button('Import and check files', () => busy(submit, async () => {
    errors.hidden = true; const file = html.files?.[0]; if (!file) { errors.textContent = 'Choose an HTML file to import.'; errors.hidden = false; errors.focus(); return; }
    if (file.size > 20 * 1048576) { errors.textContent = 'This HTML is larger than 20 MB. Split the report into smaller handoffs.'; errors.hidden = false; errors.focus(); return; }
    progress.textContent = 'Reading and validating your HTML…'; const result = await api('work-package-import', { name: file.name, html: await file.text() }); let pack = result.package;
    const selected = Array.from(media.files || []); const counts = new Map(); selected.forEach((item) => counts.set(item.name, (counts.get(item.name) || 0) + 1)); if ([...counts.values()].some((value) => value > 1)) throw new Error('Two selected files have the same name. Rename them and update the plan before matching media. Your HTML has been saved.');
    const mediaMap = { ...(pack.mediaMap || {}) }; const manifest = manifestFor(pack);
    for (const item of selected) {
      const asset = await upload(item, (done, total) => { progress.textContent = `Uploading ${item.name} · ${Math.round(done / total * 100)}%`; }); if (!data.media.some((a) => a.id === asset.id)) data.media.push(asset);
      const refs = (manifest.media || []).filter((ref) => ref.name === item.name); for (const ref of refs) mediaMap[ref.id] = asset.id;
    }
    if (selected.length) pack = (await api('work-package-repair', { packageId: pack.id, input: { mediaMap } })).package;
    progress.textContent = 'HTML and selected files saved. Opening review…'; m.close(); await refresh(); await showPackage(pack, data, refresh);
  }), 'primary'); submit.disabled = !canEdit(data); m.bottom.append(button('Cancel', m.close), submit);
}
export async function openPackage(packageId, data, refresh) { try { const value = await api('work-package-get', { packageId }); showPackage(value.package, data, refresh); } catch (error) { notify(error.message); } }
