import { afterEach, describe, expect, it } from 'vitest';
import { WorkPackageManifest, sha256Hex } from '@splitin/outreach-contracts';
import { makeDomainEnv } from './domain.test-util';
import { registerProviderAccount } from './operations';
import { storeWorkPackage, repairWorkPackage, getWorkPackage } from './work-packages';
import { prepareWorkPackage } from './work-package-prepare';
import { decideApproval } from './approvals';
import { savePublishingDraft, submitPublishingDraft } from './publishing-drafts';
import { ingestConversation } from './inbox-sync';
import { loadAccount } from '../execution/actions-repo';
import { setKillSwitchAs } from '../engine';
import { listPeople } from './outreach-workspace';
const open: Awaited<ReturnType<typeof makeDomainEnv>>[]=[];
afterEach(()=>{for(const e of open.splice(0))e.engine.db.close();});
async function fixture(){
 const e=await makeDomainEnv();open.push(e);
 const add=(externalAccountId:string)=>registerProviderAccount(e.engine,e.admin,{provider:'fake-social',externalAccountId,sender:{name:externalAccountId,address:'owner@example.invalid'},purposes:['social_publishing','social_messaging'],secretRef:'env:FAKE_SOCIAL',executionPlacement:'daytona-browser'});
 return {e,first:await add('first-owner'),second:await add('second-owner')};
}
function manifest(now:number){
 return WorkPackageManifest.parse({schemaVersion:1,packageId:'november',revision:1,name:'Month',accountRefs:[{id:'a',channel:'linkedin',label:'First'},{id:'b',channel:'linkedin',label:'Second'}],publishingPlans:[{id:'day20',accountRef:'a',channel:'linkedin',text:'First account content',scheduledFor:new Date(now+20*86400000).toISOString()},{id:'day31',accountRef:'b',channel:'linkedin',text:'Second account content',scheduledFor:new Date(now+31*86400000).toISOString()}]});
}
function store(e:Awaited<ReturnType<typeof makeDomainEnv>>,m:ReturnType<typeof manifest>){
 const html='<html>fixture '+m.packageId+' '+m.revision+'</html>';
 return storeWorkPackage(e.engine,e.operator,{name:m.name,html,manifest:m,issues:[],sourceHash:sha256Hex(html)});
}
describe('HTML work-package durable execution',()=>{
 it('requires canonical sourced profile repair before outreach, then stops linked email on a native reply',async()=>{
  const {e,first}=await fixture();const m=manifest(e.now());m.publishingPlans=[];m.accountRefs=[{id:'a',channel:'linkedin',label:'Social'},{id:'mail',channel:'email',label:'Mailbox'}];m.contacts=[{id:'peer',name:'Ada Peer',linkedin:'https://linkedin.com/in/peer/?trk=research',email:'peer@example.org',sources:['https://example.org/research'],notes:'Sourced profile',consentBasis:'legitimate_interest',jurisdiction:'US'}];m.outreachSequences=[{id:'sequence',name:'Coordinated outreach',contacts:['peer'],scheduledFor:new Date(e.now()+3600000).toISOString(),steps:[{id:'social',accountRef:'a',channel:'linkedin',kind:'message',text:'Hello {{first_name}}',waitHours:0,waitFor:'elapsed'},{id:'email',accountRef:'mail',channel:'email',kind:'email',text:'Following up {{first_name}}',subject:'Reviewed follow-up',waitHours:24,waitFor:'elapsed'}]}];const p=store(e,m);repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first,mail:e.accountId}});const blocked=prepareWorkPackage(e.engine,e.operator,p.id);expect(blocked.preview.issues.some(i=>i.message.includes('canonical'))).toBe(true);expect(e.engine.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({n:0});
  m.contacts[0]!.linkedin='https://www.linkedin.com/in/peer/';repairWorkPackage(e.engine,e.operator,p.id,{manifest:m});const plan=prepareWorkPackage(e.engine,e.operator,p.id);expect(plan.preview.issues).toEqual([]);decideApproval(e.engine,e.approver,{approvalId:plan.authorizationId!,operationHash:plan.operationHash!,decision:'approved'});e.advance(1000);ingestConversation(e.engine,loadAccount(e.engine.db,first)!,{threadId:'native-peer-thread',peerUrl:'https://www.linkedin.com/in/peer/',messages:[{id:'native-incoming',text:'Thanks, I replied here.',inbound:true,at:e.now()}],updatedAt:e.now()});expect(e.engine.db.prepare('SELECT state FROM outreach_sequences').get()).toEqual({state:'stopped'});expect(e.engine.db.prepare('SELECT state FROM scheduled_actions').all()).toEqual([{state:'cancelled'},{state:'cancelled'}]);expect(e.fake.sendCalls).toBe(0);
 });

 it('requires explicit account repair, then approves once and executes different accounts on days 20 and 31',async()=>{
  const {e,first,second}=await fixture();const now=e.now();const p=store(e,manifest(now));
  const missing=prepareWorkPackage(e.engine,e.operator,p.id);expect(missing.authorizationId).toBeNull();expect(missing.preview.issues.length).toBeGreaterThan(0);expect(e.social.publishCalls).toBe(0);
  repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first,b:second}});
  const ready=prepareWorkPackage(e.engine,e.operator,p.id);expect(ready.authorizationId).toBeTruthy();
  const ctx={...e.approver,source:'http' as const};
  decideApproval(e.engine,ctx,{approvalId:ready.authorizationId!,operationHash:ready.operationHash!,decision:'approved'});
  e.setNow(now+20*86400000);await e.engine.runOnce();expect(e.social.deliveries.map(d=>d.text)).toEqual(['First account content']);
  e.setNow(now+31*86400000);await e.engine.runOnce();expect(e.social.deliveries.map(d=>d.text)).toEqual(['First account content','Second account content']);
  expect(e.engine.db.prepare('SELECT provider_account_id,state FROM scheduled_actions ORDER BY due_at').all()).toEqual([{provider_account_id:first,state:'succeeded'},{provider_account_id:second,state:'succeeded'}]);
 });
 it('renews an expired unattempted review with fresh action identities instead of returning the expired authorization',async()=>{const{e,first,second}=await fixture();const p=store(e,manifest(e.now()));repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first,b:second}});const original=prepareWorkPackage(e.engine,e.operator,p.id);const originalIds=e.engine.db.prepare('SELECT id FROM scheduled_actions').all<{id:string}>().map(a=>a.id);e.advance(73*3600000);const refreshed=prepareWorkPackage(e.engine,e.operator,p.id);expect(refreshed.authorizationId).not.toBe(original.authorizationId);expect(e.engine.db.prepare('SELECT decision FROM approvals WHERE id=?').get(original.authorizationId)).toEqual({decision:'revoked'});for(const id of originalIds)expect(e.engine.db.prepare('SELECT state FROM scheduled_actions WHERE id=?').get(id)).toEqual({state:'cancelled'});decideApproval(e.engine,e.approver,{approvalId:refreshed.authorizationId!,operationHash:refreshed.operationHash!,decision:'approved'});expect(e.engine.db.prepare("SELECT COUNT(*) n FROM scheduled_actions WHERE state='scheduled'").get()).toEqual({n:2});expect(prepareWorkPackage(e.engine,e.operator,p.id).authorizationId).toBe(refreshed.authorizationId);});
 it('keeps legacy decision TTL and refuses MCP approval even for a token with admin privileges',async()=>{
  const {e,first,second}=await fixture();const p=store(e,manifest(e.now()));repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first,b:second}});
  const plan=prepareWorkPackage(e.engine,e.operator,p.id);
  expect(()=>decideApproval(e.engine,{...e.admin,source:'mcp'},{approvalId:plan.authorizationId!,operationHash:plan.operationHash!,decision:'approved'})).toThrow(/review screen/);
  e.advance(73*3600000);
  expect(()=>decideApproval(e.engine,e.approver,{approvalId:plan.authorizationId!,operationHash:plan.operationHash!,decision:'approved'})).toThrow(/expired/);
  expect(e.social.publishCalls).toBe(0);
 });
 it('invalidates approved future work when account/content mappings are repaired',async()=>{
  const {e,first,second}=await fixture();const p=store(e,manifest(e.now()));repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first,b:second}});
  const plan=prepareWorkPackage(e.engine,e.operator,p.id);
  decideApproval(e.engine,e.approver,{approvalId:plan.authorizationId!,operationHash:plan.operationHash!,decision:'approved'});
  const m=manifest(e.now());m.publishingPlans[0]!.text='Changed content';
  repairWorkPackage(e.engine,e.operator,p.id,{manifest:m});
  expect(e.engine.db.prepare('SELECT decision FROM approvals WHERE id=?').get(plan.authorizationId)).toEqual({decision:'revoked'});
  expect(e.engine.db.prepare("SELECT COUNT(*) n FROM scheduled_actions WHERE state='cancelled'").get()).toEqual({n:2});
  expect(getWorkPackage(e.engine,e.operator,p.id).authorizationId).toBeNull();
 });
 it('is idempotent on exact imported bytes and rejects conflicting bytes at the same external revision',async()=>{
  const {e}=await fixture();const m=manifest(e.now());const a=store(e,m);expect(store(e,m).id).toBe(a.id);
  expect(()=>storeWorkPackage(e.engine,e.operator,{name:'Changed',html:'different',sourceHash:sha256Hex('different'),manifest:m,issues:[]})).toThrow(/revision/);
  expect(()=>getWorkPackage(e.engine,{...e.viewer,workspaceId:'foreign'},a.id)).toThrow(/not found/);
 });
 it('routes a missed publishing slot to review, and a kill switch prevents effects',async()=>{
  const {e,first,second}=await fixture();const now=e.now();const p=store(e,manifest(now));repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first,b:second}});const plan=prepareWorkPackage(e.engine,e.operator,p.id);
  decideApproval(e.engine,e.approver,{approvalId:plan.authorizationId!,operationHash:plan.operationHash!,decision:'approved'});
  e.setNow(now+20*86400000+2*3600000);await e.engine.runOnce();expect(e.social.publishCalls).toBe(0);
  expect(e.engine.db.prepare('SELECT state,state_reason FROM scheduled_actions ORDER BY due_at LIMIT 1').get()).toEqual({state:'review',state_reason:'missed_publishing_slot'});
  setKillSwitchAs(e.engine,e.operator,{scope:'workspace',engaged:true,reason:'Fixture hold'});e.setNow(now+31*86400000);await e.engine.runOnce();expect(e.social.publishCalls).toBe(0);
 });
 it('supports repeated platforms in the Studio with stable target IDs and one long-lived plan approval',async()=>{
  const {e,first,second}=await fixture();const now=e.now();
  const draft=savePublishingDraft(e.engine,e.operator,{name:'Two LinkedIn accounts',timezone:'UTC',scheduledFor:new Date(now+31*86400000).toISOString(),posts:[{targetId:'a',channel:'linkedin',accountId:first,text:'A',mediaIds:[]},{targetId:'b',channel:'linkedin',accountId:second,text:'B',mediaIds:[]}]});
  const plan=submitPublishingDraft(e.engine,e.operator,draft.id);expect(plan.blocked).toEqual([]);expect(plan.actions).toHaveLength(2);expect(plan.authorizationId).toBeTruthy();
  decideApproval(e.engine,e.approver,{approvalId:plan.authorizationId!,operationHash:plan.operationHash!,decision:'approved'});
  e.setNow(now+31*86400000);await e.engine.runOnce();expect(e.social.publishCalls).toBe(2);
  expect(submitPublishingDraft(e.engine,e.operator,draft.id).authorizationId).toBe(plan.authorizationId);
 });
 it('rejects schedules outside 90 days and forecasts per-account daily cap conflicts before queueing',async()=>{
  const {e,first}=await fixture();const m=manifest(e.now());m.publishingPlans=Array.from({length:11},(_,i)=>({...m.publishingPlans[0]!,id:'p'+i,accountRef:'a'}));m.publishingPlans.push({...m.publishingPlans[0]!,id:'too-far',scheduledFor:new Date(e.now()+91*86400000).toISOString()});
  const p=store(e,m);repairWorkPackage(e.engine,e.operator,p.id,{accountMap:{a:first}});
  const result=prepareWorkPackage(e.engine,e.operator,p.id);expect(result.preview.issues.some(i=>i.message.includes('Daily'))).toBe(true);expect(result.preview.issues.some(i=>i.message.includes('90 days'))).toBe(true);expect(e.engine.db.prepare('SELECT COUNT(*) n FROM scheduled_actions').get()).toEqual({n:0});
 });
 it('does not merge conflicting contact identities and scopes people data to the authenticated workspace',async()=>{
  const {e}=await fixture();const contactId=e.contact('existing@example.org');
  expect(listPeople(e.engine,e.viewer).some(p=>p.id===contactId)).toBe(true);expect(listPeople(e.engine,{...e.viewer,workspaceId:'foreign'})).toEqual([]);
 });
});
