import { configuredMediaStore } from './r2-storage';
import { digestCanonical, ulid, type CapabilitySnapshot, type SenderIdentity, type WorkManifest, type WorkPackageIssue } from '@splitin/outreach-contracts';
import { actorOf, audit, ConflictError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { getWorkPackage, type WorkPackage } from './work-packages';
import { createPlanAuthorization, revokePackagePlan, SCHEDULE_HORIZON_MS } from './cloud-plans';
import { scheduleAction } from './scheduled-management';
import { executionAccountIssues } from './compile';
import { enqueueAction } from '../execution/enqueue';
import type { ActionRow } from '../execution/types';
import { getWorkspaceExecutionLimits,newPlanPolicy } from './workspace-policy';
import { mediaAsset } from './publishing-media';
import { postIssues } from './publishing-drafts';
import { createReplyPlaybook } from './reply-playbooks';
export function renderWorkText(text:string,contact:WorkManifest['contacts'][number]):string {
 const values:Record<string,string>={full_name:contact.name,first_name:contact.name.split(/\s/)[0]??'',name:contact.name};
 return text.replace(/\{\{([a-z_]+)\}\}/g,(_,key:string)=>{if(!(key in values))throw new ConflictError('Unknown personalization token '+key);return values[key]!;});
}
function resolvePackage(env:DomainEnv,ctx:AuthContext,p:WorkPackage):{manifest:WorkManifest;issues:WorkPackageIssue[]} {
 if(!p.manifest)throw new ConflictError('Repair this report into a versioned manifest first');
 if(configuredMediaStore()){const raw=env.db.prepare('SELECT extracted_data FROM work_packages WHERE id=?').get<{extracted_data:string}>(p.id)!;if(!JSON.parse(raw.extracted_data).originalRemoteReady)throw new ConflictError('Retry HTML upload to persist the original document in cloud storage');}
 const accountCap=getWorkspaceExecutionLimits(env,ctx).accountPerDay;
 const m=p.manifest;const issues:WorkPackageIssue[]=[];const issue=(field:string,message:string)=>issues.push({field,message});
 for(const person of m.contacts)for(const channel of ['linkedin','instagram'] as const){const value=person[channel];if(!value)continue;const url=new URL(value);const valid=channel==='linkedin'?url.hostname==='www.linkedin.com'&&/^\/in\/[a-z0-9_-]+\/?$/.test(url.pathname):url.hostname==='www.instagram.com'&&/^\/[a-z0-9_.]{1,30}\/?$/.test(url.pathname)&&!/^\/(accounts|direct|explore|reels|stories|p)\/?$/.test(url.pathname);if(!valid||url.search||url.hash||url.port)issue(person.id,'Use a canonical '+channel+' personal profile URL with www, lowercase handle, and no tracking parameters. This is required for recipient and reply matching.');}
 const account=(ref:string,channel:string,kind:string)=>{
  const id=p.accountMap[ref];if(!id){issue(ref,'Map a connected account');return;}
  const r=env.db.prepare('SELECT health,capabilities,provider FROM provider_accounts WHERE workspace_id=? AND id=?').get<{health:string;capabilities:string;provider:string}>(ctx.workspaceId,id);
  if(!r){issue(ref,'Account does not belong to this workspace');return;}
  if(r.health!=='ok')issue(ref,'Reconnect and verify this account before scheduling');
  const caps=JSON.parse(r.capabilities) as CapabilitySnapshot;
  if(channel!=='email'&&!caps.socialChannels?.includes(channel))issue(ref,'Account does not support '+channel);
  for(const detail of executionAccountIssues(env,ctx.workspaceId,kind,id,channel==='email'?'automated_outreach':kind==='social.publish'?'social_publishing':'social_messaging'))issue(ref,detail);
 };
 for(const media of m.media) {
  const id=p.mediaMap[media.id];if(!id){issue(media.id,'Upload and map media file '+media.name);continue;}
  try{const asset=mediaAsset(env,ctx,id);if(configuredMediaStore()&&!env.db.prepare('SELECT remote_ready FROM publishing_media WHERE id=?').get<{remote_ready:number}>(id)?.remote_ready)issue(media.id,'Retry upload completion to persist this file in cloud media storage');if(media.sha256&&asset.sha256!==media.sha256)issue(media.id,'File checksum differs from the manifest');}catch{issue(media.id,'Mapped file is not available');}
 }
 for(const post of m.publishingPlans){
  account(post.accountRef,post.channel,'social.publish');
  const due=Date.parse(post.scheduledFor);if(due<env.now()||due>env.now()+SCHEDULE_HORIZON_MS)issue(post.id,'Choose a future date within 90 days');
  const mediaIds=post.media.map(id=>p.mediaMap[id]).filter((id):id is string=>Boolean(id));
  if(mediaIds.length!==post.media.length)issue(post.id,'Every attachment must be uploaded and mapped');
  if(p.accountMap[post.accountRef])for(const result of postIssues(env,ctx,{id:p.id,revision:p.revision,name:m.name,timezone:m.timezone,scheduledFor:post.scheduledFor,posts:[{channel:post.channel,format:post.format,accountId:p.accountMap[post.accountRef],text:post.text,mediaIds}],status:'draft',actionIds:[],blocked:[],createdAt:env.now(),updatedAt:env.now()}))issue(post.id,result.reason);
  if(post.firstComment&&!['linkedin','instagram'].includes(post.channel))issue(post.id,'First comments are supported only on LinkedIn and Instagram');
  if(post.firstComment&&!env.adapters.get(env.db.prepare('SELECT provider FROM provider_accounts WHERE id=?').get<{provider:string}>(p.accountMap[post.accountRef]??'')?.provider??'')?.social?.comment)issue(post.id,'First comments are not available for this account');
 }
 for(const seq of m.outreachSequences){
  let due=Date.parse(seq.scheduledFor);
  for(const step of seq.steps){if(step.waitFor==='connected'&&step.channel!=='linkedin')issue(seq.id,'Connection acceptance waits are supported only on LinkedIn');due+=step.waitHours*3600000;account(step.accountRef,step.channel,step.kind==='email'?'email.send':step.kind==='connect'?'social.connect':'social.message');if(due<env.now()||due>env.now()+SCHEDULE_HORIZON_MS)issue(seq.id,'Sequence must stay within the 90-day execution window');}
  for(const ref of seq.contacts){
   const c=m.contacts.find(x=>x.id===ref);if(!c){issue(seq.id,'Unknown contact '+ref);continue;}
   for(const step of seq.steps){if(!c[step.channel])issue(c.id,'Missing '+step.channel+' address');if(step.channel==='email'&&(c.consentBasis==='unknown'||!step.subject))issue(c.id,'Email requires reviewed consent basis and a subject');try{renderWorkText(step.text,c);}catch(e){issue(c.id,(e as Error).message);}}
  }
 }
 for(const rule of m.replyPlaybooks){
  account(rule.accountRef,rule.channel,rule.channel==='email'?'email.reply':'social.message');
  const valid=Date.parse(rule.validUntil);if(valid<=env.now()||valid>env.now()+SCHEDULE_HORIZON_MS)issue(rule.id,'Reply rule expiry must be within 90 days');
 }
 // Forecast exact publishing actions including already scheduled work, per-account local calendar day.
 const buckets=new Map<string,number>();
 for(const post of m.publishingPlans){const id=p.accountMap[post.accountRef];if(!id)continue;const day=new Intl.DateTimeFormat('en-CA',{timeZone:m.timezone}).format(new Date(post.scheduledFor));const key=id+':'+day;buckets.set(key,(buckets.get(key)??0)+1);}
 for(const row of env.db.prepare("SELECT provider_account_id,due_at FROM scheduled_actions WHERE workspace_id=? AND state IN ('scheduled','awaiting_approval') AND kind LIKE 'social.%'").all<{provider_account_id:string;due_at:number}>(ctx.workspaceId)){const key=row.provider_account_id+':'+new Intl.DateTimeFormat('en-CA',{timeZone:m.timezone}).format(new Date(row.due_at));if(buckets.has(key))buckets.set(key,buckets.get(key)!+1);}
 for(const [key,count] of buckets)if(count>accountCap)issue(key,'Daily account cap forecast exceeded: '+count+' actions, cap '+accountCap);
 return {manifest:m,issues};
}
function importPeople(env:DomainEnv,ctx:AuthContext,m:WorkManifest):Map<string,string>{
 const ids=new Map<string,string>();
 for(const c of m.contacts){
  const points=[c.email?.toLowerCase(),c.linkedin,c.instagram].filter((v):v is string=>Boolean(v));
  const matches=new Set<string>();for(const value of points){const p=env.db.prepare('SELECT contact_id FROM contact_points WHERE workspace_id=? AND value_norm=?').get<{contact_id:string}>(ctx.workspaceId,value);if(p)matches.add(p.contact_id);}
  if(matches.size>1)throw new ConflictError('Contact identities belong to different existing people; repair '+c.id);
  let id=[...matches][0];if(!id){id=ulid(env.now());env.db.prepare('INSERT INTO contacts(id,workspace_id,full_name,first_name,timezone,attributes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,ctx.workspaceId,c.name,c.name.split(/\s/)[0]??c.name,m.timezone,JSON.stringify({sources:c.sources,notes:c.notes}),env.now(),env.now());}
  ids.set(c.id,id);
  for(const channel of ['email','linkedin','instagram'] as const){const value=c[channel];if(!value)continue;env.db.prepare("INSERT OR IGNORE INTO contact_points(id,workspace_id,contact_id,kind,value_norm,value_raw,source,consent_basis,consent_at,jurisdiction,permitted_channels) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(ulid(env.now()),ctx.workspaceId,id,channel==='email'?'email':'social_profile',channel==='email'?value.toLowerCase():value,value,'work-package:'+m.packageId,c.consentBasis,env.now(),c.jurisdiction,JSON.stringify([channel]));}
 }
 return ids;
}
export function prepareWorkPackage(env:DomainEnv,ctx:AuthContext,id:string){
 requireRole(ctx,'operator');return env.db.transaction(()=>{
 const p=getWorkPackage(env,ctx,id);
 if(p.authorizationId){const current=env.db.prepare('SELECT a.decision,a.expires_at,p.valid_until FROM approvals a JOIN plan_authorizations p ON p.id=a.id WHERE a.id=?').get<{decision:string;expires_at:number;valid_until:number}>(p.authorizationId);if(current&&((current.decision==='pending'&&current.expires_at>=env.now())||(current.decision==='approved'&&current.valid_until>=env.now()))&&['awaiting_approval','scheduled'].includes(p.status))return {package:p,authorizationId:p.authorizationId,operationHash:p.operationHash,preview:{posts:p.manifest?.publishingPlans,contacts:p.manifest?.contacts,sequences:p.manifest?.outreachSequences,replyPlaybooks:p.manifest?.replyPlaybooks,issues:p.issues,executionWindowUntil:current.valid_until,renderedActions:env.db.prepare('SELECT a.id,a.provider_account_id AS accountId,a.recipient_norm AS recipient,a.due_at AS dueAt,a.payload FROM scheduled_actions a JOIN plan_actions p ON p.action_id=a.id WHERE p.authorization_id=?').all<{id:string;accountId:string;recipient:string;dueAt:number;payload:string}>(p.authorizationId).map(a=>({...a,payload:JSON.parse(a.payload)}))}};
 revokePackagePlan(env,ctx,id);}
 const generation=ulid(env.now());
 const {manifest:m,issues}=resolvePackage(env,ctx,p);
 if(issues.length){env.db.prepare("UPDATE work_packages SET issues=?,status='needs_repair',updated_at=? WHERE id=?").run(JSON.stringify(issues),env.now(),id);return {package:getWorkPackage(env,ctx,id),authorizationId:null,operationHash:null,preview:{posts:m.publishingPlans,contacts:m.contacts,sequences:m.outreachSequences,replyPlaybooks:m.replyPlaybooks,issues}};}
 const policy=newPlanPolicy(env,ctx,m.timezone);
 const people=importPeople(env,ctx,m);const actions:ActionRow[]=[];
 const enqueue=(input:Parameters<typeof enqueueAction>[1])=>{const a=enqueueAction(env.db,input,actorOf(ctx),env.now()).action;actions.push(a);return a;};
 for(const post of m.publishingPlans){
  const accountId=p.accountMap[post.accountRef]!;const {actionId}=scheduleAction(env,ctx,{kind:'social.publish',providerAccountId:accountId,payload:{channel:post.channel,text:post.text,tags:post.tags,format:post.format,mediaUrls:post.media.map(x=>'outreach-media://'+mediaAsset(env,ctx,p.mediaMap[x]!).sha256),mediaIds:post.media.map(x=>p.mediaMap[x]),_workPackageId:id,targetId:post.id},dueAt:Date.parse(post.scheduledFor),policy:{...policy,window:{...policy.window,timezone:m.timezone,fallback:m.timezone}},idempotencyKey:'package:'+id+':'+generation+':'+post.id});
  env.db.prepare('UPDATE scheduled_actions SET not_after=NULL WHERE id=?').run(actionId);
  const a=env.db.prepare('SELECT * FROM scheduled_actions WHERE id=?').get<ActionRow>(actionId)!;actions.push(a);
  if(post.firstComment)enqueue({workspaceId:ctx.workspaceId,kind:'social.comment',providerAccountId:accountId,purpose:'social_publishing',payload:{channel:post.channel,text:post.firstComment,_dependsOn:actionId,_workPackageId:id,_policy:policy},idempotencyKey:'package:'+id+':'+generation+':'+post.id+':comment',dueAt:a.due_at,awaitingApproval:true});
 }
 for(const seq of m.outreachSequences)for(const contactRef of seq.contacts){
  const c=m.contacts.find(x=>x.id===contactRef)!;const sequenceId=ulid(env.now());const actionIds:string[]=[];let due=Date.parse(seq.scheduledFor);
  for(let index=0;index<seq.steps.length;index++){
   const step=seq.steps[index]!;due+=step.waitHours*3600000;const accountId=p.accountMap[step.accountRef]!;
   const account=env.db.prepare('SELECT sender_identity FROM provider_accounts WHERE id=?').get<{sender_identity:string}>(accountId)!;const sender=JSON.parse(account.sender_identity) as SenderIdentity;
   const rendered=renderWorkText(step.text,c);const contactId=people.get(contactRef)!;const recipient=c[step.channel]!;
   const cp=env.db.prepare('SELECT id FROM contact_points WHERE workspace_id=? AND contact_id=? AND value_norm=?').get<{id:string}>(ctx.workspaceId,contactId,step.channel==='email'?recipient.toLowerCase():recipient);
   const payload=step.kind==='email'?{channel:'email',from:{name:sender.name,address:sender.address},to:[{name:c.name,address:recipient}],subject:renderWorkText(step.subject!,c),text:rendered+'\n\n'+(sender.postalAddress?sender.postalAddress+'\n':'')+'Reply "unsubscribe" to stop future messages.',headers:{}}:{channel:step.channel,targetUrl:recipient,text:rendered};
   const a=enqueue({workspaceId:ctx.workspaceId,kind:step.kind==='email'?'email.send':step.kind==='connect'?'social.connect':'social.message',providerAccountId:accountId,purpose:step.channel==='email'?'automated_outreach':'social_messaging',payload:{...payload,_policy:{...policy,window:{...policy.window,timezone:m.timezone,fallback:m.timezone}},_sequenceId:sequenceId,_sequenceStep:index,_waitFor:step.waitFor,_waitHours:step.waitHours,_workPackageId:id,_contactId:contactId},recipient,contactPointId:cp?.id,dueAt:due,idempotencyKey:'package:'+id+':'+generation+':'+seq.id+':'+contactRef+':'+step.id,awaitingApproval:true});actionIds.push(a.id);
  }
  env.db.prepare('INSERT INTO outreach_sequences(id,workspace_id,package_id,contact_id,name,steps,action_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(sequenceId,ctx.workspaceId,id,people.get(contactRef)!,seq.name,JSON.stringify(seq.steps),JSON.stringify(actionIds),env.now(),env.now());
 }
 const validUntil=Math.max(m.outreachSequences.length?env.now()+SCHEDULE_HORIZON_MS:env.now()+3600000,...actions.map(a=>a.due_at+3600000),...m.replyPlaybooks.map(r=>Date.parse(r.validUntil)));
 const authorization=createPlanAuthorization(env,ctx,id,actions,{manifest:m,accountMap:p.accountMap,mediaMap:p.mediaMap},validUntil);
 for(const rule of m.replyPlaybooks)createReplyPlaybook(env,ctx,id,p.accountMap[rule.accountRef]!,rule,authorization.authorizationId);
 env.db.prepare("UPDATE work_packages SET status='awaiting_approval',authorization_id=?,issues='[]',updated_at=? WHERE id=?").run(authorization.authorizationId,env.now(),id);
 audit(env.db,ctx,env.now(),'work_package',id,'prepared',{hash:digestCanonical(m),count:actions.length});
 return {package:getWorkPackage(env,ctx,id),...authorization,preview:{posts:m.publishingPlans,contacts:m.contacts,sequences:m.outreachSequences,replyPlaybooks:m.replyPlaybooks,issues:[],executionWindowUntil:validUntil,renderedActions:actions.map(a=>({id:a.id,accountId:a.provider_account_id,recipient:a.recipient_norm,dueAt:a.due_at,payload:JSON.parse(a.payload)}))}};
 });
}
