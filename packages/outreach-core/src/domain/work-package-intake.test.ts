import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkPackageManifest, sha256Hex, type HtmlImportAction } from '@splitin/outreach-contracts';
import { makeDomainEnv } from './domain.test-util';
import { registerProviderAccount } from './operations';
import { storeWorkPackage, repairWorkPackage, getWorkPackage } from './work-packages';
import { prepareWorkPackage } from './work-package-prepare';

const open: Awaited<ReturnType<typeof makeDomainEnv>>[] = [];
afterEach(() => { for (const env of open.splice(0)) env.engine.db.close(); vi.unstubAllEnvs(); });
async function fixture() {
  const env = await makeDomainEnv(); open.push(env);
  const account = await registerProviderAccount(env.engine, env.admin, {
    provider: 'fake-social', externalAccountId: 'intake-owner', sender: { name: 'Owner', address: 'owner@example.invalid' },
    purposes: ['social_publishing', 'social_messaging'], secretRef: 'env:FAKE_SOCIAL', executionPlacement: 'daytona-browser',
  });
  return { env, account };
}
function plan(scheduledFor: string | null) {
  return WorkPackageManifest.parse({
    schemaVersion: 1, packageId: 'html-intake', revision: 1, name: 'HTML intake',
    accountRefs: [{ id: 'owner', channel: 'linkedin', label: 'LinkedIn owner' }],
    contacts: [{ id: 'ada', name: 'Ada Example', linkedin: 'https://www.linkedin.com/in/ada-example/' }],
    outreachSequences: [{ id: 'connect', name: 'Connect', contacts: ['ada'], scheduledFor, steps: [{ id: 'step', kind: 'connect', channel: 'linkedin', accountRef: 'owner', text: '' }] }],
  });
}
const actions: HtmlImportAction[] = [
  { id: 'site', kind: 'open_url', source: 'anchor', label: 'Website', href: 'https://example.org/meeting' },
  { id: 'email', kind: 'compose_email', source: 'anchor', label: 'Email Ada', href: 'mailto:ada@example.org?subject=Hello&body=Draft', email: { to: ['ada@example.org'], cc: [], bcc: [], subject: 'Hello', body: 'Draft' } },
  { id: 'script', kind: 'unsupported', source: 'onclick', label: 'Dynamic button', reason: 'Requires an unsupported dynamic expression' },
];
const notes = [{ field: 'manifest', message: 'Inferred 1 LinkedIn profiles from this report. Map your LinkedIn account, then prepare only the reviewed connect plan.' }, { field: 'intent.connect_first', message: '1 person is tagged Connect first.' }];

describe('HTML intake persistence and execution prerequisites', () => {
  it('keeps the full manual action inventory and import notes through repair and preparation', async () => {
    const { env, account } = await fixture(); const manifest = plan(new Date(env.now() + 3600000).toISOString());
    const html = '<html>intake fixture</html>';
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html, manifest, issues: notes, actions, sourceHash: sha256Hex(html) });
    expect(pack.status).toBe('ready_for_review'); expect(pack.issues.every((issue) => issue.severity === 'info')).toBe(true);
    const repaired = repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { owner: account } });
    expect(repaired.extractedActions).toEqual(actions); expect(repaired.issues).toEqual(pack.issues);
    const prepared = prepareWorkPackage(env.engine, env.operator, pack.id);
    expect(prepared.authorizationId).toBeTruthy(); expect(prepared.preview.issues).toEqual([]);
    expect(prepared.package.extractedActions).toEqual(actions); expect(prepared.package.issues).toEqual(pack.issues);
    expect(prepareWorkPackage(env.engine, env.operator, pack.id).preview.issues).toEqual([]);
    expect(env.social.deliveries).toEqual([]); expect(env.fake.sendCalls).toBe(0);
  });

  it('requires an explicit future schedule and healthy account, then clears the stale blockers after revalidation', async () => {
    const { env, account } = await fixture(); const manifest = plan(null); const html = '<html>unscheduled</html>';
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html, manifest, issues: notes, sourceHash: sha256Hex(html), actions });
    env.engine.db.prepare("UPDATE provider_accounts SET health='reauth_required' WHERE id=?").run(account);
    const repair = repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { owner: account } });
    expect(repair.status).toBe('needs_repair');
    expect(repair.issues.some((issue) => issue.field === 'connect' && issue.message.includes('future start'))).toBe(true);
    expect(repair.issues.some((issue) => issue.field === 'owner' && issue.message.includes('Reconnect'))).toBe(true);
    const blocked = prepareWorkPackage(env.engine, env.operator, pack.id); expect(blocked.authorizationId).toBeNull();
    expect(env.engine.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 });
    manifest.outreachSequences[0]!.scheduledFor = new Date(env.now() + 3600000).toISOString();
    env.engine.db.prepare("UPDATE provider_accounts SET health='ok' WHERE id=?").run(account);
    const fixed = repairWorkPackage(env.engine, env.operator, pack.id, { manifest });
    expect(fixed.status).toBe('ready_for_review'); expect(fixed.issues.every((issue) => issue.severity === 'info')).toBe(true);
    expect(fixed.extractedActions).toEqual(actions);
    expect(prepareWorkPackage(env.engine, env.operator, pack.id).authorizationId).toBeTruthy();
    expect(env.social.deliveries).toEqual([]);
    const unmapped = repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { owner: '' } });
    expect(unmapped.accountMap).toEqual({}); expect(unmapped.issues.some((issue) => issue.message === 'Map a connected account')).toBe(true);
    expect(unmapped.status).toBe('needs_repair');
  });

  it.each(['past', 'invalid'])('rejects a %s sequence date before any queue write', async (kind) => {
    const { env, account } = await fixture(); const manifest = plan(new Date(env.now() - 1).toISOString()); const html = `<html>${kind}</html>`;
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html, manifest, issues: [], sourceHash: sha256Hex(html) });
    repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { owner: account } });
    if (kind === 'invalid') { manifest.outreachSequences[0]!.scheduledFor = 'invalid'; env.engine.db.prepare('UPDATE work_packages SET manifest=? WHERE id=?').run(JSON.stringify(manifest), pack.id); }
    const blocked = prepareWorkPackage(env.engine, env.operator, pack.id);
    expect(blocked.authorizationId).toBeNull(); expect(blocked.preview.issues.some((issue) => issue.message.includes('future start'))).toBe(true);
    expect(env.engine.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({ n: 0 });
  });

  it('does not downgrade real manifest errors to notes or erase them on account-only saves', async () => {
    const { env, account } = await fixture(); const manifest = plan(new Date(env.now() + 3600000).toISOString()); const html = '<html>bad original manifest</html>';
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html, manifest, sourceHash: sha256Hex(html), issues: [{ field: 'manifest', message: 'Invalid manifest JSON' }] });
    expect(pack.issues).toEqual([{ field: 'manifest', message: 'Invalid manifest JSON', severity: 'error' }]);
    const mapped = repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { owner: account } });
    expect(mapped.status).toBe('needs_repair'); expect(prepareWorkPackage(env.engine, env.operator, pack.id).authorizationId).toBeNull();
    repairWorkPackage(env.engine, env.operator, pack.id, { manifest });
    expect(prepareWorkPackage(env.engine, env.operator, pack.id).authorizationId).toBeTruthy();
  });

  it('prepares reviewed email steps while keeping email composition separate from sending', async () => {
    const { env } = await fixture(); const manifest = WorkPackageManifest.parse({ schemaVersion: 1, packageId: 'mail', revision: 1, name: 'Reviewed mail', accountRefs: [{ id: 'mail', channel: 'email', label: 'Mailbox' }], contacts: [{ id: 'ada', name: 'Ada Example', email: 'ada@example.org', consentBasis: 'consent' }], outreachSequences: [{ id: 'mail-sequence', name: 'Mail', contacts: ['ada'], scheduledFor: new Date(env.now() + 3600000).toISOString(), steps: [{ id: 'mail-step', kind: 'email', channel: 'email', accountRef: 'mail', subject: 'Hello {{first_name}}', text: 'Reviewed message' }] }] });
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html: 'mail', manifest, issues: [], sourceHash: sha256Hex('mail'), actions });
    repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { mail: env.accountId } });
    const prepared = prepareWorkPackage(env.engine, env.operator, pack.id);
    expect(prepared.preview.issues).toEqual([]); expect(prepared.authorizationId).toBeTruthy();
    expect(env.engine.db.prepare('SELECT kind,state FROM scheduled_actions').get()).toEqual({ kind: 'email.send', state: 'awaiting_approval' });
    expect(prepared.preview.renderedActions?.[0]?.payload).toMatchObject({ subject: 'Hello Ada' });
    expect(env.fake.sendCalls).toBe(0); expect(prepared.package.extractedActions).toEqual(actions);
  });

  it('distinguishes saved HTML, cloud-original storage, and a prepared execution receipt', async () => {
    vi.stubEnv('DAYTONA_SANDBOX_ID', ''); vi.stubEnv('OUTREACH_MEDIA_GATEWAY', ''); vi.stubEnv('CLOUD_MEDIA_SECRET', '');
    const { env, account } = await fixture(); const manifest = plan(new Date(env.now() + 3600000).toISOString());
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html: 'receipt', manifest, issues: [], sourceHash: sha256Hex('receipt') });
    expect(pack.cloudReceipt).toMatchObject({ stored: true, originalRemoteReady: false, executionReady: false, accepted: false, placement: 'local' });
    vi.stubEnv('DAYTONA_SANDBOX_ID', 'fixture-sandbox');
    expect(getWorkPackage(env.engine, env.viewer, pack.id).cloudReceipt).toMatchObject({ stored: true, originalRemoteReady: true, executionReady: false, accepted: false, placement: 'daytona' });
    repairWorkPackage(env.engine, env.operator, pack.id, { accountMap: { owner: account } });
    expect(prepareWorkPackage(env.engine, env.operator, pack.id).package.cloudReceipt).toMatchObject({ stored: true, originalRemoteReady: true, executionReady: true, accepted: true });
    vi.stubEnv('OUTREACH_MEDIA_GATEWAY', 'https://media.example.org'); vi.stubEnv('CLOUD_MEDIA_SECRET', 'fixture-only-secret');
    expect(getWorkPackage(env.engine, env.viewer, pack.id).cloudReceipt).toMatchObject({ stored: true, originalRemoteReady: false, executionReady: false, accepted: false });
    const row = env.engine.db.prepare('SELECT extracted_data FROM work_packages WHERE id=?').get<{ extracted_data: string }>(pack.id)!;
    env.engine.db.prepare('UPDATE work_packages SET extracted_data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.extracted_data), originalRemoteReady: true }), pack.id);
    expect(getWorkPackage(env.engine, env.viewer, pack.id).cloudReceipt).toMatchObject({ originalRemoteReady: true, executionReady: true, accepted: true });
  });

  it('keeps action-only reports useful without manufacturing an empty execution approval', async () => {
    const { env } = await fixture(); const manifest = WorkPackageManifest.parse({ schemaVersion: 1, packageId: 'manual', revision: 1, name: 'Manual links' });
    const pack = storeWorkPackage(env.engine, env.operator, { name: manifest.name, html: 'manual links', manifest, actions, issues: [], sourceHash: sha256Hex('manual links') });
    expect(pack.extractedActions).toEqual(actions);
    const result = prepareWorkPackage(env.engine, env.operator, pack.id);
    expect(result.authorizationId).toBeNull(); expect(result.preview.issues[0]?.message).toContain('Open its links');
    expect(env.engine.db.prepare('SELECT COUNT(*) n FROM approvals').get()).toEqual({ n: 0 });
  });
});
