import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const MAX_BYTES = 2 * 1024 * 1024;
const privateV4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) privateV4.addSubnet(address, prefix, 'ipv4');
const publicV6 = new BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) specialV6.addSubnet(address, prefix, 'ipv6');

export function isPublicDocumentAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !privateV4.check(address, 'ipv4') : family === 6 && publicV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}
export type DocumentAddress = { address: string; family: number };
export type DocumentLookup = (hostname: string) => Promise<DocumentAddress[]>;
export async function documentUrlTarget(raw: string, lookup: DocumentLookup = (host) => dnsLookup(host, { all: true, verbatim: true })): Promise<{ url: URL; address: DocumentAddress }> {
  const url = new URL(raw); const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (raw.length > 10_000 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || (url.port && !['80', '443'].includes(url.port))) throw new Error('Background links require a public HTTP(S) destination on a standard web port.');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !hostname.includes('.') && !isIP(hostname)) throw new Error('Local network destinations cannot run as document jobs.');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname);
  if (!addresses.length || addresses.some((entry) => !isPublicDocumentAddress(entry.address))) throw new Error('Private or reserved network destinations cannot run as document jobs.');
  return { url, address: addresses[0]! };
}

interface RawResponse { status: number; location?: string; contentType: string; encoding: string; bytes: Buffer }
export type DocumentTransport = (url: URL, address: DocumentAddress, signal: AbortSignal) => Promise<RawResponse>;
export interface PublicDocument { requestedUrl: string; finalUrl: string; html: string; httpStatus: number }

/** Resolve once and pin the TCP lookup: Chromium never receives network access. */
const requestPinned: DocumentTransport = (url, address, signal) => new Promise((resolve, reject) => {
  const lookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
  const handle = (response: IncomingMessage) => {
    const chunks: Buffer[] = []; let total = 0;
    response.on('data', (chunk: Buffer) => { total += chunk.length; if (total > MAX_BYTES) response.destroy(new Error('The linked document exceeds the background read limit.')); else chunks.push(chunk); });
    response.once('error', reject);
    response.once('end', () => resolve({ status: response.statusCode ?? 0, ...(response.headers.location ? { location: response.headers.location } : {}), contentType: String(response.headers['content-type'] ?? ''), encoding: String(response.headers['content-encoding'] ?? ''), bytes: Buffer.concat(chunks) }));
  };
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', agent: false, lookup, signal, timeout: 10_000, headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'accept-encoding': 'identity', 'user-agent': 'Carl-Allen-Document-Job/1' } }, handle);
  request.once('timeout', () => request.destroy(new Error('The linked document did not respond in time.')));
  request.once('error', reject); request.end();
});

/** Only reads public documents. No credentials, cookies, scripts, forms or subsequent resource fetches. */
export async function readPublicDocument(raw: string, signal: AbortSignal, options: { lookup?: DocumentLookup; transport?: DocumentTransport } = {}): Promise<PublicDocument> {
  let destination = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const target = await documentUrlTarget(destination, options.lookup);
    const response = await (options.transport ?? requestPinned)(target.url, target.address, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location || redirects === 5) throw new Error('The linked document has an unsupported redirect chain.');
      destination = new URL(response.location, target.url).href; continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`The linked document returned HTTP ${response.status}.`);
    if (response.bytes.length > MAX_BYTES) throw new Error('The linked document exceeds the background read limit.');
    const encoding = response.encoding.trim().toLowerCase();
    const bytes = encoding === 'gzip' ? gunzipSync(response.bytes, { maxOutputLength: MAX_BYTES }) : encoding === 'deflate' ? inflateSync(response.bytes, { maxOutputLength: MAX_BYTES }) : encoding === 'br' ? brotliDecompressSync(response.bytes, { maxOutputLength: MAX_BYTES }) : !encoding || encoding === 'identity' ? response.bytes : null;
    if (!bytes) throw new Error('The linked document uses an unsupported encoding.');
    if (bytes.length > MAX_BYTES) throw new Error('The linked document exceeds the background read limit.');
    const text = bytes.toString('utf8');
    const type = response.contentType.split(';')[0]!.trim().toLowerCase();
    if (type === 'text/plain') return { requestedUrl: raw, finalUrl: target.url.href, httpStatus: response.status, html: `<html><body><pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>` };
    if (!['text/html', 'application/xhtml+xml'].includes(type)) throw new Error('This link is not an HTML or text document.');
    return { requestedUrl: raw, finalUrl: target.url.href, httpStatus: response.status, html: text };
  }
  throw new Error('The linked document has too many redirects.');
}
