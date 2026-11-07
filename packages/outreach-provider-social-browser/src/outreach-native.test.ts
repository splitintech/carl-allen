import { afterEach,describe,it,expect } from 'vitest';
import { chromium,type Browser } from 'playwright';
import type { ProviderContext } from '@splitin/outreach-contracts';
import { instagramThreads,readConversations } from './conversations';
import { publicationUrl } from './comments';
import { withLoginConnection } from './pool';
import { instagramMessage } from './instagram-message';
import { socialComment } from './comments';
import { linkedInPublish } from './linkedin';
import { createSocialSession } from './session';
const ctx:ProviderContext={workspaceId:'ws',account:{id:'ig',provider:'social-browser',externalAccountId:'owner',sender:{name:'Owner',address:'owner@example.invalid'}},secretRef:'env:FIXTURE',secrets:{get:async()=>''},traceId:'fixture',signal:AbortSignal.timeout(120000),now:()=>1700000000000};
const binding={expectedProfileUrl:'https://www.instagram.com/owner/'};
describe('native outreach receipts and profile isolation',()=>{
 it('extracts only a single verified Instagram peer and native messages',()=>{expect(instagramThreads({inbox:{threads:[{thread_id:'42',users:[{pk:'7',username:'peer'}],items:[{item_id:'12345678',user_id:'7',timestamp:1700000000000000,text:'Reply'}]}]}},'owner')).toEqual([{threadId:'42',peerUrl:'https://www.instagram.com/peer/',messages:[{id:'12345678',text:'Reply',inbound:true,at:1700000000000}],updatedAt:1700000000000}]);expect(instagramThreads({threads:[{thread_id:'group',users:[{pk:1,username:'a'},{pk:2,username:'b'}],items:[]}]},'owner')).toEqual([]);});
 it('refuses arbitrary comment destinations before opening Chrome',()=>{expect(()=>publicationUrl('instagram','https://evil.test/p/123/')).toThrow();expect(()=>publicationUrl('linkedin','https://www.linkedin.com/in/peer/')).toThrow();expect(publicationUrl('instagram','https://www.instagram.com/p/abc/')).toContain('/p/abc/');});
 it('serializes two targets sharing one login connection',async()=>{let active=0,max=0;const run=()=>withLoginConnection({kind:'fixture',sandboxId:'fixture'},ctx,{...binding,connectionId:'login'},async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;});await Promise.all([run(),run()]);expect(max).toBe(1);});
});
let browser:Browser|undefined;afterEach(async()=>{await browser?.close();browser=undefined;});
const suite=process.env.OUTREACH_BROWSER_FIXTURES==='1'?describe:describe.skip;
suite('real Chromium reviewed browser outreach',()=>{
 async function setup({wrongPeer=false,uncertain=false,pageActor=false,wrongActor=false}={}){
  browser=await chromium.launch({headless:true,...(process.env.OUTREACH_TEST_CHROME?{executablePath:process.env.OUTREACH_TEST_CHROME}:{})});const context=await browser.newContext();let effects=0;
  const owner='https://www.instagram.com/owner/';const peer=`https://www.instagram.com/${wrongPeer?'other':'peer'}/`;
  await context.route('http://127.0.0.1:43219/**',async route=>{const path=new URL(route.request().url()).pathname;let body='';
   if(path==='/'){body=`<nav><a aria-label="Profile" href="${owner}">Owner</a></nav>`;}
   else if(path==='/peer/'){body='<button onclick="location.href=\'/direct/t/42/\'">Message</button>';}
   else if(path==='/direct/inbox/')body='<a href="/direct/t/42/">Conversation</a>';
   else if(path.startsWith('/direct/'))body=`<header><a href="${peer}">Peer</a></header><div data-thread-id="42"><div data-message-id="old" data-sender-profile-url="${peer}" data-timestamp="1700000000000"><span data-message-text>Incoming</span></div></div><div role="textbox" contenteditable="true"></div><button onclick="fetch('/effect',{method:'POST'});${uncertain?'':`let n=document.createElement('div');n.dataset.messageId='123456789';n.textContent=document.querySelector('[role=textbox]').textContent;document.body.append(n);`}">Send</button>`;
   else if(path==='/p/abc/')body=`<article><header><a href="${owner}">Owner</a></header></article><textarea aria-label="Add a comment"></textarea><button onclick="fetch('/effect',{method:'POST'});let n=document.createElement('div');n.dataset.commentId='comment-111';n.textContent=document.querySelector('textarea').value;document.body.append(n)">Post</button>`;
   else if(path==='/feed/'||path.includes('/company/'))body=`<a data-view-name="identity-module" href="https://www.linkedin.com/in/owner/">Owner</a><button onclick="document.getElementById('actor').hidden=false">Start a post</button><a id="actor" data-publishing-identity="https://www.linkedin.com/company/${wrongActor?'other':'brand'}/" hidden>Brand</a><div class="ql-editor" contenteditable="true"></div><button class="share-actions__primary-action" onclick="fetch('/effect',{method:'POST'});let n=document.createElement('article');n.dataset.urn='urn:li:activity:1234';n.innerHTML='<a href=https://www.linkedin.com/company/brand/>Brand</a>'+document.querySelector('.ql-editor').textContent;document.body.append(n)">Post</button>`;
   if(path==='/effect'){effects++;await route.fulfill({status:200,contentType:'application/json',body:'{}'});return;}
   await route.fulfill({status:200,contentType:'text/html',body:`<!doctype html>${body}`});
  });
  const session=createSocialSession({pageFactory:()=>context.newPage()});return{session,effects:()=>effects,options:{origin:'http://127.0.0.1:43219',confirmationTimeoutMs:400},binding:pageActor?{expectedProfileUrl:'https://www.linkedin.com/in/owner/',loginProfileUrl:'https://www.linkedin.com/in/owner/',publishingProfileUrl:'https://www.linkedin.com/company/brand/'}:binding};
 }
 it('sends an Instagram DM only after matching peer and new native receipt',async()=>{const f=await setup();expect(await instagramMessage(f.session,ctx,f.binding,f.options,{actionId:'1',idempotencyKey:'1',channel:'instagram',targetUrl:'https://www.instagram.com/peer/',text:'Approved'})).toMatchObject({kind:'accepted',receipt:{providerMessageId:'123456789'}});expect(f.effects()).toBe(1);});
 it('holds a wrong Instagram conversation before Send',async()=>{const f=await setup({wrongPeer:true});expect(await instagramMessage(f.session,ctx,f.binding,f.options,{actionId:'1',idempotencyKey:'1',channel:'instagram',targetUrl:'https://www.instagram.com/peer/',text:'Approved'})).toMatchObject({kind:'rejected'});expect(f.effects()).toBe(0);});
 it('keeps a possible Instagram send uncertain rather than repeatable success',async()=>{const f=await setup({uncertain:true});expect(await instagramMessage(f.session,ctx,f.binding,f.options,{actionId:'1',idempotencyKey:'1',channel:'instagram',targetUrl:'https://www.instagram.com/peer/',text:'Approved'})).toMatchObject({kind:'unknown'});expect(f.effects()).toBe(1);});
 it('reads native Instagram conversation IDs without causing a send',async()=>{const f=await setup();const result=await readConversations(f.session,ctx,f.binding,'instagram',f.options);expect(result.threads[0]).toMatchObject({threadId:'42',peerUrl:'https://www.instagram.com/peer/',messages:[{id:'old',text:'Incoming',inbound:true,at:1700000000000}]});expect(f.effects()).toBe(0);});
 it('adds a first comment with an independent native receipt to an owned post',async()=>{const f=await setup();expect(await socialComment(f.session,ctx,f.binding,f.options,{actionId:'c',idempotencyKey:'c',channel:'instagram',targetUrl:'https://www.instagram.com/p/abc/',text:'Approved comment'})).toMatchObject({kind:'accepted',receipt:{providerMessageId:'comment-111'}});expect(f.effects()).toBe(1);});
 it('publishes as a verified LinkedIn company actor and receipt author',async()=>{const f=await setup({pageActor:true});expect(await linkedInPublish(f.session,ctx,f.binding,f.options,{actionId:'p',idempotencyKey:'p',channel:'linkedin',text:'Company post'})).toMatchObject({kind:'accepted',receipt:{providerMessageId:'urn:li:activity:1234'}});expect(f.effects()).toBe(1);});
 it('blocks a composer that silently switched the company identity',async()=>{const f=await setup({pageActor:true,wrongActor:true});expect(await linkedInPublish(f.session,ctx,f.binding,f.options,{actionId:'p',idempotencyKey:'p',channel:'linkedin',text:'Company post'})).toMatchObject({kind:'rejected'});expect(f.effects()).toBe(0);});
});
