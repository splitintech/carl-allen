import { configuredMediaStore } from './r2-storage';
import { firstCommentIssues, type CapabilitySnapshot, type WorkManifest, type WorkPackageIssue } from '@splitin/outreach-contracts';
import { ConflictError, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import type { WorkPackage } from './work-packages';
import { SCHEDULE_HORIZON_MS } from './cloud-plans';
import { executionAccountIssues } from './compile';
import { getWorkspaceExecutionLimits } from './workspace-policy';
import { mediaAsset } from './publishing-media';
import { postIssues } from './publishing-drafts';
import { blockingWorkPackageIssues, workPackageImportIssues } from './work-package-issues';
export function renderWorkText(text:string,contact:WorkManifest['contacts'][number]):string {
 const values:Record<string,string>={full_name:contact.name,first_name:contact.name.split(/\s/)[0]??'',name:contact.name};
 return text.replace(/\{\{([a-z_]+)\}\}/g,(_,key:string)=>{if(!(key in values))throw new ConflictError('Unknown personalization token '+key);return values[key]!;});
}
export function resolveWorkPackage(env:DomainEnv,ctx:AuthContext,p:WorkPackage):{manifest:WorkManifest;issues:WorkPackageIssue[]} {
 if(!p.manifest)throw new ConflictError('Repair this report into a versioned manifest first');
 const accountCap=getWorkspaceExecutionLimits(env,ctx).accountPerDay;
 const m=p.manifest;const issues=blockingWorkPackageIssues(workPackageImportIssues(env,ctx,p.id,p.issues));
 const issue=(field:string,message:string)=>issues.push({field,message,severity:'error'});
 if(configuredMediaStore()){const raw=env.db.prepare('SELECT extracted_data FROM work_packages WHERE id=?').get<{extracted_data:string}>(p.id)!;if(!JSON.parse(raw.extracted_data).originalRemoteReady)issue('document','Retry HTML upload to persist the original document in cloud storage');}
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
  const due=Date.parse(post.scheduledFor);if(!Number.isFinite(due)||due<=env.now()||due>env.now()+SCHEDULE_HORIZON_MS)issue(post.id,'Choose a future date within 90 days');
  const mediaIds=post.media.map(id=>p.mediaMap[id]).filter((id):id is string=>Boolean(id));
  if(mediaIds.length!==post.media.length)issue(post.id,'Every attachment must be uploaded and mapped');
  if(p.accountMap[post.accountRef])for(const result of postIssues(env,ctx,{id:p.id,revision:p.revision,name:m.name,timezone:m.timezone,scheduledFor:post.scheduledFor,posts:[{channel:post.channel,format:post.format,accountId:p.accountMap[post.accountRef],text:post.text,mediaIds}],status:'draft',actionIds:[],blocked:[],createdAt:env.now(),updatedAt:env.now()}))issue(post.id,result.reason);
  for(const problem of firstCommentIssues(post.channel,post.firstComment))issue(post.id,problem);
  if(post.firstComment&&!env.adapters.get(env.db.prepare('SELECT provider FROM provider_accounts WHERE id=?').get<{provider:string}>(p.accountMap[post.accountRef]??'')?.provider??'')?.social?.comment)issue(post.id,'First comments are not available for this account');
 }
 for(const seq of m.outreachSequences){
  let due=Date.parse(seq.scheduledFor??'');
  if(!Number.isFinite(due)||due<=env.now()||due>env.now()+SCHEDULE_HORIZON_MS)issue(seq.id,'Choose a future start date and time for this outreach sequence within 90 days');
  for(const step of seq.steps){
   if(step.waitFor==='connected'&&step.channel!=='linkedin')issue(seq.id,'Connection acceptance waits are supported only on LinkedIn');
   if((step.kind==='email')!==(step.channel==='email')||(step.kind==='connect'&&step.channel!=='linkedin'))issue(seq.id,'Email steps must use email; connection requests must use LinkedIn');
   due+=step.waitHours*3600000;account(step.accountRef,step.channel,step.kind==='email'?'email.send':step.kind==='connect'?'social.connect':'social.message');
   if(Number.isFinite(due)&&(due<=env.now()||due>env.now()+SCHEDULE_HORIZON_MS))issue(seq.id,'Sequence must stay within the 90-day execution window');
  }
  for(const ref of seq.contacts){
   const c=m.contacts.find(x=>x.id===ref);if(!c){issue(seq.id,'Unknown contact '+ref);continue;}
   for(const step of seq.steps){if(!c[step.channel])issue(c.id,'Missing '+step.channel+' address');if(step.channel==='email'&&(c.consentBasis==='unknown'||!step.subject?.trim()))issue(c.id,'Email requires reviewed consent basis and a subject');try{renderWorkText(step.text,c);if(step.subject)renderWorkText(step.subject,c);}catch(e){issue(c.id,(e as Error).message);}}
  }
 }
 for(const rule of m.replyPlaybooks){
  account(rule.accountRef,rule.channel,rule.channel==='email'?'email.reply':'social.message');
  const valid=Date.parse(rule.validUntil);if(!Number.isFinite(valid)||valid<=env.now()||valid>env.now()+SCHEDULE_HORIZON_MS)issue(rule.id,'Reply rule expiry must be within 90 days');
 }
 // Forecast exact publishing actions including already scheduled work, per-account local calendar day.
 const buckets=new Map<string,number>();
 for(const post of m.publishingPlans){const id=p.accountMap[post.accountRef];if(!id||!Number.isFinite(Date.parse(post.scheduledFor)))continue;const day=new Intl.DateTimeFormat('en-CA',{timeZone:m.timezone}).format(new Date(post.scheduledFor));const key=id+':'+day;buckets.set(key,(buckets.get(key)??0)+1);}
 for(const row of env.db.prepare("SELECT provider_account_id,due_at FROM scheduled_actions WHERE workspace_id=? AND state IN ('scheduled','awaiting_approval') AND kind LIKE 'social.%'").all<{provider_account_id:string;due_at:number}>(ctx.workspaceId)){const key=row.provider_account_id+':'+new Intl.DateTimeFormat('en-CA',{timeZone:m.timezone}).format(new Date(row.due_at));if(buckets.has(key))buckets.set(key,buckets.get(key)!+1);}
 for(const [key,count] of buckets)if(count>accountCap)issue(key,'Daily account cap forecast exceeded: '+count+' actions, cap '+accountCap);
 return {manifest:m,issues};
}
