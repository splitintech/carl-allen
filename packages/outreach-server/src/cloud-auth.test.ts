import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bootstrapWorkspace, type Engine } from '@splitin/outreach-core';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { authenticateCloudRequest, type CloudDelegation } from './cloud-auth';
const secret = 'fixture-gateway-key-with-at-least-32-characters';
const databases: ReturnType<typeof openSqliteDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openSqliteDatabase(':memory:'); databases.push(db);
  const now = 1800000000000;
  bootstrapWorkspace(db, { workspaceId: 'ws', name: 'Fixture', adminRef: 'google:owner', adminName: 'Owner' }, now);
  bootstrapWorkspace(db, { workspaceId: 'foreign', name: 'Foreign', adminRef: 'google:foreign-owner', adminName: 'Foreign' }, now);
  return { db, now: () => now } as Pick<Engine, 'db' | 'now'>;
}
function request(env: Pick<Engine, 'now'>, overrides: Partial<CloudDelegation> = {}, actualBody = '{}') {
  const value: CloudDelegation = { identityProvider: 'google', sub: 'owner', workspaceId: 'ws', surface: 'http', scopes: [], method: 'POST', path: '/v1/work-packages', bodySha256: createHash('sha256').update(actualBody).digest('hex'), iat: env.now() / 1000, exp: env.now() / 1000 + 45, jti: randomBytes(24).toString('base64url'), ...overrides };
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return new Request('https://engine.test/v1/work-packages', { method: 'POST', headers: { 'x-carl-delegation': encoded, 'x-carl-signature': createHmac('sha256', secret).update(encoded).digest('hex') }, body: actualBody });
}
it('cloud delegation resolves the actual member, denies replay and does not accept unsigned or body-altered identity', async () => {
  const env = fixture(); const original = request(env);
  expect((await authenticateCloudRequest(original, env, 'fixture', secret))?.roles).toEqual(['admin']);
  await expect(authenticateCloudRequest(original.clone(), env, 'fixture', secret)).rejects.toThrow('invalid cloud delegation');
  const missing = new Request('https://engine.test/v1/me'); expect(await authenticateCloudRequest(missing, env, 'fixture', secret)).toBeNull();
  await expect(authenticateCloudRequest(request(env, { bodySha256: '0'.repeat(64) }), env, 'fixture', secret)).rejects.toThrow();
  await expect(authenticateCloudRequest(request(env), env, 'fixture', 'wrong-secret-with-more-than-32-characters')).rejects.toThrow();
  await expect(authenticateCloudRequest(request(env, { exp: env.now() / 1000 - 1 }), env, 'fixture', secret)).rejects.toThrow();
});
it('unknown/foreign subjects are refused; a verified invitation claims exactly its workspace role once', async () => {
  const env = fixture();
  await expect(authenticateCloudRequest(request(env, { sub: 'new' }), env, 'fixture', secret)).rejects.toThrow();
  await expect(authenticateCloudRequest(request(env, { workspaceId: 'foreign' }), env, 'fixture', secret)).rejects.toThrow();
  env.db.prepare('INSERT INTO cloud_invitations(id,workspace_id,email,roles,expires_at,created_at) VALUES (?,?,?,?,?,?)').run('invite', 'ws', 'member@example.invalid', '["operator"]', env.now() + 60000, env.now());
  await expect(authenticateCloudRequest(request(env, { sub: 'new', email: 'member@example.invalid', emailVerified: false }), env, 'fixture', secret)).rejects.toThrow();
  const member = await authenticateCloudRequest(request(env, { sub: 'new', email: 'MEMBER@example.invalid', emailVerified: true }), env, 'fixture', secret);
  expect(member?.roles).toEqual(['operator']); expect(member?.workspaceId).toBe('ws');
  expect(env.db.prepare('SELECT COUNT(*) n FROM principals WHERE external_ref=?').get('google:new')).toEqual({ n: 1 });
  expect(env.db.prepare('SELECT accepted_at FROM cloud_invitations WHERE id=?').get('invite')).toEqual({ accepted_at: env.now() });
  await expect(authenticateCloudRequest(request(env, { sub: 'another', email: 'member@example.invalid', emailVerified: true }), env, 'fixture', secret)).rejects.toThrow();
});
it('remote scopes ceiling an admin to viewer/operator so a model cannot inherit final-approval authority', async () => {
  const env = fixture();
  expect((await authenticateCloudRequest(request(env, { surface: 'mcp', scopes: ['carl:read'] }), env, 'fixture', secret))?.roles).toEqual(['viewer']);
  expect((await authenticateCloudRequest(request(env, { surface: 'mcp', scopes: ['carl:read', 'carl:prepare'] }), env, 'fixture', secret))?.roles).toEqual(['operator']);
  await expect(authenticateCloudRequest(request(env, { surface: 'mcp', scopes: ['carl:prepare'] }), env, 'fixture', secret)).rejects.toThrow();
  env.db.prepare('UPDATE principals SET roles=? WHERE external_ref=?').run('[]', 'google:owner');
  await expect(authenticateCloudRequest(request(env), env, 'fixture', secret)).rejects.toThrow();
});
