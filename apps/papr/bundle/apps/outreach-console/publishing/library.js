import { el, button, bytes, empty, busy, notify } from './utils.js';
import { api } from './service.js';
import { mediaPicker, mediaThumb } from './media-ui.js';
export function renderLibrary(data, refresh) {
  const root = el('section', { class: 'content-panel' }); const search = el('input', { class: 'search-input', type: 'search', placeholder: 'Find a file…', 'aria-label': 'Search media library' });
  const panel = el('div', { class: 'media-grid' }); const uploader = el('div', { style: 'padding:20px 23px', hidden: '' });
  const dummy = { mediaIds: [] }; const pick = mediaPicker(data, dummy, () => { render(); }, () => {}); uploader.append(pick.root);
  const uploadButton = button('Upload media', () => { uploader.hidden = !uploader.hidden; if (!uploader.hidden) uploader.querySelector('input')?.focus(); }, 'small');
  root.append(el('div', { class: 'panel-toolbar' }, el('h2', { text: 'Your next post, in pictures' }), el('div', { class: 'toolbar-group' }, search, uploadButton)), el('p', { class: 'section-hint', text: 'Private workspace storage · Images up to 5 MB · Videos up to 100 MB · Uploaded files are not posted automatically.' }), uploader, panel);
  function render() {
    const assets = data.media.filter((a) => a.name.toLowerCase().includes(search.value.toLowerCase()));
    panel.replaceChildren(...assets.map((asset) => {
      const remove = button('Delete file', () => { const controls = remove.parentElement; const yes = button('Confirm delete', () => busy(yes, async () => { await api('publishing-media-delete', { assetId: asset.id }); await refresh(); notify('Media removed from your library.'); }), 'small danger'); controls.replaceChildren(button('Keep file', () => render(), 'small'), yes); }, 'small');
      return el('article', { class: 'library-card' }, mediaThumb(asset), el('div', { class: 'library-meta' }, el('strong', { text: asset.name, title: asset.name }), el('small', { text: `${asset.mime.startsWith('video/') ? 'Video' : 'Image'} · ${bytes(asset.size)}` }), el('small', { text: `SHA ${asset.sha256.slice(0, 12)}…` }), el('div', { class: 'queue-actions' }, remove)));
    }));
    if (!assets.length) panel.replaceChildren(empty(data.media.length ? 'No matching files.' : 'A home for your creative work.', data.media.length ? 'Try another filename.' : 'Upload images and videos once, then reuse them across your drafts. Files stay private until an approved post is published.'));
  }
  search.addEventListener('input', render); render(); return root;
}
