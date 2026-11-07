/* global URL */
import { platform } from './model.js';
export function canonicalProfile(channel, value) {
  let p; try { p = new URL(value); } catch { throw new Error('Enter a complete HTTPS profile URL.'); }
  const label = platform(channel).name;
  if (p.protocol !== 'https:' || p.username || p.password || p.search || p.hash || p.port) throw new Error(`Use a canonical HTTPS ${label} profile URL, without query parameters or embedded credentials.`);
  const rules = {
    linkedin: { hosts: ['linkedin.com', 'www.linkedin.com'], path: /^\/(?:in|company)\/[a-z0-9_-]+\/?$/i, origin: 'https://www.linkedin.com' },
    x: { hosts: ['x.com', 'www.x.com'], path: /^\/[a-z0-9_]{1,15}\/?$/i, reserved: /^\/(home|compose|settings|messages|explore|notifications|i)\/?$/i, origin: 'https://x.com' },
    instagram: { hosts: ['instagram.com', 'www.instagram.com'], path: /^\/[a-z0-9_.]{1,30}\/?$/i, reserved: /^\/(accounts|direct|explore|reels|stories|p)\/?$/i, origin: 'https://www.instagram.com' },
    tiktok: { hosts: ['tiktok.com', 'www.tiktok.com'], path: /^\/@[a-z0-9_.]{2,24}\/?$/i, origin: 'https://www.tiktok.com' },
  };
  const rule = rules[channel];
  if (!rule || !rule.hosts.includes(p.hostname.toLowerCase()) || !rule.path.test(p.pathname) || rule.reserved?.test(p.pathname)) throw new Error(`Enter your own ${label} profile URL. A different platform, post, settings page or login page cannot be connected here.`);
  return `${rule.origin}${p.pathname.replace(/\/?$/, '/').toLowerCase()}`;
}
