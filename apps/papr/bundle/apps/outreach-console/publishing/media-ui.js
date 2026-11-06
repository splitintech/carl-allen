import { el, button, modal, notify, bytes } from './utils.js';
import { upload, mediaURL } from './service.js';
export function mediaThumb(asset, className = 'library-preview') {
  const box = el('div', { class: className, text: asset.mime.startsWith('video/') ? '▷' : '▧' });
  const load = async () => { try { const url = await mediaURL(asset); if (!box.isConnected) return; const preview = el(asset.mime.startsWith('video/') ? 'video' : 'img', { src: url, alt: asset.name, ...(asset.mime.startsWith('video/') ? { controls: '', preload: 'metadata', 'aria-label': asset.name } : { loading: 'lazy' }) }); box.replaceChildren(preview); } catch { box.textContent = 'Preview unavailable'; } };
  if (asset.mime.startsWith('video/')) box.append(button('Load video preview', () => { void load(); }, 'small')); else globalThis.setTimeout(load, 0); return box;
}
export function mediaPicker(data, post, changed, onBusy) {
  const root = el('div', { class: 'field-group' }); const attached = el('div', { class: 'media-attachments' }); const progress = el('div'); const signal = { cancelled: false };
  const input = el('input', { type: 'file', id: `media-files-${globalThis.crypto.randomUUID()}`, multiple: '', accept: 'image/jpeg,image/png,image/webp,video/mp4', class: 'visually-hidden' });
  const browse = el('label', { class: 'upload-label', for: input.id, text: 'Choose files' });
  const drop = el('div', { class: 'media-drop' }, el('span', { class: 'upload-icon', 'aria-hidden': 'true', text: '↥' }), el('strong', { text: 'Drop your images or video here' }), el('p', { text: 'JPEG, PNG, WebP · up to 5 MB per image\nMP4 · one video up to 100 MB' }), browse, input);
  const pick = button('Choose from media library', () => openLibrary(data.media, (asset) => { if (!post.mediaIds.includes(asset.id)) post.mediaIds.push(asset.id); render(); changed(); }), 'small');
  async function add(files) {
    onBusy(true); browse.style.pointerEvents = 'none'; input.disabled = true;
    try { for (const file of files) {
      if (signal.cancelled) break; const token = { cancelled: false }; signal.current = token;
      const meter = el('progress', { max: file.size, value: 0, 'aria-label': `Uploading ${file.name}` }); const line = el('div', { class: 'upload-progress' }, el('span', { text: file.name }), button('Cancel', () => { token.cancelled = true; }, 'small'), meter); progress.replaceChildren(line);
      try { const asset = await upload(file, (received) => { meter.value = received; }, token); if (!data.media.some((a) => a.id === asset.id)) data.media.push(asset); if (!post.mediaIds.includes(asset.id)) post.mediaIds.push(asset.id); render(); changed(); progress.replaceChildren(el('p', { class: 'field-help', text: `${file.name} uploaded privately and ready to attach.` })); }
      catch (error) { progress.replaceChildren(el('p', { class: 'field-help', role: 'alert', text: error.message }), button('Retry upload', () => add([file]), 'small')); break; }
    } } finally { onBusy(false); input.disabled = false; browse.style.pointerEvents = ''; }
  }
  input.addEventListener('change', () => { void add([...input.files]); input.value = ''; });
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (e) => { e.preventDefault(); drop.classList.remove('dragover'); });
  drop.addEventListener('drop', (e) => { if (!input.disabled && e.dataTransfer?.files) void add([...e.dataTransfer.files]); });
  function render() {
    attached.replaceChildren(...post.mediaIds.map((id, index) => { const asset = data.media.find((m) => m.id === id); if (!asset) return el('p', { text: 'Attachment unavailable. Remove it before scheduling.' });
      const move = (direction) => { const other = index + direction; if (other < 0 || other >= post.mediaIds.length) return; [post.mediaIds[index], post.mediaIds[other]] = [post.mediaIds[other], post.mediaIds[index]]; render(); changed(); };
      return el('div', { class: 'attachment', title: `${asset.name} · ${bytes(asset.size)}` }, mediaThumb(asset, 'attachment-placeholder'), el('div', { class: 'attachment-controls' }, el('button', { type: 'button', 'aria-label': `Move ${asset.name} earlier`, text: '←', disabled: index === 0, onclick: () => move(-1) }), el('button', { type: 'button', 'aria-label': `Move ${asset.name} later`, text: '→', disabled: index === post.mediaIds.length - 1, onclick: () => move(1) }), el('button', { type: 'button', 'aria-label': `Remove ${asset.name}`, text: '×', onclick: () => { post.mediaIds.splice(index, 1); render(); changed(); } })));
    }));
  }
  root.append(el('span', { class: 'field-label', text: 'Images & video' }), drop, progress, attached, pick); render();
  return { root, cancel: () => { signal.cancelled = true; if (signal.current) signal.current.cancelled = true; } };
}
export function openLibrary(assets, choose) {
  const dialog = modal('Choose from your library', 'Files already uploaded to your private workspace.'); const grid = el('div', { class: 'library-dialog-grid' });
  if (!assets.length) grid.append(el('p', { class: 'field-help', text: 'Your library is empty. Choose files in the composer to upload your first image or video.' }));
  for (const asset of assets) { const card = el('div', { class: 'library-card' }, mediaThumb(asset), el('div', { class: 'library-meta' }, el('strong', { text: asset.name }), el('small', { text: bytes(asset.size) }), button('Use this file', () => { choose(asset); dialog.close(); }, 'small'))); grid.append(card); }
  dialog.content.append(grid); dialog.bottom.append(button('Back to post', dialog.close));
}
export function fileError(error) { notify(error.message || 'The media could not be uploaded. Your post has not been scheduled.'); }
