import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser,type BrowserContext} from 'playwright';
import type {ProviderContext} from '@splitin/outreach-contracts';
import {inspectSignedInPage} from './login-inspection';
import {qualifyPublishing} from './publishing-qualification';
import {createSocialSession} from './session';
import type {AccountBinding} from './runtime';
import {createHash} from 'node:crypto';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {syntheticVideoBytes} from './video.test-util';
const enabled=process.env.OUTREACH_BROWSER_FIXTURES==='1';const origin='http://127.0.0.1:5199';let browser:Browser;let context:BrowserContext;
const ctx:ProviderContext={workspaceId:'ws',account:{id:'a',provider:'social-browser',externalAccountId:'owner',sender:{name:'Owner',address:'owner@example.invalid'}},secretRef:'env:FIXTURE',secrets:{get:async()=>''},traceId:'qualification',signal:AbortSignal.timeout(120000),now:()=>1000};
describe.skipIf(!enabled)('native login and per-target qualification',()=>{
 beforeAll(async()=>{browser=await chromium.launch({headless:true,...(process.env.OUTREACH_TEST_CHROME?{executablePath:process.env.OUTREACH_TEST_CHROME}:{}),args:['--no-sandbox']});context=await browser.newContext();});
 afterAll(async()=>{await browser?.close();});
 it('discovers the signed-in navigation identity and ignores arbitrary profile links',async()=>{
  const page=await context.newPage();await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<a href="https://www.linkedin.com/in/attacker/">An arbitrary profile</a>'}));await page.goto(origin+'/feed/');expect(await inspectSignedInPage(page,'linkedin',origin)).toBeNull();
  await page.setContent('<div class="profile-card"><a href="https://www.linkedin.com/in/owner/">Owner</a></div>');expect(await inspectSignedInPage(page,'linkedin',origin)).toEqual({channel:'linkedin',name:'Owner',profileUrl:'https://www.linkedin.com/in/owner/'});await page.close();
 },60000);
 it('checks the company composer actor before exposing organization formats',async()=>{
  let wrong=false,posts=0;const binding:AccountBinding={kind:'linkedin',expectedProfileUrl:'https://www.linkedin.com/in/owner/',loginProfileUrl:'https://www.linkedin.com/in/owner/',publishingProfileUrl:'https://www.linkedin.com/company/team/'};
  const pageFactory=async()=>{const page=await context.newPage();await page.route(origin+'/**',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({contentType:'text/html',body:`<div class="profile-card"><a href="https://www.linkedin.com/in/owner/">Owner</a></div><button class="share-box-feed-entry__trigger">Start a post</button><a data-publishing-identity="https://www.linkedin.com/company/${wrong?'other':'team'}/"></a><div class="ql-editor" contenteditable="true"></div><input type="file" accept="image/jpeg,video/mp4" multiple><button aria-label="Video">Video</button>`});});return page;};
  const session=createSocialSession({pageFactory});const qualified=await qualifyPublishing(session,ctx,binding,{origin,confirmationTimeoutMs:1000});expect(qualified).toMatchObject({identity:binding.publishingProfileUrl,accountType:'organization',formats:['feed','carousel','video']});wrong=true;expect((await qualifyPublishing(session,ctx,binding,{origin,confirmationTimeoutMs:1000})).formats).toEqual([]);expect(posts).toBe(0);await session.close();
 });
 it('requires an observed Instagram professional account and explicit native reel confirmation',async()=>{
  let professional=false,reels=false;const binding:AccountBinding={kind:'instagram',expectedProfileUrl:'https://www.instagram.com/owner/'};
  const session=createSocialSession({pageFactory:async()=>{const page=await context.newPage();await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('professional_account_settings')?professional?'Business tools and controls':'Account settings':`<a aria-label="Profile" href="https://www.instagram.com/owner/">Owner</a><button>Create</button><input type="file" accept="image/jpeg,video/mp4" multiple>${reels?'<p>New reel</p>':''}`}));return page;}});
  expect((await qualifyPublishing(session,ctx,binding,{origin})).formats).toEqual([]);professional=true;expect((await qualifyPublishing(session,ctx,binding,{origin})).formats).toEqual(['feed','carousel']);reels=true;expect((await qualifyPublishing(session,ctx,binding,{origin})).formats).toEqual(['feed','carousel','video','reel']);await session.close();
 });
 it('blocks a signed-in identity mismatch before capability discovery',async()=>{
  const session=createSocialSession({pageFactory:async()=>{const page=await context.newPage();await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<a data-testid="AppTabBar_Profile_Link" href="https://x.com/other/">Other</a><div data-testid="tweetTextarea_0"></div>'}));return page;}});
  await expect(qualifyPublishing(session,ctx,{kind:'x',expectedProfileUrl:'https://x.com/owner/'},{origin,confirmationTimeoutMs:1000})).rejects.toThrow('does not match');await session.close();
 });
 it('qualifies a reel using selected immutable MP4 bytes without ever clicking Share',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'qualification-media-'));const bytes=syntheticVideoBytes(),hash=createHash('sha256').update(bytes).digest('hex');const workspace=join(directory,createHash('sha256').update('ws').digest('hex').slice(0,24));mkdirSync(workspace,{mode:0o700});writeFileSync(join(workspace,hash),bytes,{mode:0o600});let shareClicks=0;const errors:string[]=[];
  const session=createSocialSession({pageFactory:async()=>{const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.exposeFunction('shared',()=>{shareClicks++;});await page.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('professional_account_settings')?'Creator tools and controls':`<a aria-label="Profile" href="https://www.instagram.com/owner/">Owner</a><button>Create</button><div role="dialog"><input type="file" accept="video/mp4" onchange="const video=document.createElement('video');video.src=window.URL.createObjectURL(this.files[0]);this.parentElement.append(video);const label=document.createElement('p');label.textContent='New reel';this.parentElement.append(label)"><textarea aria-label="Caption"></textarea><button onclick="shared()">Share</button></div>`}));return page;}});
  try{const qualified=await qualifyPublishing(session,ctx,{kind:'instagram',expectedProfileUrl:'https://www.instagram.com/owner/'},{origin,confirmationTimeoutMs:2000,media:{allowedOrigins:[],assetDirectory:directory}},{format:'reel',mediaUrls:['outreach-media://'+hash]});expect(qualified.formats).toContain('reel');expect(qualified.accountType).toBe('creator');expect(shareClicks).toBe(0);}finally{await session.close();rmSync(directory,{recursive:true,force:true});expect(errors).toEqual([]);}
 },60000);
});
