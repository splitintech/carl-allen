import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, bootstrapWorkspace, authenticate, createApiToken, addPrincipal, registerProviderAccount, storeWorkPackage, repairWorkPackage, prepareWorkPackage } from '@splitin/outreach-core';
import { FakeEmailProvider, FAKE_EMAIL_SECRET, staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { createApp } from './app';
describe('independent reply-playbook review API',()=>{
 let f:Awaited<ReturnType<typeof fixture>>;
 async function fixture(){
  const db=openSqliteDatabase(':memory:');const fake=new FakeEmailProvider();const engine=createEngine({db,adapters:[fake.adapter()],secrets:staticSecrets({'env:EMAIL':FAKE_EMAIL_SECRET}),workerId:'reply-api',sendGate:{mode:'open'}});
  bootstrapWorkspace(db,{workspaceId:'ws',name:'Replies',adminRef:'admin',adminName:'Admin'});const admin=authenticate(db,'ws','admin','test','t');const tokens:Record<string,string>={};
  for(const role of ['viewer','operator','approver'] as const){const principalId=addPrincipal(engine,admin,{externalRef:'api-'+role,displayName:role,roles:[role]});tokens[role]=createApiToken(engine,admin,{principalId,name:role,roleCeiling:role,ttlDays:1}).token;}
  bootstrapWorkspace(db,{workspaceId:'other',name:'Other',adminRef:'other',adminName:'Other'});const other=authenticate(db,'other','other','test','t');tokens.other=createApiToken(engine,other,{principalId:other.principalId,name:'other',roleCeiling:'admin',ttlDays:1}).token;
  const accountId=await registerProviderAccount(engine,admin,{provider:'fake-email',externalAccountId:'owner@example.org',sender:{name:'Owner',address:'owner@example.org'},purposes:['automated_outreach'],secretRef:'env:EMAIL'});
  const manifest={schemaVersion:1 as const,packageId:'api-replies',revision:1,name:'Monthly plan',timezone:'UTC',accountRefs:[{id:'mail',channel:'email' as const,label:'Mailbox'}],contacts:[],media:[],publishingPlans:[],outreachSequences:[],replyPlaybooks:[{id:'pricing',accountRef:'mail',channel:'email' as const,contains:'pricing',text:'Exact reviewed response',subject:'Pricing',validUntil:new Date(Date.now()+7*86400000).toISOString(),maxResponsesPerContact:1,minGapHours:24}]};
  const pkg=storeWorkPackage(engine,admin,{name:manifest.name,html:'<html>fixture</html>',sourceHash:'api-fixture',manifest,issues:[]});repairWorkPackage(engine,admin,pkg.id,{accountMap:{mail:accountId}});const parent=prepareWorkPackage(engine,admin,pkg.id);
  const book=db.prepare('SELECT id,authorization_id FROM reply_playbooks').get<{id:string;authorization_id:string}>()!;const hash=db.prepare('SELECT operation_hash FROM approvals WHERE id=?').get<{operation_hash:string}>(book.authorization_id)!.operation_hash;const app=createApp({engine});
  const request=(path:string,method='GET',body?:unknown,role='approver')=>app.request(path,{method,headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{db,engine,fake,parent,book,hash,request,path:'/v1/reply-playbooks/'+book.id};
 }
 beforeEach(async()=>{f=await fixture();});afterEach(()=>{f.db.close();});
 it('lists only this workspace and exposes pending review independently from the approved parent',async()=>{
  expect((await f.request('/v1/plan-authorizations/'+f.parent.authorizationId+'/approve','POST',{operationHash:f.parent.operationHash})).status).toBe(200);
  const listed=await f.request('/v1/reply-playbooks','GET',undefined,'viewer');expect(listed.status).toBe(200);expect(await listed.json()).toMatchObject({playbooks:[{id:f.book.id,status:'pending',enabled:false,canDecide:true,rule:{contains:'pricing',maxResponsesPerContact:1,minGapHours:24}}]});
  expect(await(await f.request('/v1/reply-playbooks','GET',undefined,'other')).json()).toMatchObject({playbooks:[]});expect((await f.request(f.path,'GET',undefined,'other')).status).toBe(404);
 });
 it('enforces approver, hash and reason before approval and supports separate revocation',async()=>{
  const input={operationHash:f.hash,decision:'approved',reason:'Reviewed account, response and limits'};
  expect((await f.request(f.path+'/decide','POST',input,'operator')).status).toBe(403);expect((await f.request(f.path+'/decide','POST',{...input,operationHash:'0'.repeat(64)})).status).toBe(409);expect((await f.request(f.path+'/decide','POST',{...input,reason:''})).status).toBe(400);
  const approved=await f.request(f.path+'/decide','POST',input);expect(approved.status).toBe(200);expect(await approved.json()).toMatchObject({playbook:{status:'approved',enabled:true}});expect(f.db.prepare('SELECT decision FROM approvals WHERE id=?').get(f.parent.authorizationId)).toEqual({decision:'pending'});
  const revoked=await f.request(f.path+'/revoke','POST',{reason:'Pause automated replies'});expect(revoked.status).toBe(200);expect(await revoked.json()).toMatchObject({playbook:{status:'revoked',enabled:false}});expect(f.fake.sendCalls).toBe(0);
 });
 it('rejects only the reply rule and persists its reason',async()=>{
  const result=await f.request(f.path+'/decide','POST',{operationHash:f.hash,decision:'rejected',reason:'Response needs revision'});expect(result.status).toBe(200);expect(await result.json()).toMatchObject({playbook:{status:'rejected',enabled:false,reason:'Response needs revision'}});expect(f.db.prepare('SELECT decision FROM approvals WHERE id=?').get(f.parent.authorizationId)).toEqual({decision:'pending'});
 });
});
