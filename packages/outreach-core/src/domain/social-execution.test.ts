import { describe, expect, it } from 'vitest';
import { openSqliteDatabase, migrate, MIGRATIONS } from '@splitin/outreach-store-sqlite';
import { makeDomainEnv } from './domain.test-util';
import { registerProviderAccount, refreshAccountCapabilities } from './operations';
import { createTemplate } from './templates';
import { createContentCampaign, activateContentCampaign } from './content-calendar';
import { createCampaign, prepareActivation, commitActivation } from './campaigns';
import { addSuppression } from './suppressions';
import { decideApproval, listApprovals } from './approvals';
import { scheduleAction, updateScheduledAction, cancelScheduledAction, convertSocialActionToManual } from './scheduled-management';
import { getContentCampaign, updateContentCampaign, deleteContentCampaign } from './content-management';
import { setKillSwitchAs } from '../engine';
import { checkAccountHealth } from './health';

async function setup(){
 const env=await makeDomainEnv();
 const accountId=await registerProviderAccount(env.engine,env.admin,{provider:'fake-social',externalAccountId:'li-ops',sender:{name:'Social Sender',address:'social@example.com'},purposes:['social_publishing','social_messaging','manual_correspondence'],secretRef:'env:FAKE_SOCIAL',executionPlacement:'daytona-browser'});
 createTemplate(env.engine.db,env.operator,{name:'post',channel:'linkedin',text:'Hello {{sender_name}}'},env.now());
 return {env,accountId};
}
function calendar(now:number, count=1, approval='none') {return {apiVersion:'outreach.splitin.net/v1alpha1',kind:'ContentCalendar',metadata:{name:'audit-calendar'},spec:{purpose:'social_publishing',policy:{approval,firstBatchSize:1,unsubscribe:'reply',requirePostalAddress:false,window:{timezone:'America/New_York',days:['Mon','Tue','Wed','Thu','Fri'],start:'09:00',end:'17:00'},limits:{accountPerDay:10,channelPerDay:10}},posts:Array.from({length:count},(_,i)=>({id:`post${i}`,channel:'linkedin',template:'post@1',scheduledFor:new Date(now).toISOString()}))}};}
async function approveAll(env:Awaited<ReturnType<typeof makeDomainEnv>>){for(const a of listApprovals(env.engine.db,env.approver,'pending'))decideApproval(env.engine,env.approver,{approvalId:a.id,decision:'approved',operationHash:a.operation_hash});}
async function socialSequence(mixed=false,socialOnly=false){
 const {env,accountId}=await setup();const contact=env.contact('ada@example.org');
 env.engine.db.prepare("INSERT INTO contact_points (id,workspace_id,contact_id,kind,value_norm,value_raw,source,consent_basis,jurisdiction) VALUES ('li-profile','ws',?,'social_profile','https://linkedin.com/in/ada','https://linkedin.com/in/ada','test','consent','US')").run(contact);
 if(socialOnly)env.engine.db.prepare("DELETE FROM contact_points WHERE contact_id=? AND kind='email'").run(contact);
 const playbook={apiVersion:'outreach.splitin.net/v1alpha1',kind:'Playbook',metadata:{name:'social-sequence'},spec:{purpose:mixed?'automated_outreach':'social_messaging',audience:{require:[socialOnly?'social_profile':'email']},policy:{approval:'none',unsubscribe:'reply',requirePostalAddress:false,window:{timezone:'America/New_York',days:['Mon','Tue','Wed','Thu','Fri'],start:'09:00',end:'17:00'}},steps:[...(mixed?[{id:'email',type:'email.send',template:'intro@1'}]:[]),{id:'dm',type:'social.message',channel:'linkedin',template:'post@1',providerAccountId:accountId}]}};
 const {campaignId}=createCampaign(env.engine,env.operator,{name:'Social sequence',playbook,providerAccountId:mixed?env.accountId:accountId});
 const preview=prepareActivation(env.engine,env.operator,campaignId);commitActivation(env.engine,env.operator,{campaignId,operationHash:preview.operationHash});
 return {env,accountId,campaignId};
}
describe('social worker regression and operator lifecycle',()=>{
 it('upgrades used historical databases preserving references and migration digests',()=>{
  const db=openSqliteDatabase(':memory:',{migrate:false});migrate(db,MIGRATIONS.slice(0,4));
  db.prepare("INSERT INTO workspaces VALUES ('ws','Workspace','{}',1)").run();
  db.prepare("INSERT INTO scheduled_actions (id,workspace_id,kind,state,due_at,payload,content_hash,idempotency_key,created_at,updated_at) VALUES ('a','ws','manual.task','succeeded',1,'{}','hash','key',1,1)").run();
  db.prepare("INSERT INTO action_attempts (id,action_id,attempt_no,outcome,started_at) VALUES ('attempt','a',1,'succeeded',1)").run();
  db.prepare("INSERT INTO manual_tasks (id,workspace_id,action_id,channel,draft_text,status,created_at) VALUES ('task','ws','a','linkedin','draft','open',1)").run();
  const history=db.prepare('SELECT id,sha256 FROM schema_migrations').all();expect(migrate(db)).toEqual(['0005_social_actions','0006_browser_actions','0007_publishing_workspace']);
  expect(db.prepare('SELECT id,sha256 FROM schema_migrations LIMIT 4').all()).toEqual(history);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1});
  expect(db.prepare('SELECT action_id FROM manual_tasks').get()).toEqual({action_id:'a'});expect(db.prepare('SELECT action_id FROM action_attempts').get()).toEqual({action_id:'a'});db.close();
 });
 it('refuses missing or false capabilities both at creation and at worker preflight',async()=>{
  const {env,accountId}=await setup();
  const {campaignId}=createContentCampaign(env.engine,env.operator,{name:'Calendar',calendar:calendar(env.now()),providerAccountId:accountId});activateContentCampaign(env.engine,env.operator,campaignId);
  env.engine.db.prepare("UPDATE provider_accounts SET capabilities=json_set(capabilities,'$.socialPublish',json('false')) WHERE id=?").run(accountId);
  expect(()=>createContentCampaign(env.engine,env.operator,{name:'Blocked',calendar:calendar(env.now()),providerAccountId:accountId})).toThrow(/explicitly true/);
  await env.drain();expect(env.social.deliveries).toHaveLength(0);expect(env.engine.db.prepare('SELECT state FROM scheduled_actions').get()).toEqual({state:'review'});env.engine.db.close();
 });
 it('executes a mixed email and social sequence through per-step accounts',async()=>{
  const {env}=await socialSequence(true);await env.drain();expect(env.fake.deliveries).toHaveLength(1);expect(env.social.deliveries).toHaveLength(1);expect(env.social.deliveries[0]?.text).toBe('Hello Social Sender');env.engine.db.close();
 });
 it('supports social-only audiences without email points',async()=>{
  const {env}=await socialSequence(false,true);await env.drain();expect(env.social.deliveries).toHaveLength(1);env.engine.db.close();
 });
 it('rechecks email do-not-contact suppression before a pending social DM',async()=>{
  const {env}=await socialSequence();addSuppression(env.engine.db,{workspaceId:'ws',scope:'global',value:'ada@example.org',reason:'do_not_contact',source:'test'},env.now());await env.drain();expect(env.social.deliveries).toHaveLength(0);expect(env.engine.db.prepare('SELECT state FROM scheduled_actions').get()).toEqual({state:'cancelled'});env.engine.db.close();
 });
 it('holds session loss and resumes the same action after affirmative reconnect',async()=>{
  const {env,accountId}=await socialSequence();env.social.script({kind:'reconnect'});await env.drain();
  expect(env.engine.db.prepare('SELECT state FROM scheduled_actions').get()).toEqual({state:'scheduled'});expect(env.engine.db.prepare('SELECT health FROM provider_accounts WHERE id=?').get(accountId)).toEqual({health:'reauth_required'});
  env.social.reconnectNeeded=false;env.social.healthStatus='ok';await checkAccountHealth(env.engine,accountId);env.advance(60*60_000);await env.drain();expect(env.social.deliveries).toHaveLength(1);env.engine.db.close();
 });
 it('creates one first batch and one continuing campaign approval',async()=>{
  const {env,accountId}=await setup();const {campaignId}=createContentCampaign(env.engine,env.operator,{name:'Calendar',calendar:calendar(env.now(),3,'first_batch_then_campaign'),providerAccountId:accountId});activateContentCampaign(env.engine,env.operator,campaignId);
  const approvals=listApprovals(env.engine.db,env.approver,'pending');expect(approvals.map(a=>a.scope).sort()).toEqual(['batch','campaign_version']);await env.drain();expect(env.social.deliveries).toHaveLength(0);
  await approveAll(env);await env.drain();expect(env.social.deliveries).toHaveLength(3);env.engine.db.close();
 });
 it('supports draft CRUD and immutable activated calendar edits',async()=>{
  const {env,accountId}=await setup();const {campaignId}=createContentCampaign(env.engine,env.operator,{name:'Draft',calendar:calendar(env.now()),providerAccountId:accountId});updateContentCampaign(env.engine,env.operator,campaignId,{name:'Changed',calendar:calendar(env.now(),2)});expect(getContentCampaign(env.engine,env.viewer,campaignId).calendar.spec.posts).toHaveLength(2);
  const other=createContentCampaign(env.engine,env.operator,{name:'Remove',calendar:calendar(env.now()),providerAccountId:accountId});deleteContentCampaign(env.engine,env.operator,other.campaignId);expect(()=>getContentCampaign(env.engine,env.viewer,other.campaignId)).toThrow(/not found/);
  activateContentCampaign(env.engine,env.operator,campaignId);expect(()=>updateContentCampaign(env.engine,env.operator,campaignId,{name:'No'})).toThrow(/only draft/);env.engine.db.close();
 });
 it('edits invalidate approvals, cancel prevents send, and explicit manual fallback creates task',async()=>{
  const {env,accountId}=await setup();const a=scheduleAction(env.engine,env.operator,{kind:'social.message',providerAccountId:accountId,payload:{channel:'linkedin',targetUrl:'https://linkedin.com/in/ada',text:'Before'}});await approveAll(env);
  const edited=updateScheduledAction(env.engine,env.operator,a.actionId,{text:'After'});expect(edited.approvalId).not.toBe(a.approvalId);await env.drain();expect(env.social.deliveries).toHaveLength(0);
  await approveAll(env);cancelScheduledAction(env.engine,env.operator,a.actionId,'Operator cancelled');await env.drain();expect(env.social.deliveries).toHaveLength(0);
  const b=scheduleAction(env.engine,env.operator,{kind:'social.connect',providerAccountId:accountId,payload:{channel:'linkedin',targetUrl:'https://linkedin.com/in/ada',text:'Note'}});convertSocialActionToManual(env.engine,env.operator,b.actionId,'Operator opts out');await env.drain();expect(env.engine.db.prepare('SELECT draft_text FROM manual_tasks').get()).toEqual({draft_text:'Note'});env.engine.db.close();
 });
 it('runs approved connect and browser recipes with exact params and kill switch',async()=>{
  const {env,accountId}=await setup();env.engine.db.prepare("UPDATE provider_accounts SET purposes='[\"social_publishing\",\"social_messaging\",\"manual_correspondence\"]' WHERE id=?").run(accountId);
  // Fake adapter declares this purpose only for this trusted test recipe.
  const adapter=env.engine.adapters.get('fake-social')!;(adapter.purposes as string[]).push('manual_correspondence');
  scheduleAction(env.engine,env.operator,{kind:'social.connect',providerAccountId:accountId,payload:{channel:'linkedin',targetUrl:'https://linkedin.com/in/ada',text:'Connect'}});
  const task=scheduleAction(env.engine,env.operator,{kind:'browser.task',providerAccountId:accountId,payload:{recipeId:'save-draft',input:{subject:'Exact'}},approval:'none'});expect(task.approvalId).not.toBeNull();
  setKillSwitchAs(env.engine,env.operator,{scope:'workspace',engaged:true,reason:'Stop'});await approveAll(env);await env.drain();expect(env.social.deliveries).toHaveLength(0);
  setKillSwitchAs(env.engine,env.approver,{scope:'workspace',engaged:false,reason:'Resume'});env.advance(60*60_000);await env.drain();expect(env.social.deliveries.map(d=>d.kind).sort()).toEqual(['browser','connect']);expect(env.social.deliveries.find(d=>d.kind==='browser')?.text).toContain('Exact');env.engine.db.close();
 });
 it('refuses a changed browser recipe definition after approval until it is reviewed',async()=>{
  const {env,accountId}=await setup();const adapter=env.engine.adapters.get('fake-social')!;(adapter.purposes as string[]).push('manual_correspondence');
  const task=scheduleAction(env.engine,env.operator,{kind:'browser.task',providerAccountId:accountId,payload:{recipeId:'save-draft',input:{subject:'Approved'}}});await approveAll(env);
  env.engine.db.prepare("UPDATE provider_accounts SET capabilities=json_set(capabilities,'$.browserRecipeHashes.save-draft',?) WHERE id=?").run('b'.repeat(64),accountId);
  env.advance(60*60_000);await env.drain();expect(env.social.deliveries).toHaveLength(0);expect(env.engine.db.prepare('SELECT state,state_reason FROM scheduled_actions WHERE id=?').get(task.actionId)).toEqual({state:'review',state_reason:'browser_recipe_definition_changed'});env.engine.db.close();
 });
 it('deduplicates a repeated submission and rejects key reuse with changed parameters',async()=>{
  const {env,accountId}=await setup();const input={kind:'social.message' as const,providerAccountId:accountId,payload:{channel:'linkedin',targetUrl:'https://linkedin.com/in/ada',text:'Once'},idempotencyKey:'operator-stable-key'};
  const first=scheduleAction(env.engine,env.operator,input);expect(scheduleAction(env.engine,env.operator,input)).toEqual(first);
  expect(()=>scheduleAction(env.engine,env.operator,{...input,payload:{...input.payload,text:'Changed'}})).toThrow(/different action parameters/);
  await approveAll(env);env.advance(60*60_000);await env.drain();expect(env.social.deliveries).toHaveLength(1);env.engine.db.close();
 });
 it('honors quiet hours and channel daily limits through the worker',async()=>{
  const {env,accountId}=await setup();const spec=calendar(env.now(),2);spec.spec.policy.limits.channelPerDay=1;
  const {campaignId}=createContentCampaign(env.engine,env.operator,{name:'Caps',calendar:spec,providerAccountId:accountId});activateContentCampaign(env.engine,env.operator,campaignId);
  env.advance(-60*60_000);await env.drain();expect(env.social.deliveries).toHaveLength(0);
  env.advance(60*60_000);await env.drain();expect(env.social.deliveries).toHaveLength(1);
  const pending=env.engine.db.prepare("SELECT state_reason FROM scheduled_actions WHERE state='scheduled'").get<{state_reason:string}>();expect(pending?.state_reason).toMatch(/rate_limit:channel/);env.engine.db.close();
 });

 it('refreshes recipe capabilities without elevating placement, purposes or workspace access',async()=>{
  const {env,accountId}=await setup();const old=env.social.capabilities.bind(env.social);env.social.capabilities=now=>({...old(now),browserRecipeHashes:{'save-draft':'b'.repeat(64)}});
  env.engine.db.prepare("UPDATE provider_accounts SET capabilities=json_remove(capabilities,'$.executionPlacement') WHERE id=?").run(accountId);
  const before=env.engine.db.prepare('SELECT purposes FROM provider_accounts WHERE id=?').get(accountId);const refreshed=await refreshAccountCapabilities(env.engine,env.operator,accountId);
  expect(refreshed.browserRecipeHashes?.['save-draft']).toBe('b'.repeat(64));expect(refreshed.executionPlacement).toBeUndefined();expect(env.engine.db.prepare('SELECT purposes FROM provider_accounts WHERE id=?').get(accountId)).toEqual(before);
  await expect(refreshAccountCapabilities(env.engine,env.viewer,accountId)).rejects.toThrow(/operator/);await expect(refreshAccountCapabilities(env.engine,{...env.operator,workspaceId:'other'},accountId)).rejects.toThrow(/not found/);env.engine.db.close();
 });
 it('preserves approved images through calendar materialization and requires approval for media edits',async()=>{
  const {env,accountId}=await setup();const base=calendar(env.now());const spec={...base,spec:{...base.spec,posts:base.spec.posts.map(post=>({...post,mediaUrls:['https://media.example.com/one.png']}))}};
  const {campaignId}=createContentCampaign(env.engine,env.operator,{name:'Images',calendar:spec,providerAccountId:accountId});activateContentCampaign(env.engine,env.operator,campaignId);
  const action=env.engine.db.prepare('SELECT id,content_hash FROM scheduled_actions WHERE campaign_id=?').get<{id:string;content_hash:string}>(campaignId)!;
  updateScheduledAction(env.engine,env.operator,action.id,{mediaUrls:['https://media.example.com/two.png']});await env.drain();expect(env.social.deliveries).toHaveLength(0);
  expect(env.engine.db.prepare('SELECT content_hash FROM scheduled_actions WHERE id=?').get<{content_hash:string}>(action.id)?.content_hash).not.toBe(action.content_hash);await approveAll(env);await env.drain();expect(env.social.deliveries[0]?.mediaUrls).toEqual(['https://media.example.com/two.png']);
  expect(()=>scheduleAction(env.engine,env.operator,{kind:'social.publish',providerAccountId:accountId,payload:{channel:'linkedin',text:'Bad image',mediaUrls:['http://internal/image.png']}})).toThrow(/HTTPS/);env.engine.db.close();
 });

});
