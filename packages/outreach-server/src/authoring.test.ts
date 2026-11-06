import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createEngine, bootstrapWorkspace, authenticate, addPrincipal, createApiToken, registerProviderAccount } from '@splitin/outreach-core';
import { FakeEmailProvider, FakeSocialProvider, staticSecrets, FAKE_EMAIL_SECRET } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { DraftMutationRefusedError, type MailDraft } from '@splitin/outreach-contracts';
import { createApp } from './app';

describe('protected authoring and draft routes', () => {
  let setup: Awaited<ReturnType<typeof fixture>>;
  async function fixture() {
    const calls: string[] = [];
    let refuseDraft = false;
    const email = new FakeEmailProvider().adapter();
    const draft: MailDraft = { id: 'draft-1', content: { from: { address: 'owner@example.org' }, to: [{ address: 'recipient@example.net' }], subject: 'Draft', text: 'Hello', headers: {} } };
    const adapter = { ...email, drafts: { list: async () => { calls.push('list'); return [draft]; }, get: async () => draft, save: async () => { if (refuseDraft) throw new DraftMutationRefusedError('This draft has attachments; no update was made.'); calls.push('save'); return draft; }, delete: async () => { calls.push('delete'); } } };
    const db = openSqliteDatabase(':memory:');
    const engine = createEngine({ db, adapters: [adapter, new FakeSocialProvider().adapter()], secrets: staticSecrets({ 'env:MAIL': FAKE_EMAIL_SECRET }), workerId: 'authoring-test' });
    bootstrapWorkspace(db, { workspaceId: 'ws', name: 'W', adminRef: 'admin', adminName: 'Admin' });
    const admin = authenticate(db, 'ws', 'admin', 'cli', 'test');
    const tokens: Record<string,string> = {};
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const principalId = addPrincipal(engine, admin, { externalRef: role === 'admin' ? 'api-admin' : role, displayName: role, roles: [role] });
      tokens[role] = createApiToken(engine, admin, { principalId, name: role, roleCeiling: role, ttlDays: 1 }).token;
    }
    const accountId = await registerProviderAccount(engine, admin, { provider: email.name, externalAccountId: 'mailbox', sender: { name: 'Owner', address: 'owner@example.org' }, purposes: ['manual_correspondence'], secretRef: 'env:MAIL' });
    bootstrapWorkspace(db, { workspaceId: 'foreign', name: 'Foreign', adminRef: 'foreign-admin', adminName: 'Foreign' });
    const foreignCtx = authenticate(db, 'foreign', 'foreign-admin', 'cli', 'test');
    const foreignId = await registerProviderAccount(engine, foreignCtx, { provider: email.name, externalAccountId: 'foreign-mailbox', sender: { name: 'Foreign', address: 'foreign@example.org' }, purposes: ['manual_correspondence'], secretRef: 'env:MAIL' });
    const app = createApp({ engine });
    const request = (role: string, path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers: { authorization: `Bearer ${tokens[role] ?? ''}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { db, engine, admin, accountId, foreignId, request, calls, draft, refuseNextDraft: () => { refuseDraft = true; } };
  }
  beforeEach(async () => { setup = await fixture(); });
  afterEach(() => setup.db.close());
  it('permits viewing drafts while refusing viewer mutations and unknown workspace accounts before provider calls', async () => {
    const { request, accountId, calls, draft } = setup;
    expect((await request('viewer', `/v1/accounts/${accountId}/drafts`)).status).toBe(200);
    expect((await request('viewer', `/v1/accounts/${accountId}/drafts`, 'POST', draft.content)).status).toBe(403);
    expect((await request('operator', '/v1/accounts/missing/check', 'POST')).status).toBe(404);
    expect((await request('operator', `/v1/accounts/${setup.foreignId}/check`, 'POST')).status).toBe(404);
    expect((await request('operator', `/v1/accounts/${setup.foreignId}/drafts`, 'POST', draft.content)).status).toBe(404);
    expect((await request('viewer', `/v1/accounts/${accountId}/check`, 'POST')).status).toBe(403);
    expect(calls).toEqual(['list']);
  });
  it('saves/deletes explicit mailbox drafts without invoking the email sender and rejects sender spoofing', async () => {
    const { request, accountId, calls, draft } = setup;
    expect((await request('operator', `/v1/accounts/${accountId}/drafts`, 'POST', { ...draft.content, from: { address: 'other@example.org' } })).status).toBe(403);
    expect((await request('operator', `/v1/accounts/${accountId}/drafts`, 'POST', draft.content)).status).toBe(200);
    expect((await request('operator', `/v1/accounts/${accountId}/drafts/draft-1`, 'DELETE')).status).toBe(200);
    expect(calls).toEqual(['save', 'delete']);
    expect(setup.db.prepare('SELECT COUNT(*) AS n FROM scheduled_actions').get<{n:number}>()?.n).toBe(0);
  });
  it('authors, edits and schedules content through protected routes with fresh approval', async () => {
    const social = setup.engine.adapters.get('fake-social')!;
    const accountId = await registerProviderAccount(setup.engine, setup.admin, { provider: social.name, externalAccountId: 'social-owner', sender: { name: 'Owner', address: 'owner@example.org' }, purposes: ['social_publishing','social_messaging'], secretRef: 'env:MAIL', executionPlacement: 'daytona-browser' });
    const input = { name: 'Draft post', channel: 'linkedin', text: 'Original', providerAccountId: accountId, scheduledFor: new Date(Date.now()+3600000).toISOString(), timezone: 'America/New_York' };
    const created = await setup.request('operator', '/v1/content-compose', 'POST', input);
    expect(created.status).toBe(201); const result = await created.json() as {campaignId:string};
    const edited = await setup.request('operator', '/v1/content-compose', 'POST', {...input,campaignId:result.campaignId,postId:'post',text:'Edited'});
    expect(edited.status).toBe(201);
    const drafts = await (await setup.request('viewer','/v1/content-campaigns')).json() as {campaigns:{posts:{text:string}[]}[]};
    expect(drafts.campaigns[0]?.posts[0]?.text).toBe('Edited');
    expect((await setup.request('operator', `/v1/content-campaigns/${result.campaignId}/activate`, 'POST')).status).toBe(200);
    const action=setup.db.prepare('SELECT id,approval_id FROM scheduled_actions WHERE campaign_id=?').get<{id:string;approval_id:string}>(result.campaignId)!;
    expect((await setup.request('viewer',`/v1/actions/${action.id}`)).status).toBe(200);
    expect((await setup.request('operator',`/v1/actions/${action.id}`,'PATCH',{text:'Fresh edit'})).status).toBe(200);
    expect(setup.db.prepare('SELECT approval_id FROM scheduled_actions WHERE id=?').get<{approval_id:string}>(action.id)?.approval_id).not.toBe(action.approval_id);
    expect((await setup.request('viewer',`/v1/actions/${action.id}`,'PATCH',{text:'No'})).status).toBe(403);
  });
  it('preserves the campaign account when editing one post and reports safe draft refusal', async () => {
    const account = async (externalAccountId: string) => registerProviderAccount(setup.engine, setup.admin, {provider:'fake-social',externalAccountId,sender:{name:'Owner',address:'owner@example.org'},purposes:['social_publishing'],secretRef:'env:MAIL',executionPlacement:'daytona-browser'});
    const first=await account('first'),second=await account('second');
    const input={name:'Routing',channel:'linkedin',text:'Post',providerAccountId:first,scheduledFor:new Date(Date.now()+3600000).toISOString(),timezone:'America/New_York'};
    const created=await (await setup.request('operator','/v1/content-compose','POST',input)).json() as {campaignId:string};
    expect((await setup.request('operator','/v1/content-compose','POST',{...input,providerAccountId:second,campaignId:created.campaignId,postId:'post'})).status).toBe(201);
    const campaign=await (await setup.request('viewer',`/v1/content-campaigns/${created.campaignId}`)).json() as {providerAccountId:string;calendar:{spec:{posts:{providerAccountId:string}[]}}};
    expect(campaign.providerAccountId).toBe(first);expect(campaign.calendar.spec.posts[0]?.providerAccountId).toBe(second);
    setup.refuseNextDraft();
    const refused=await setup.request('operator',`/v1/accounts/${setup.accountId}/drafts`,'POST',setup.draft.content);
    expect(refused.status).toBe(409);expect(await refused.json()).toMatchObject({error:'draft_mutation_refused'});
  });
  it('protects content authoring and account registration by role', async () => {
    expect((await setup.request('viewer', '/v1/content-compose', 'POST', {})).status).toBe(403);
    expect((await setup.request('operator', '/v1/accounts', 'POST', {})).status).toBe(403);
    expect((await setup.request('viewer', '/v1/content-campaigns')).status).toBe(200);
    expect((await setup.request('viewer', '/v1/accounts')).status).toBe(200);
    const upcoming = await setup.request('viewer', '/v1/actions/upcoming');
    expect(upcoming.status).toBe(200);
    expect(await upcoming.json()).toHaveProperty('actions');
  });
});
