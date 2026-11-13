import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex, WorkPackageManifest } from '@splitin/outreach-contracts';
import { authenticate, bootstrapWorkspace, createApiToken, createEngine, registerProviderAccount, storeWorkPackage, type WorkPackage } from '@splitin/outreach-core';
import { FakeSocialProvider, FAKE_SOCIAL_SECRET, staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { createApp } from './app';

const open: ReturnType<typeof openSqliteDatabase>[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.stubEnv('DAYTONA_SANDBOX_ID', 'fixture-only'); vi.stubEnv('OUTREACH_MEDIA_GATEWAY', ''); vi.stubEnv('CLOUD_MEDIA_SECRET', '');
  const db = openSqliteDatabase(':memory:'); open.push(db); const fake = new FakeSocialProvider();
  const engine = createEngine({ db, adapters: [fake.adapter()], secrets: staticSecrets({ 'env:SOCIAL': FAKE_SOCIAL_SECRET }), workerId: 'intake', sendGate: { mode: 'open' } });
  bootstrapWorkspace(db, { workspaceId: 'intake-ws', name: 'Intake test', adminRef: 'admin', adminName: 'Admin' });
  const admin = authenticate(db, 'intake-ws', 'admin', 'test', 'intake-trace');
  const token = createApiToken(engine, admin, { principalId: admin.principalId, name: 'Fixture only', roleCeiling: 'admin', ttlDays: 1 }).token;
  const account = await registerProviderAccount(engine, admin, { provider: 'fake-social', externalAccountId: 'owner', sender: { name: 'Owner', address: 'owner@example.invalid' }, purposes: ['social_messaging'], secretRef: 'env:SOCIAL', executionPlacement: 'daytona-browser' });
  const app = createApp({ engine });
  const request = (path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { db, engine, admin, fake, request, account };
}

describe('HTML upload action inventory API', () => {
  it('persists and returns extracted email and URL actions while requiring a reviewed schedule for execution', async () => {
    const f = await fixture();
    const html = '<title>API intake</title><article class="card"><a href="https://www.linkedin.com/in/ada-example/">Ada Example</a> <span>Connect first</span> <a href="mailto:ada@example.org?subject=Hello&body=Draft">Email Ada</a> <a href="https://example.org/meeting">Book meeting</a></article>';
    const response = await f.request('/v1/work-packages', 'POST', { name: 'intake.html', html }); expect(response.status).toBe(201);
    const { package: pack } = await response.json() as { package: WorkPackage };
    expect(pack.extractedActions.some((action) => action.kind === 'compose_email' && action.email.subject === 'Hello' && action.email.body === 'Draft')).toBe(true);
    expect(pack.extractedActions.some((action) => action.kind === 'open_url' && action.href === 'https://example.org/meeting')).toBe(true);
    expect(pack.manifest?.outreachSequences[0]?.scheduledFor).toBeNull();
    expect(pack.cloudReceipt).toMatchObject({ stored: true, originalRemoteReady: true, executionReady: false, accepted: false });
    const read = await (await f.request(`/v1/work-packages/${pack.id}`)).json() as { package: WorkPackage };
    expect(read.package.extractedActions).toEqual(pack.extractedActions);
    const listed = await (await f.request('/v1/work-packages')).json() as { packages: WorkPackage[] };
    expect(listed.packages[0]?.extractedActions).toEqual(pack.extractedActions);
    const blocked = await (await f.request(`/v1/work-packages/${pack.id}/prepare`, 'POST', {})).json() as { authorizationId: string | null; preview: { issues: { message: string }[] } };
    expect(blocked.authorizationId).toBeNull(); expect(blocked.preview.issues.some((issue) => issue.message.includes('future start'))).toBe(true);
    const manifest = pack.manifest!; manifest.outreachSequences[0]!.scheduledFor = new Date(Date.now() + 3600000).toISOString();
    const repaired = await f.request(`/v1/work-packages/${pack.id}`, 'PATCH', { manifest, accountMap: { 'linkedin-main': f.account } }); expect(repaired.status).toBe(200);
    const prepared = await (await f.request(`/v1/work-packages/${pack.id}/prepare`, 'POST', {})).json() as { authorizationId: string | null; preview: { issues: unknown[] } };
    expect(prepared.authorizationId).toBeTruthy(); expect(prepared.preview.issues).toEqual([]);
    expect(f.fake.deliveries).toEqual([]);
    expect(f.db.prepare('SELECT state FROM scheduled_actions').all()).toEqual([{ state: 'awaiting_approval' }]);
  });

  it('enriches pre-inventory packages from their original HTML without mutating manifests, schedules, or source rows', async () => {
    const f = await fixture(); const html = '<a href="https://example.org/legacy">Legacy site</a><a href="mailto:legacy@example.org?subject=Stored">Email</a>';
    const manifest = WorkPackageManifest.parse({ schemaVersion: 1, packageId: 'legacy', revision: 1, name: 'Legacy', contacts: [{ id: 'person', name: 'Repaired name', email: 'repaired@example.org' }] });
    const pack = storeWorkPackage(f.engine, f.admin, { name: 'Legacy', html, manifest, sourceHash: sha256Hex(html), issues: [] });
    f.db.prepare('UPDATE work_packages SET extracted_data=? WHERE id=?').run(JSON.stringify({ text: 'Legacy source text', tables: [] }), pack.id);
    const before = f.db.prepare('SELECT * FROM work_packages WHERE id=?').get(pack.id);
    for (const path of [`/v1/work-packages/${pack.id}`, '/v1/work-packages']) {
      const response = await f.request(path); expect(response.status).toBe(200);
      const value = await response.json() as { package?: WorkPackage; packages?: WorkPackage[] }; const read = value.package ?? value.packages![0]!;
      expect(read.manifest).toEqual(manifest); expect(read.accountMap).toEqual({});
      expect(read.extractedActions.map((action) => action.kind)).toEqual(['open_url', 'compose_email']);
      expect(read.extractedActions[1]).toMatchObject({ kind: 'compose_email', email: { to: ['legacy@example.org'], subject: 'Stored' } });
    }
    expect(f.db.prepare('SELECT * FROM work_packages WHERE id=?').get(pack.id)).toEqual(before);
    const saved = await (await f.request(`/v1/work-packages/${pack.id}`, 'PATCH', { manifest })).json() as { package: WorkPackage };
    expect(saved.package.manifest).toEqual(manifest); expect(saved.package.extractedActions).toHaveLength(2);
    const prepared = await (await f.request(`/v1/work-packages/${pack.id}/prepare`, 'POST', {})).json() as { package: WorkPackage; authorizationId: string | null };
    expect(prepared.authorizationId).toBeNull(); expect(prepared.package.extractedActions).toHaveLength(2);
    expect(f.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
    expect(f.fake.deliveries).toEqual([]);
  });

  it('keeps malformed-manifest HTML readable as an action inventory while blocking preparation', async () => {
    const f = await fixture();
    const html = '<a href="https://example.org/safe">Open site</a><script id="carl-allen-manifest" type="application/json">{broken</script>';
    const response = await f.request('/v1/work-packages', 'POST', { name: 'invalid.html', html }); expect(response.status).toBe(201);
    const { package: pack } = await response.json() as { package: WorkPackage };
    expect(pack.manifest).toBeNull(); expect(pack.extractedActions.some((action) => action.kind === 'open_url')).toBe(true);
    expect(pack.issues.some((issue) => issue.field === 'manifest' && issue.severity === 'error')).toBe(true);
    expect((await f.request(`/v1/work-packages/${pack.id}/prepare`, 'POST', {})).status).toBe(409);
    expect(f.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 });
  });
});
