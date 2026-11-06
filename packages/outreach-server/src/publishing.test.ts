import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createEngine, bootstrapWorkspace, authenticate, createApiToken, addPrincipal, registerProviderAccount, PUBLISHING_LIMITS } from '@splitin/outreach-core';
import { FakeSocialProvider, FAKE_SOCIAL_SECRET, staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { createApp } from './app';
const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
const mp4 = Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
describe('publishing workspace and protected uploads', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  async function fixture() {
    const mediaDir = mkdtempSync(join(tmpdir(), 'publishing-media-')); vi.stubEnv('OUTREACH_MEDIA_DIR', mediaDir);
    const db = openSqliteDatabase(':memory:'); const fake = new FakeSocialProvider(); const adapter = fake.adapter();
    const discover = adapter.account.discover;
    adapter.account.discover = async (ctx) => ({ ...await discover(ctx), socialChannels: ['linkedin','x','instagram','tiktok'], socialMediaTypes: ['image','video'] });
    const engine = createEngine({ db, adapters: [adapter], secrets: staticSecrets({ 'env:SOCIAL': FAKE_SOCIAL_SECRET }), workerId: 'publishing', sendGate: { mode: 'open' } });
    bootstrapWorkspace(db, { workspaceId: 'ws', name: 'Publishing', adminRef: 'admin', adminName: 'Admin' });
    const admin = authenticate(db, 'ws', 'admin', 'test', 't'); const tokens: Record<string, string> = {};
    for (const role of ['viewer','operator','admin'] as const) { const principalId = addPrincipal(engine, admin, { externalRef: `api-${role}`, displayName: role, roles: [role] }); tokens[role] = createApiToken(engine, admin, { principalId, name: role, roleCeiling: role, ttlDays: 1 }).token; }
    bootstrapWorkspace(db, { workspaceId: 'other', name: 'Other', adminRef: 'other-admin', adminName: 'Other' });
    const other = authenticate(db, 'other', 'other-admin', 'test', 't'); tokens.other = createApiToken(engine, other, { principalId: other.principalId, name: 'other', roleCeiling: 'admin', ttlDays: 1 }).token;
    const app = createApp({ engine });
    const request = (path: string, method = 'GET', body?: unknown, role = 'admin') => app.request(path, { method, headers: { authorization: `Bearer ${tokens[role] ?? ''}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const asset = async (bytes = png, mime = 'image/png') => {
      const started = await (await request('/v1/publishing/uploads', 'POST', { name: mime.startsWith('image') ? 'photo.png' : 'video.mp4', mime, size: bytes.length })).json() as { uploadId: string };
      for (let offset = 0, index = 0; offset < bytes.length; offset += PUBLISHING_LIMITS.chunkBytes, index++) expect((await request(`/v1/publishing/uploads/${started.uploadId}/chunks`, 'POST', { index, data: bytes.subarray(offset, offset + PUBLISHING_LIMITS.chunkBytes).toString('base64') })).status).toBe(200);
      const complete = await request(`/v1/publishing/uploads/${started.uploadId}/complete`, 'POST'); expect(complete.status).toBe(200);
      return (await complete.json() as { asset: { id: string; mediaUrl: string; sha256: string } }).asset;
    };
    const account = () => registerProviderAccount(engine, admin, { provider: 'fake-social', externalAccountId: `owner-${Math.random()}`, sender: { name: 'Owner', address: 'owner@example.org' }, purposes: ['social_publishing'], secretRef: 'env:SOCIAL', executionPlacement: 'daytona-browser' });
    const draft = (posts: { channel: string; text: string; mediaIds: string[]; accountId?: string }[]) => ({ name: 'Launch', timezone: 'America/New_York', scheduledFor: new Date(Date.now() + 3600000).toISOString(), posts });
    return { db, engine, fake, request, asset, account, draft, mediaDir };
  }
  beforeEach(async () => { f = await fixture(); });
  afterEach(() => { f.db.close(); rmSync(f.mediaDir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it('requires authentication and operator permission for media and draft mutations', async () => {
    expect((await f.request('/v1/publishing', 'GET', undefined, 'missing')).status).toBe(403);
    expect((await f.request('/v1/publishing', 'GET', undefined, 'viewer')).status).toBe(200);
    expect((await f.request('/v1/publishing/uploads', 'POST', { name: 'photo.png', mime: 'image/png', size: png.length }, 'viewer')).status).toBe(403);
    expect((await f.request('/v1/publishing/drafts', 'POST', f.draft([{ channel: 'linkedin', text: 'Draft', mediaIds: [] }]), 'viewer')).status).toBe(403);
  });
  it('uploads immutable bytes with ordered repeat-safe chunks and scoped preview reads', async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(PUBLISHING_LIMITS.chunkBytes)]);
    const start = await (await f.request('/v1/publishing/uploads', 'POST', { name: 'photo.png', mime: 'image/png', size: bytes.length })).json() as { uploadId: string; chunkBytes: number };
    const route = `/v1/publishing/uploads/${start.uploadId}`; const first = bytes.subarray(0, start.chunkBytes).toString('base64');
    expect((await f.request(`${route}/chunks`, 'POST', { index: 1, data: 'AAAA' })).status).toBe(409);
    expect((await f.request(`${route}/chunks`, 'POST', { index: 0, data: first })).status).toBe(200);
    expect((await f.request(`${route}/chunks`, 'POST', { index: 0, data: first })).status).toBe(200);
    expect((await f.request(`${route}/chunks`, 'POST', { index: 0, data: Buffer.alloc(start.chunkBytes, 2).toString('base64') })).status).toBe(409);
    expect((await f.request(`${route}/complete`, 'POST')).status).toBe(409);
    expect((await f.request(`${route}/chunks`, 'POST', { index: 1, data: bytes.subarray(start.chunkBytes).toString('base64') })).status).toBe(200);
    const complete = await (await f.request(`${route}/complete`, 'POST')).json() as { asset: { id: string; sha256: string; mediaUrl: string } };
    expect(complete.asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(complete.asset.mediaUrl).toBe(`outreach-media://${complete.asset.sha256}`);
    expect(await (await f.request(`${route}/complete`, 'POST')).json()).toEqual(complete);
    const read = await (await f.request(`/v1/publishing/media/${complete.asset.id}?offset=0&length=12`)).json() as { data: string };
    expect(Buffer.from(read.data, 'base64')).toEqual(png);
    expect((await f.request(`/v1/publishing/media/${complete.asset.id}`, 'GET', undefined, 'other')).status).toBe(404);
    expect((await f.request(`/v1/publishing/media/${complete.asset.id}`, 'DELETE', undefined, 'other')).status).toBe(404);
    expect((await f.request(`${route}/chunks`, 'POST', { index: 2, data: 'AAAA' })).status).toBe(409);
    const workspace = createHash('sha256').update('ws').digest('hex').slice(0, 24);
    expect(readFileSync(join(f.mediaDir, workspace, complete.asset.sha256))).toEqual(bytes);
  });
  it('rejects misleading types, unsafe names, oversized images and incomplete or invalid data', async () => {
    for (const input of [{ name: '../x.png', mime: 'image/png', size: 12 }, { name: 'x.svg', mime: 'image/svg+xml', size: 12 }, { name: 'x.png', mime: 'image/png', size: PUBLISHING_LIMITS.imageBytes + 1 }]) expect((await f.request('/v1/publishing/uploads', 'POST', input)).status).toBe(409);
    const started = await (await f.request('/v1/publishing/uploads', 'POST', { name: 'false.png', mime: 'image/png', size: 4 })).json() as { uploadId: string };
    const route = `/v1/publishing/uploads/${started.uploadId}`;
    expect((await f.request(`${route}/chunks`, 'POST', { index: 0, data: '!!!!' })).status).toBe(409);
    expect((await f.request(`${route}/chunks`, 'POST', { index: 0, data: Buffer.from('text').toString('base64') })).status).toBe(200);
    expect((await f.request(`${route}/complete`, 'POST')).status).toBe(409);
    expect((await f.request(route, 'DELETE')).status).toBe(200);
    expect((await f.request(`${route}/complete`, 'POST')).status).toBe(404);
  });
  it('creates real four-platform engine actions and exact hash approvals with stored media', async () => {
    const image = await f.asset(); const video = await f.asset(mp4, 'video/mp4'); const accountId = await f.account();
    const posts = ['linkedin','x','instagram','tiktok'].map((channel) => ({ channel, accountId, text: `${channel} caption`, mediaIds: [channel === 'tiktok' ? video.id : image.id] }));
    const saved = await (await f.request('/v1/publishing/drafts', 'POST', f.draft(posts))).json() as { draft: { id: string } };
    const submitted = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { draft: { status: string }; actions: { id: string; state: string; operationHash: string }[]; blocked: unknown[] };
    expect(submitted.blocked).toEqual([]); expect(submitted.draft.status).toBe('queued'); expect(submitted.actions).toHaveLength(4);
    expect(submitted.actions.every((a) => a.state === 'awaiting_approval' && /^[a-f0-9]{64}$/.test(a.operationHash))).toBe(true);
    const payload = f.db.prepare('SELECT payload FROM scheduled_actions WHERE id=?').get<{ payload: string }>(submitted.actions[0]!.id)!.payload;
    expect(payload).toContain('outreach-media://'); expect(payload).toContain(saved.draft.id);
    const replay = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { actions: { id: string }[] };
    expect(replay.actions.map((a) => a.id)).toEqual(submitted.actions.map((a) => a.id));
    expect((await f.request(`/v1/publishing/media/${image.id}`, 'DELETE')).status).toBe(409);
  });
  it('preserves blocked drafts and never manufactures schedules for disconnected or unsupported channels', async () => {
    const saved = await (await f.request('/v1/publishing/drafts', 'POST', f.draft([{ channel: 'tiktok', text: 'Not yet', mediaIds: [] }]))).json() as { draft: { id: string } };
    const blocked = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { draft: { status: string }; actions: unknown[]; blocked: { reason: string }[] };
    expect(blocked.draft.status).toBe('blocked'); expect(blocked.actions).toEqual([]); expect(blocked.blocked.some((i) => /Connect/.test(i.reason))).toBe(true);
    expect(f.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get<{ n: number }>()!.n).toBe(0);
    expect((await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST', undefined, 'other')).status).toBe(404);
  });
  it('edits pending schedules by cancelling old actions and revoking approvals, including same-clock updates', async () => {
    const accountId = await f.account(); vi.spyOn(f.engine, 'now').mockReturnValue(Date.now()); const input = f.draft([{ channel: 'linkedin', accountId, text: 'Original', mediaIds: [] }]);
    const saved = await (await f.request('/v1/publishing/drafts', 'POST', input)).json() as { draft: { id: string; updatedAt: number } };
    const first = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { actions: { id: string; approvalId: string }[] };
    const edited = await f.request('/v1/publishing/drafts', 'POST', { ...input, id: saved.draft.id, posts: [{ ...input.posts[0], text: 'Changed' }] }); expect(edited.status).toBe(201);
    expect(f.db.prepare('SELECT state FROM scheduled_actions WHERE id=?').get<{ state: string }>(first.actions[0]!.id)!.state).toBe('cancelled');
    expect(f.db.prepare('SELECT decision FROM approvals WHERE id=?').get<{ decision: string }>(first.actions[0]!.approvalId)!.decision).toBe('revoked');
    const second = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { actions: { id: string }[] };
    expect(second.actions[0]!.id).not.toBe(first.actions[0]!.id);
    const thirdSave = await f.request('/v1/publishing/drafts', 'POST', { ...input, id: saved.draft.id, posts: [{ ...input.posts[0], text: 'Third revision' }] }); expect(thirdSave.status).toBe(201);
    const third = await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST'); expect(third.status).toBe(200);
    expect((await third.json() as { blocked: unknown[] }).blocked).toEqual([]);
  });
  it('does not delete media referenced by drafts or queued actions and refuses in-flight draft edits', async () => {
    const image = await f.asset(); const accountId = await f.account(); const input = f.draft([{ channel: 'linkedin', accountId, text: 'Safe', mediaIds: [image.id] }]);
    const saved = await (await f.request('/v1/publishing/drafts', 'POST', input)).json() as { draft: { id: string } };
    expect((await f.request(`/v1/publishing/media/${image.id}`, 'DELETE')).status).toBe(409);
    const queued = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { actions: { id: string }[] };
    f.db.prepare("UPDATE scheduled_actions SET state='executing' WHERE id=?").run(queued.actions[0]!.id);
    expect((await f.request('/v1/publishing/drafts', 'POST', { ...input, id: saved.draft.id })).status).toBe(409);
    expect((await f.request(`/v1/publishing/drafts/${saved.draft.id}`, 'DELETE')).status).toBe(409);
    expect((await f.request(`/v1/publishing/media/${image.id}`, 'DELETE')).status).toBe(409);
  });
  it('deduplicates media only within the owning workspace and removes unreferenced files', async () => {
    const first = await f.asset(); const second = await f.asset(); expect(first.id).toBe(second.id);
    expect((await f.request(`/v1/publishing/media/${first.id}`, 'DELETE', undefined, 'viewer')).status).toBe(403);
    expect((await f.request(`/v1/publishing/media/${first.id}`, 'DELETE')).status).toBe(200);
    expect((await f.request(`/v1/publishing/media/${first.id}`)).status).toBe(404);
  });
  it('supports media-only captions and counts Unicode code points consistently with the composer', async () => {
    const image = await f.asset(); const accountId = await f.account();
    for (const post of [{ channel: 'instagram', accountId, text: '', mediaIds: [image.id] }, { channel: 'x', accountId, text: '🚀'.repeat(280), mediaIds: [] }]) {
      const saved = await (await f.request('/v1/publishing/drafts', 'POST', f.draft([post]))).json() as { draft: { id: string } };
      const submitted = await (await f.request(`/v1/publishing/drafts/${saved.draft.id}/submit`, 'POST')).json() as { actions: unknown[]; blocked: unknown[] };
      expect(submitted.blocked).toEqual([]); expect(submitted.actions).toHaveLength(1);
    }
  });
  it('bounds unfinished uploads, cancels them and expires abandoned files before accepting more', async () => {
    const upload = () => f.request('/v1/publishing/uploads', 'POST', { name: 'photo.png', mime: 'image/png', size: png.length });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) { const response = await upload(); expect(response.status).toBe(201); ids.push((await response.json() as { uploadId: string }).uploadId); }
    expect((await upload()).status).toBe(409);
    expect((await f.request(`/v1/publishing/uploads/${ids[0]}`, 'DELETE')).status).toBe(200);
    expect((await upload()).status).toBe(201);
    f.db.prepare('UPDATE publishing_uploads SET created_at=0').run();
    expect((await upload()).status).toBe(201);
    expect(f.db.prepare('SELECT COUNT(*) n FROM publishing_uploads').get<{ n: number }>()!.n).toBe(1);
  });

  it('persists authoritative workspace and global sending stops across refresh with role-safe resume', async () => {
    const snapshot = async () => (await (await f.request('/v1/publishing')).json()) as { sendingStopped: boolean; sendingStopScopes: string[] };
    expect((await snapshot()).sendingStopped).toBe(false);
    expect((await f.request('/v1/kill-switches', 'POST', { scope: 'workspace', engaged: true, reason: 'Stop from studio' }, 'operator')).status).toBe(200);
    expect(await snapshot()).toMatchObject({ sendingStopped: true, sendingStopScopes: ['workspace'] });
    expect((await f.request('/v1/kill-switches', 'POST', { scope: 'workspace', engaged: false, reason: 'Resume' }, 'operator')).status).toBe(403);
    expect((await f.request('/v1/kill-switches', 'POST', { scope: 'workspace', engaged: false, reason: 'Reviewed', }, 'admin')).status).toBe(200);
    expect((await snapshot()).sendingStopped).toBe(false);
    expect((await f.request('/v1/kill-switches', 'POST', { scope: 'global', engaged: true, reason: 'Global stop' })).status).toBe(200);
    expect(await snapshot()).toMatchObject({ sendingStopped: true, sendingStopScopes: ['global'] });
  });

});
