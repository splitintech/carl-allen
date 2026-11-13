import { z } from 'zod';
import type { HtmlImportAction } from '@splitin/outreach-contracts';

type Destination = Omit<Extract<HtmlImportAction, { kind: 'open_url' }>, 'id' | 'label' | 'source'>
  | Omit<Extract<HtmlImportAction, { kind: 'compose_email' }>, 'id' | 'label' | 'source'>;
const address = z.string().email().max(320);
const hasControls = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const headers = new Set(['to', 'cc', 'bcc', 'subject', 'body']);
const encodedAddress = (value: string) => encodeURIComponent(value).replace(/%40/g, '@');

function recipients(value: string): string[] {
  const result = value ? value.split(',').map((item) => item.trim()) : [];
  if (result.length > 100 || result.some((item) => !address.safeParse(item).success || hasControls(item))) throw new Error('Invalid email recipient');
  return result;
}

function mailto(raw: string): Destination {
  if (raw.length > 30_000 || /%(?![a-f0-9]{2})/i.test(raw)) throw new Error('Malformed email link');
  const url = new URL(raw);
  if (url.hash || url.host || url.pathname.startsWith('//')) throw new Error('Invalid email link');
  const query = new Map<string, string>();
  for (const pair of url.search.slice(1).split('&').filter(Boolean)) {
    const separator = pair.indexOf('=');
    const key = decodeURIComponent(separator < 0 ? pair : pair.slice(0, separator)).toLowerCase();
    const value = decodeURIComponent(separator < 0 ? '' : pair.slice(separator + 1));
    if (!headers.has(key)) throw new Error('This email header requires explicit review');
    if (query.has(key)) throw new Error('Repeated email fields require explicit review');
    query.set(key, value);
  }
  const to = [...recipients(decodeURIComponent(url.pathname)), ...recipients(query.get('to') ?? '')];
  const cc = recipients(query.get('cc') ?? ''); const bcc = recipients(query.get('bcc') ?? '');
  if (to.length > 100) throw new Error('Too many email recipients');
  const subject = query.get('subject'); const body = query.get('body');
  if (subject !== undefined && (hasControls(subject) || subject.length > 1000)) throw new Error('Invalid email subject');
  if (body !== undefined && (body.length > 20_000 || [...body].some((char) => { const code = char.charCodeAt(0); return code === 127 || code < 32 && ![9, 10, 13].includes(code); }))) throw new Error('Invalid email body');
  const fields: [string, string][] = [];
  if (cc.length) fields.push(['cc', cc.join(',')]);
  if (bcc.length) fields.push(['bcc', bcc.join(',')]);
  if (subject !== undefined) fields.push(['subject', subject]);
  if (body !== undefined) fields.push(['body', body]);
  const href = `mailto:${to.map(encodedAddress).join(',')}${fields.length ? `?${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}` : ''}`;
  if (href.length > 30_000) throw new Error('Encoded email link is too long');
  return { kind: 'compose_email', href, email: { to, cc, bcc, ...(subject !== undefined ? { subject } : {}), ...(body !== undefined ? { body } : {}) } };
}

/** Only creates user-click destinations. It never visits a URL or submits an email. */
export function htmlDestination(raw: string, base?: string): Destination {
  const value = raw.trim();
  if (!value || value.startsWith('#')) throw new Error('Document-local navigation requires the original document');
  if (hasControls(value)) throw new Error('Control characters are not permitted in link destinations');
  if (/^mailto:/i.test(value)) return mailto(value);
  if (value.length > 10_000) throw new Error('Link destination is too long');
  let url: URL;
  try { url = base ? new URL(value, base) : new URL(value); }
  catch { throw new Error('Relative or malformed URL needs an absolute document base'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) and mailto links can be opened');
  if (url.href.length > 10_000) throw new Error('Encoded link destination is too long');
  return { kind: 'open_url', href: url.href };
}
