import { expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { bootstrapWorkspace, authenticate, createApiToken, createEngine, registerProviderAccount } from '@splitin/outreach-core';
import { FakeSocialProvider, FAKE_SOCIAL_SECRET, staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { createApp, startServer } from '@splitin/outreach-server';
// @ts-expect-error dependency-free local preview host has no declaration file.
import { createPublishingPreview } from '../preview.mjs';

it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1')('persists a real browser upload and draft through the Papr bridge, queues hash approval, and keeps credentials out of the browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-fullstack-')); vi.stubEnv('OUTREACH_MEDIA_DIR', dir);
  const db = openSqliteDatabase(':memory:'); const fake = new FakeSocialProvider(); const adapter = fake.adapter(); const discover = adapter.account.discover;
  adapter.account.discover = async (ctx) => ({ ...await discover(ctx), socialMediaTypes: ['image','video'] });
  const engine = createEngine({db,adapters:[adapter],secrets:staticSecrets({'env:FIXTURE_SOCIAL':FAKE_SOCIAL_SECRET}),workerId:'studio-fullstack-fixture'});
  bootstrapWorkspace(db,{workspaceId:'studio-fixture',name:'Fixture workspace',adminRef:'fixture:admin',adminName:'Fixture owner'});
  const ctx = authenticate(db,'studio-fixture','fixture:admin','cli','fullstack');
  await registerProviderAccount(engine,ctx,{provider:fake.name,externalAccountId:'https://www.linkedin.com/in/fixture-owner/',sender:{name:'Fixture owner',address:'fixture@example.invalid'},purposes:['social_publishing'],secretRef:'env:FIXTURE_SOCIAL',executionPlacement:'daytona-browser'});
  const token = createApiToken(engine,ctx,{principalId:ctx.principalId,name:'Private fixture bridge',roleCeiling:'admin',ttlDays:1}).token;
  const upstream = await startServer(createApp({engine}),{port:0});
  vi.stubEnv('OUTREACH_CONNECTION_FILE',''); vi.stubEnv('OUTREACH_API_URL',upstream.url); vi.stubEnv('OUTREACH_API_TOKEN',token); vi.stubEnv('OUTREACH_PREVIEW_TOKEN','');
  const preview = createPublishingPreview(); preview.listen(0,'127.0.0.1'); await once(preview,'listening');
  const url = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  const executablePath=process.env.OUTREACH_TEST_CHROME;
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),timeout:90000});
  try {
    const page=await browser.newPage(); page.setDefaultTimeout(45000); const errors:string[]=[]; const browserRequests:string[]=[];
    page.on('pageerror',e=>errors.push(e.message)); page.on('request',r=>browserRequests.push(r.url()+' '+(r.postData()??'')+' '+JSON.stringify(r.headers())));
    await page.goto(url); await expect.poll(()=>page.locator('#runtime-state').textContent(),{timeout:90000}).toBe('Workspace connected');
    await page.getByRole('button',{name:'Create a post',exact:true}).click();
    await page.getByLabel('Working title',{exact:true}).fill('Fixture image post'); await page.getByLabel('Caption',{exact:true}).fill('A real upload saved through the full local stack.');
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXuoAAAAASUVORK5CYII=','base64');
    await page.locator('dialog[open] input[type=file]').setInputFiles({name:'fixture-image.png',mimeType:'image/png',buffer:png});
    await expect.poll(()=>db.prepare('SELECT COUNT(*) n FROM publishing_media').get<{n:number}>()!.n,{timeout:45000}).toBe(1);
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await expect.poll(()=>db.prepare('SELECT COUNT(*) n FROM publishing_drafts').get<{n:number}>()!.n).toBe(1);
    await page.reload(); await expect.poll(()=>page.locator('#runtime-state').textContent()).toBe('Workspace connected');
    await page.getByRole('button',{name:'Create',exact:true}).click(); await page.getByRole('button',{name:/^Drafts/}).click(); await page.getByRole('button',{name:'Edit draft',exact:true}).click();
    expect(await page.getByLabel('Caption',{exact:true}).inputValue()).toBe('A real upload saved through the full local stack.');
    await expect.poll(()=>page.locator('dialog[open] img').evaluateAll(nodes=>nodes.some(n=>{const img=n as unknown as {complete:boolean;naturalWidth:number};return img.complete&&img.naturalWidth>0;})),{timeout:45000}).toBe(true);
    await page.getByRole('button',{name:'Review & schedule',exact:true}).click(); await page.getByRole('button',{name:'Submit for approval',exact:true}).click();
    await expect.poll(()=>db.prepare("SELECT COUNT(*) n FROM scheduled_actions WHERE state='awaiting_approval'").get<{n:number}>()!.n).toBe(1);
    const action=db.prepare('SELECT content_hash,payload FROM scheduled_actions').get<{content_hash:string;payload:string}>()!;
    const approval=db.prepare('SELECT operation_hash,decision FROM approvals WHERE id IN (SELECT id FROM plan_authorizations)').get<{operation_hash:string;decision:string}>()!;
    expect(approval.operation_hash).toBe(db.prepare('SELECT manifest_hash FROM plan_authorizations').get<{manifest_hash:string}>()!.manifest_hash); expect(approval.operation_hash).not.toBe(action.content_hash); expect(approval.decision).toBe('pending'); expect(action.payload).toContain('outreach-media://');
    await page.getByRole('button',{name:'Approve this exact plan',exact:true}).click();
    await expect.poll(()=>db.prepare('SELECT decision FROM approvals WHERE id IN (SELECT id FROM plan_authorizations)').get<{decision:string}>()!.decision).toBe('approved');
    expect(fake.publishCalls).toBe(0); expect(errors).toEqual([]); expect(browserRequests.join('\n')).not.toContain(token); expect(await page.content()).not.toContain(token);
    const single=await browser.newPage(); const executableAssets:string[]=[]; single.on('request',r=>{if(['script','stylesheet'].includes(r.resourceType()))executableAssets.push(r.url());});
    await single.goto(url+'/standalone.html'); await expect.poll(()=>single.locator('#runtime-state').textContent()).toBe('Workspace connected'); expect(executableAssets).toEqual([]); expect(await single.content()).not.toContain(token);
  } finally {
    await browser.close(); await new Promise<void>(resolve=>preview.close(()=>resolve())); await new Promise<void>(resolve=>upstream.server.close(()=>resolve())); db.close(); vi.unstubAllEnvs(); rmSync(dir,{recursive:true,force:true});
  }
},180000);
