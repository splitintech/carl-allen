import { el } from './utils.js';
import { platform, accountName } from './model.js';
import { mediaURL } from './service.js';
export function renderPreview(root, post, data) {
  const p = platform(post.channel); const account = data.accounts.find((a) => a.id === post.accountId); const asset = data.media.find((a) => a.id === post.mediaIds[0]);
  const name = accountName(account); const card = el('article', { class: `social-preview ${p.id}`, 'aria-label': `${p.name} post preview` });
  card.append(el('div', { class: 'preview-header' }, el('span', { class: 'preview-avatar', text: account ? name.slice(0, 1).toUpperCase() : 'Y' }), el('div', { class: 'preview-account', text: account ? name : 'Your account', }, el('small', { text: account?.externalAccountId || 'Connect when you are ready' }))));
  if (p.id !== 'instagram' && p.id !== 'tiktok') card.append(el('div', { class: 'preview-text', text: post.text || 'Your next good idea starts here…' }));
  if (asset) {
    const box = el('div', { class: asset.mime.startsWith('video/') ? 'preview-video' : 'preview-placeholder', text: asset.mime.startsWith('video/') ? '▷' : '✳' }); card.append(box);
    mediaURL(asset).then((url) => { if (root.contains(card)) { const media = el(asset.mime.startsWith('video/') ? 'video' : 'img', { class: 'preview-image', src: url, alt: asset.name, ...(asset.mime.startsWith('video/') ? { controls: '', preload: 'metadata', 'aria-label': `${asset.name} preview` } : {}) }); box.replaceWith(media); } }).catch(() => { box.textContent = 'Preview unavailable'; });
  } else if (p.id === 'instagram' || p.id === 'tiktok') card.append(el('div', { class: p.id === 'tiktok' ? 'preview-video' : 'preview-placeholder', text: p.id === 'tiktok' ? '▷' : '✳' }));
  if (p.id === 'instagram' || p.id === 'tiktok') card.append(el('div', { class: 'preview-text', text: post.text || 'Your caption will appear here.' }));
  if (post.firstComment?.trim()) card.append(el('div', { class: 'preview-first-comment', text: `First comment: ${post.firstComment}` }));
  card.append(el('div', { class: 'preview-footer' }, el('span', { text: '♡ Like' }), el('span', { text: '◯ Comment' }), el('span', { text: '↗ Share' })));
  root.replaceChildren(el('div', { class: 'preview-label' }, el('span', { text: 'A LITTLE LOOK AHEAD' }), el('span', { text: p.name })), card, el('p', { class: 'preview-tip', text: 'Layout preview only. The platform may crop or display your content differently. Media files are uploaded before a post can be scheduled.' }), el('p', { class: 'preview-tip', text: `${p.hint}. Composer limit: ${p.cap.toLocaleString()} characters. ${post.mediaIds.length > 1 ? `${post.mediaIds.length} attachments will publish in the order shown.` : ''}` }));
}
