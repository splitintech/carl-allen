import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { documentUrlTarget, isPublicDocumentAddress, readPublicDocument, type DocumentTransport } from './document-public-url';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
describe('background document URL reads', () => {
  it('blocks private, mapped, link-local, special-use and non-web targets before transport', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '100.64.1.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) expect(isPublicDocumentAddress(address), address).toBe(false);
    expect(isPublicDocumentAddress('93.184.216.34')).toBe(true); expect(isPublicDocumentAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'http://localhost/', 'http://node.local/', 'http://service/', 'file:///etc/passwd', 'https://user:password@example.test/', 'https://example.test:8443/']) await expect(documentUrlTarget(url, publicLookup), url).rejects.toThrow();
  });
  it('requires every DNS result to be public and pins the validated result passed to transport', async () => {
    await expect(documentUrlTarget('https://example.test/', async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toThrow('Private');
    let seen = false;
    const transport: DocumentTransport = async (url, address) => { seen = true; expect(url.hostname).toBe('example.test'); expect(address).toEqual({ address: '93.184.216.34', family: 4 }); return { status: 200, contentType: 'text/html', encoding: '', bytes: Buffer.from('<title>Public</title>') }; };
    const result = await readPublicDocument('https://example.test/', new AbortController().signal, { lookup: publicLookup, transport }); expect(seen).toBe(true); expect(result.finalUrl).toBe('https://example.test/');
  });
  it('revalidates every redirect and never dials its private destination', async () => {
    let requests = 0;
    const transport: DocumentTransport = async () => { requests++; return { status: 302, location: 'http://169.254.169.254/latest/meta-data/', contentType: '', encoding: '', bytes: Buffer.alloc(0) }; };
    await expect(readPublicDocument('https://example.test/', new AbortController().signal, { lookup: publicLookup, transport })).rejects.toThrow('Private'); expect(requests).toBe(1);
  });
  it('caps redirects, decoded bytes and content types without treating errors as success', async () => {
    const signal = new AbortController().signal;
    const redirect: DocumentTransport = async () => ({ status: 302, location: '/again', contentType: '', encoding: '', bytes: Buffer.alloc(0) });
    await expect(readPublicDocument('https://example.test/', signal, { lookup: publicLookup, transport: redirect })).rejects.toThrow('redirect');
    const compressed: DocumentTransport = async () => ({ status: 200, contentType: 'text/html', encoding: 'gzip', bytes: gzipSync(Buffer.alloc(3 * 1024 * 1024, 65)) });
    await expect(readPublicDocument('https://example.test/', signal, { lookup: publicLookup, transport: compressed })).rejects.toThrow();
    const binary: DocumentTransport = async () => ({ status: 200, contentType: 'application/octet-stream', encoding: '', bytes: Buffer.from('binary') });
    await expect(readPublicDocument('https://example.test/', signal, { lookup: publicLookup, transport: binary })).rejects.toThrow('not an HTML');
    const failed: DocumentTransport = async () => ({ status: 403, contentType: 'text/html', encoding: '', bytes: Buffer.alloc(0) });
    await expect(readPublicDocument('https://example.test/', signal, { lookup: publicLookup, transport: failed })).rejects.toThrow('HTTP 403');
  });
  it('escapes plain text and respects cancellation before lookup or requests', async () => {
    const text: DocumentTransport = async () => ({ status: 200, contentType: 'text/plain; charset=utf-8', encoding: '', bytes: Buffer.from('<script>unsafe()</script>') });
    const result = await readPublicDocument('https://example.test/', new AbortController().signal, { lookup: publicLookup, transport: text }); expect(result.html).toContain('&lt;script&gt;');
    await expect(readPublicDocument('https://example.test/', AbortSignal.abort(), { lookup: publicLookup, transport: text })).rejects.toThrow();
  });
});
