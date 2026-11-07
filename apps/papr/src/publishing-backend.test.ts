import { afterEach, describe, expect, it, vi } from 'vitest';
const { handle } = await import(new URL('../bundle/apps/outreach-console/backend/outreach.mjs', import.meta.url).href) as { handle(action: string, params?: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> };
const saved = { ...process.env }; const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });
describe('publishing Papr backend bridge', () => {
  function setup(roles: string[] = []) {
    delete process.env.OUTREACH_CONNECTION_FILE; process.env.OUTREACH_API_URL = 'https://private-preview.example.test'; process.env.OUTREACH_API_TOKEN = 'engine-private'; process.env.OUTREACH_PREVIEW_TOKEN = 'preview-private'; process.env.OUTREACH_DAYTONA_LIVE_VIEW_URL = 'https://login.example.test/vnc.html';
    const seen: { url: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => { seen.push({ url: String(url), options }); return { ok: true, json: async () => ({ roles, accounts: [], drafts: [], media: [], actions: [], approvals: [] }) }; });
    return seen;
  }
  it('uses fixed routes and server-only independent credentials for chunked uploads and reads', async () => {
    const seen = setup();
    expect((await handle('publishing-upload-chunk', { uploadId: id, index: 2, data: 'AAAA' })).ok).toBe(true);
    await handle('publishing-media-read', { assetId: id, offset: 65536, length: 65536 });
    expect(seen[0]!.url).toBe(`https://private-preview.example.test/v1/publishing/uploads/${id}/chunks`);
    expect(JSON.parse(String(seen[0]!.options.body))).toEqual({ index: 2, data: 'AAAA' });
    expect(seen[0]!.options.headers).toMatchObject({ authorization: 'Bearer engine-private', 'x-daytona-preview-token': 'preview-private' });
    expect(seen[1]!.url).toContain(`v1/publishing/media/${id}?offset=65536&length=65536`);
    expect(seen.every((r) => r.options.redirect === 'error')).toBe(true);
    const fullChunk = { uploadId: id, index: 0, data: Buffer.alloc(65536).toString('base64') };
    expect(Buffer.byteLength(JSON.stringify(fullChunk)) + Buffer.byteLength('PAPR_ACTION_PARAMS=')).toBeLessThan(128 * 1024);
    await handle('publishing-upload-chunk', fullChunk);
    expect(Buffer.byteLength(String(seen[2]!.options.body))).toBeLessThan(128 * 1024);
  });
  it('shows the private sign-in desktop only to administrators', async () => {
    setup(['admin']); const result=await handle('publishing-overview');
    expect(result.data).toMatchObject({liveViewUrl:'https://login.example.test/vnc.html'});
  });
  it('rejects route traversal and keeps engine credentials out of the overview', async () => {
    const seen = setup();
    expect((await handle('publishing-media-read', { assetId: '../tokens' })).ok).toBe(false); expect(seen).toEqual([]);
    const result = await handle('publishing-overview'); expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ accounts: [], liveViewUrl: null });
    expect(JSON.stringify(result)).not.toContain('engine-private'); expect(JSON.stringify(result)).not.toContain('preview-private');
  });
});
