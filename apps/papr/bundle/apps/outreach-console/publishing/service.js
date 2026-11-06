/* global location, FileReader, Blob, URL, btoa, atob */
import { call } from '../ui/api.js';
export const api = (action, params = {}) => {
  if (location.protocol === 'file:') return Promise.reject(new Error('This file is an offline interface preview. Open Publishing Studio through the trusted local server or Papr to save, upload and schedule.'));
  return call(action, params);
};
const previewCache = new Map();
export function rememberPreview(id, file) { const old = previewCache.get(id); if (typeof old === 'string') URL.revokeObjectURL(old); const url = URL.createObjectURL(file); previewCache.set(id, url); return url; }
export async function mediaURL(asset) {
  if (previewCache.has(asset.id)) return previewCache.get(asset.id);
  const promise = (async () => {
    const chunkSize = 65536; const pieces = new Array(Math.ceil(asset.size / chunkSize)); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, pieces.length) }, async () => {
      for (;;) { const index = cursor++; if (index >= pieces.length) return; const offset = index * chunkSize; const part = await api('publishing-media-read', { assetId: asset.id, offset, length: Math.min(chunkSize, asset.size - offset) });
        const raw = atob(part.data); const bytes = new Uint8Array(raw.length); for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j); pieces[index] = bytes;
      }
    }));
    const url = URL.createObjectURL(new Blob(pieces, { type: asset.mime })); previewCache.set(asset.id, url); return url;
  })();
  previewCache.set(asset.id, promise);
  try { return await promise; } catch (error) { previewCache.delete(asset.id); throw error; }
}
export function readBytes(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.onerror = () => reject(new Error('Could not read this file. Try selecting it again.')); reader.readAsArrayBuffer(blob); }); }
export async function upload(file, onProgress, signal = {}) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
  if (!allowed.includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP, MP4 file.');
  const max = file.type.startsWith('video/') ? 100 * 1048576 : 5 * 1048576;
  if (!file.size || file.size > max) throw new Error(`${file.name}: composer uploads support images up to 5 MB and videos up to 100 MB.`);
  const { uploadId, chunkBytes = 65536 } = await api('publishing-upload-start', { input: { name: file.name, mime: file.type, size: file.size } });
  try {
    let index = 0;
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      if (signal.cancelled) throw new Error('Upload cancelled.');
      const bytes = await readBytes(file.slice(offset, offset + chunkBytes)); let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
      await api('publishing-upload-chunk', { uploadId, index: index++, data: btoa(raw) }); onProgress(Math.min(file.size, offset + bytes.length), file.size);
    }
    if (signal.cancelled) throw new Error('Upload cancelled.');
    const { asset } = await api('publishing-upload-complete', { uploadId }); rememberPreview(asset.id, file); return asset;
  } catch (error) { await api('publishing-upload-cancel', { uploadId }).catch(() => {}); throw error; }
}
export function revokeMedia() { for (const value of previewCache.values()) if (typeof value === 'string') URL.revokeObjectURL(value); previewCache.clear(); }
globalThis.addEventListener('pagehide', revokeMedia);
