import { afterEach, describe, expect, it } from 'vitest';
import { digestCanonical, type WorkManifest } from '@splitin/outreach-contracts';
import { makeDomainEnv, type DomainTestEnv } from './domain.test-util';
import { decideApproval, revokeApproval } from './approvals';
import { listReplyPlaybooks, reviewReplyPlaybook, decideReplyPlaybook, revokeReplyPlaybook } from './reply-playbooks';
import { prepareWorkPackage } from './work-package-prepare';
import { storeWorkPackage, repairWorkPackage } from './work-packages';
import { ingestConversation } from './inbox-sync';
import { loadAccount } from '../execution/actions-repo';
import { setJurisdictionPolicy } from './jurisdictions';
import { setWorkspaceExecutionLimits } from './workspace-policy';
import type { ActionRow } from '../execution/types';
const opened:DomainTestEnv[]=[];afterEach(()=>{for(const f of opened.splice(0))f.engine.db.close();});
async function fixture(limits?:{accountPerDay:number;channelPerDay:number}) {
 const f=await makeDomainEnv();opened.push(f);f.contact('peer@example.com',{jurisdiction:'US',consentBasis:'consent'});
 if(limits)setWorkspaceExecutionLimits(f.engine,f.admin,limits);
 setJurisdictionPolicy(f.engine,f.admin,{rules:{US:'consent_required'},default:'block',unknown:'block'},{by:'Fixture owner',reference:'Reviewed reply correspondence'});
 const rule:WorkManifest['replyPlaybooks'][number]={id:'pricing',accountRef:'mail',channel:'email',contains:'pricing',text:'Exact separately approved response.',subject:'Pricing details',validUntil:new Date(f.now()+7*86400000).toISOString(),maxResponsesPerContact:1,minGapHours:24};
 const manifest:WorkManifest={schemaVersion:1,packageId:'reply-fixture',revision:1,name:'Monthly handoff',timezone:'UTC',accountRefs:[{id:'mail',channel:'email',label:'Mailbox'}],contacts:[],media:[],publishingPlans:[],outreachSequences:[],replyPlaybooks:[rule]};
 const pkg=storeWorkPackage(f.engine,f.operator,{name:manifest.name,html:'<html>fixture</html>',sourceHash:digestCanonical(manifest),manifest,issues:[]});
 repairWorkPackage(f.engine,f.operator,pkg.id,{accountMap:{mail:f.accountId}});const parent=prepareWorkPackage(f.engine,f.operator,pkg.id);expect(parent.authorizationId).toBeTruthy();
 const book=listReplyPlaybooks(f.engine,f.viewer)[0]!;const account=loadAccount(f.engine.db,f.accountId)!;
 const approveParent=()=>decideApproval(f.engine,f.approver,{approvalId:parent.authorizationId!,operationHash:parent.operationHash!,decision:'approved'});
 const approveChild=()=>decideReplyPlaybook(f.engine,f.approver,book.id,{operationHash:book.operationHash!,decision:'approved',reason:'Reviewed account, conditions and bounds'});
 const incoming=(id='incoming',peer='peer@example.com')=>({threadId:'thread-'+peer,peerUrl:'mailto:'+peer,subject:'Pricing question',messages:[{id,text:'Please send pricing',inbound:true,at:f.now()}],updatedAt:f.now()});
 const ingest=(id='incoming',peer='peer@example.com')=>{f.advance(1000);ingestConversation(f.engine,account,incoming(id,peer));};
 const fresh=()=>f.engine.db.prepare('INSERT INTO inbox_cursors(account_id,polled_at) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET polled_at=excluded.polled_at').run(account.id,f.now());
 const reply=()=>f.engine.db.prepare("SELECT * FROM scheduled_actions WHERE kind='email.reply' ORDER BY created_at LIMIT 1").get<ActionRow>();
 return {f,rule,manifest,pkg,parent,book,account,approveParent,approveChild,incoming,ingest,fresh,reply};
}
describe('independent frozen reply-playbook authorization',()=>{
 it('freezes lower workspace limits and preserves them after settings change across queued and sent replies',async()=>{
  const t=await fixture({accountPerDay:2,channelPerDay:2});expect(t.book.bounds).toMatchObject({accountPerDay:2,channelPerDay:2});t.approveChild();
  setWorkspaceExecutionLimits(t.f.engine,t.f.admin,{accountPerDay:5,channelPerDay:5});expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id)).toMatchObject({status:'approved',bounds:{accountPerDay:2,channelPerDay:2}});
  t.ingest();t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);
  for(const email of ['second@example.com','third@example.com']){t.f.contact(email,{jurisdiction:'US',consentBasis:'consent'});t.ingest(email,email);}
  const queued=t.f.engine.db.prepare("SELECT payload FROM scheduled_actions WHERE kind='email.reply' AND state='scheduled'").all<{payload:string}>();expect(queued).toHaveLength(2);for(const row of queued)expect(JSON.parse(row.payload)._policy.limits).toMatchObject({accountPerDay:2,channelPerDay:2});
  t.fresh();await t.f.drain();expect(t.f.fake.sendCalls).toBe(2);expect(t.f.engine.db.prepare("SELECT COUNT(*) n FROM scheduled_actions WHERE kind='email.reply' AND state='succeeded'").get()).toEqual({n:2});expect(t.f.engine.db.prepare("SELECT state,state_reason,due_at FROM scheduled_actions WHERE kind='email.reply' AND state='scheduled'").get()).toMatchObject({state:'scheduled',state_reason:expect.stringMatching(/^rate_limit:account:/),due_at:expect.any(Number)});
 });
 it('keeps the conservative reply ceiling when workspace limits are higher',async()=>{const t=await fixture({accountPerDay:30,channelPerDay:20});expect(t.book.bounds).toMatchObject({accountPerDay:10,channelPerDay:10});});
 it('keeps replies pending after parent approval and only sends once after separate rule approval',async()=>{
  const t=await fixture();t.approveParent();expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id)).toMatchObject({status:'pending',enabled:false,canDecide:true});
  t.ingest('while-pending');t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(0);expect(t.reply()).toBeUndefined();
  t.approveChild();t.ingest('after-approval');t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);expect(t.reply()).toMatchObject({state:'succeeded',approval_id:t.book.authorizationId});
  ingestConversation(t.f.engine,t.account,t.incoming('after-approval'));await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);expect(t.f.fake.deliveries[0]).toMatchObject({subject:t.rule.subject,headers:{'Auto-Submitted':'auto-replied'}});
 });
 it('does not approve or activate parent outreach when a reply rule alone is approved',async()=>{const t=await fixture();t.approveChild();expect(t.f.engine.db.prepare('SELECT decision FROM approvals WHERE id=?').get(t.parent.authorizationId)).toEqual({decision:'pending'});expect(t.f.engine.db.prepare('SELECT status FROM work_packages WHERE id=?').get(t.pkg.id)).toEqual({status:'awaiting_approval'});});
 it('never replies to a message received before the separate approval, even when first polled afterward',async()=>{const t=await fixture();t.approveParent();t.f.advance(3600000);const old=t.incoming('before-rule-approval');t.f.advance(3600000);t.approveChild();ingestConversation(t.f.engine,t.account,old);t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(0);t.ingest('new-after-approval');t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);});
 it('preserves approval across connection refresh timestamps and JSON key order changes',async()=>{const t=await fixture();t.approveChild();const row=t.f.engine.db.prepare('SELECT capabilities,sender_identity FROM provider_accounts WHERE id=?').get<{capabilities:string;sender_identity:string}>(t.f.accountId)!;const capabilities=Object.fromEntries(Object.entries(JSON.parse(row.capabilities)).reverse());t.f.engine.db.prepare('UPDATE provider_accounts SET capabilities=?,sender_identity=? WHERE id=?').run(JSON.stringify({...capabilities,discoveredAt:t.f.now()+1000}),JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(row.sender_identity)).reverse())),t.f.accountId);expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id).status).toBe('approved');t.ingest();t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);});
 it.each(['rule','cap','account','capability','account_map','expiry','revision'])('holds a generated reply if its frozen %s changes before execution',async field=>{
  const t=await fixture();t.approveParent();t.approveChild();t.ingest();t.fresh();expect(t.reply()?.state).toBe('scheduled');
  if(field==='rule'||field==='cap')t.f.engine.db.prepare('UPDATE reply_playbooks SET rules=? WHERE id=?').run(JSON.stringify({...t.rule,...(field==='rule'?{text:'Changed reply'}:{maxResponsesPerContact:3})}),t.book.id);
  if(field==='account')t.f.engine.db.prepare('UPDATE provider_accounts SET sender_identity=? WHERE id=?').run(JSON.stringify({name:'Different',address:'different@example.org'}),t.f.accountId);
  if(field==='capability'){const row=t.f.engine.db.prepare('SELECT capabilities FROM provider_accounts WHERE id=?').get<{capabilities:string}>(t.f.accountId)!;t.f.engine.db.prepare('UPDATE provider_accounts SET capabilities=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.capabilities),maxRecipientsPerMessage:50}),t.f.accountId);}
  if(field==='account_map')t.f.engine.db.prepare("UPDATE work_packages SET account_map='{}' WHERE id=?").run(t.pkg.id);
  if(field==='expiry')t.f.engine.db.prepare('UPDATE reply_playbooks SET valid_until=valid_until+86400000 WHERE id=?').run(t.book.id);
  if(field==='revision')t.f.engine.db.prepare('UPDATE work_packages SET revision=revision+1 WHERE id=?').run(t.pkg.id);
  await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(0);expect(t.reply()?.state).toBe('awaiting_approval');expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id).status).toBe('held');
 });
 it('expires the pending review after 72h without shortening separately approved execution validity',async()=>{
  const t=await fixture();t.approveParent();t.f.advance(73*3600000);expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id).status).toBe('expired');expect(()=>t.approveChild()).toThrow(/expired/);t.ingest();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(0);
 });
 it('continues an approved rule beyond its 72h decision deadline and holds after its execution expiry',async()=>{
  const t=await fixture();t.approveParent();t.approveChild();t.f.advance(73*3600000);t.ingest();t.fresh();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);t.f.advance(5*86400000);expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id).status).toBe('held');t.ingest('expired');await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(1);
 });
 it.each(['child','parent','revision','mapping'])('stops queued replies on %s revocation and preserves uncertain effects',async change=>{
  const t=await fixture();t.approveParent();t.approveChild();t.ingest();const uncertain=t.reply()!;t.f.engine.db.prepare("UPDATE scheduled_actions SET state='uncertain',attempt_count=1 WHERE id=?").run(uncertain.id);
  t.f.contact('second@example.com',{jurisdiction:'US',consentBasis:'consent'});t.ingest('second','second@example.com');const queued=t.f.engine.db.prepare("SELECT * FROM scheduled_actions WHERE kind='email.reply' AND state='scheduled'").get<ActionRow>()!;expect(queued).toBeTruthy();
  if(change==='child')revokeReplyPlaybook(t.f.engine,t.f.approver,t.book.id,'Stop this rule');
  if(change==='parent')revokeApproval(t.f.engine,t.f.approver,t.parent.authorizationId!,'Stop the parent plan');
  if(change==='revision')storeWorkPackage(t.f.engine,t.f.operator,{name:'New revision',html:'new',sourceHash:'new-hash',manifest:{...t.manifest,revision:2},issues:[]});
  if(change==='mapping'){t.f.engine.db.prepare("UPDATE scheduled_actions SET state='scheduled',attempt_count=0 WHERE id=?").run(uncertain.id);repairWorkPackage(t.f.engine,t.f.operator,t.pkg.id,{accountMap:{mail:t.f.accountId}});}
  expect(t.f.engine.db.prepare('SELECT state FROM scheduled_actions WHERE id=?').get(queued.id)).toEqual({state:'cancelled'});expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id)).toMatchObject({decision:'revoked',enabled:false});
  if(change!=='mapping')expect(t.f.engine.db.prepare('SELECT state FROM scheduled_actions WHERE id=?').get(uncertain.id)).toEqual({state:'uncertain'});
 });
 it('rejects rules independently and records the decision reason',async()=>{const t=await fixture();t.approveParent();const result=decideReplyPlaybook(t.f.engine,t.f.approver,t.book.id,{operationHash:t.book.operationHash!,decision:'rejected',reason:'Change the response limits'});expect(result).toMatchObject({status:'rejected',enabled:false});expect(t.f.engine.db.prepare('SELECT decision,reason FROM approvals WHERE id=?').get(t.book.authorizationId)).toEqual({decision:'rejected',reason:'Change the response limits'});t.ingest();await t.f.engine.runOnce();expect(t.f.fake.sendCalls).toBe(0);});
 it('refuses wrong hashes, wrong roles, changed scope, foreign workspace and MCP decisions or revocation',async()=>{
  const t=await fixture();const input={operationHash:t.book.operationHash!,decision:'approved' as const,reason:'Reviewed'};
  expect(()=>decideReplyPlaybook(t.f.engine,t.f.viewer,t.book.id,input)).toThrow(/approver/);expect(()=>decideReplyPlaybook(t.f.engine,t.f.approver,t.book.id,{...input,operationHash:'0'.repeat(64)})).toThrow(/changed|hash/);
  expect(listReplyPlaybooks(t.f.engine,{...t.f.viewer,workspaceId:'other'})).toEqual([]);expect(()=>reviewReplyPlaybook(t.f.engine,{...t.f.viewer,workspaceId:'other'},t.book.id)).toThrow(/not found/);
  const mcp={...t.f.approver,source:'mcp' as const};expect(()=>decideReplyPlaybook(t.f.engine,mcp,t.book.id,input)).toThrow(/signed-in/);expect(()=>decideApproval(t.f.engine,mcp,{...input,approvalId:t.book.authorizationId})).toThrow(/signed-in/);
  t.approveChild();expect(()=>revokeReplyPlaybook(t.f.engine,mcp,t.book.id,'Stop')).toThrow(/signed-in/);expect(()=>revokeApproval(t.f.engine,mcp,t.book.authorizationId,'Stop')).toThrow(/signed-in/);
 });
 it('refuses human approval of a rule whose account mapping changed after review preparation',async()=>{const t=await fixture();t.f.engine.db.prepare("UPDATE work_packages SET account_map='{}' WHERE id=?").run(t.pkg.id);expect(()=>t.approveChild()).toThrow(/fresh review/);expect(reviewReplyPlaybook(t.f.engine,t.f.viewer,t.book.id).canDecide).toBe(false);});
});
