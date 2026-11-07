/* global crypto, TextEncoder, TextDecoder, btoa, atob */
const encoder = new TextEncoder();
export const bytes = value => typeof value === 'string' ? encoder.encode(value) : value;
export const base64url = value => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function decode64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(value) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))), b => b.toString(16).padStart(2, '0')).join(''); }
export async function hmac(secret, value) {
  if (!secret || secret.length < 32) throw new Error('Gateway secret is not configured');
  const key = await crypto.subtle.importKey('raw', bytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(value))), b => b.toString(16).padStart(2, '0')).join('');
}
async function encryptionKey(secret) {
  if (!secret || secret.length < 32) throw new Error('Session secret is not configured');
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', bytes(secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), bytes(JSON.stringify(value)));
  return `${base64url(iv)}.${base64url(data)}`;
}
export async function unseal(value, secret) {
  if (typeof value !== 'string' || value.length > 6000 || value.split('.').length !== 2) throw new Error('Invalid session');
  const [iv, ciphertext] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(iv) }, await encryptionKey(secret), decode64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}
export async function boundedBody(request, max = 25 * 1024 * 1024) {
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const parts = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new Error('Request too large'); } parts.push(value); } } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}
