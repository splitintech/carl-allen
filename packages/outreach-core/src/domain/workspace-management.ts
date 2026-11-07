import type { WorkManifest } from '@splitin/outreach-contracts';
import { audit, ConflictError, NotFoundError, requireRole, ROLES, type AuthContext, type Role } from './auth';
import type { DomainEnv } from './env';
import type { ActionRow } from '../execution/types';
import { approvalVerdict } from './approvals';
import { isSuppressed } from './suppressions';
interface SequenceRow {id:string;workspace_id:string;package_id:string;contact_id:string;name:string;state:string;steps:string;action_ids:string;stop_reason:string|null;created_at:number;updated_at:number}
interface Attempt {attempt_no:number;outcome:string;started_at:number;finished_at:number|null;receipt:string|null;error_class:string|null;error_detail:string|null}
const terminal=new Set(['succeeded','failed','cancelled']);
function loadSequence(env:DomainEnv,ctx:AuthContext,id:string):SequenceRow {
 requireRole(ctx,'viewer');const row=env.db.prepare('SELECT * FROM outreach_sequences WHERE workspace_id=? AND id=?').get<SequenceRow>(ctx.workspaceId,id);if(!row)throw new NotFoundError('sequence');return row;
}
function sequenceActions(env:DomainEnv,s:SequenceRow){return (JSON.parse(s.action_ids) as string[]).map(id=>env.db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=? AND id=?').get<ActionRow>(s.workspace_id,id)??null);}
function progressOf(actions:(ActionRow|null)[]) {
 const count=(state:string)=>actions.filter(a=>a?.state===state).length;const succeeded=count('succeeded');const failed=count('failed');const cancelled=count('cancelled');
 const current=actions.findIndex(a=>a?.state!=='succeeded');return {total:actions.length,succeeded,failed,cancelled,pending:actions.length-succeeded-failed-cancelled,currentStep:current<0?null:current+1};
}
function statusOf(s:SequenceRow,actions:(ActionRow|null)[]):string {
 if(['stopped','rejected','completed'].includes(s.state))return s.state;
 if(actions.length&&actions.every(a=>a?.state==='succeeded'))return 'completed';
 if(actions.some(a=>a?.state==='failed'))return 'failed';
 if(actions.some(a=>a?.state==='cancelled'))return 'stopped';
 if(s.state==='paused'||s.state==='awaiting_approval')return s.state;
 return !actions.length||actions.some(a=>!a||['uncertain','reconciling','review'].includes(a.state))?'needs_review':s.state;
}
function resumeIssue(env:DomainEnv,s:SequenceRow,actions:(ActionRow|null)[]):string|null {
 if(s.state!=='paused')return 'Only a paused sequence can resume.';
 if(s.stop_reason!=='operator_paused')return 'This sequence has a terminal stop and cannot resume.';
 if(!actions.length||actions.some(a=>!a))return 'Sequence actions are missing; review the handoff.';
 if(actions.some(a=>a&&['claimed','executing','uncertain','reconciling','review'].includes(a.state)))return 'An in-flight or uncertain outcome requires review before resuming.';
 if(actions.some(a=>a&&['failed','cancelled'].includes(a.state)))return 'Failed or cancelled sequence steps cannot resume.';
 if(env.db.prepare("SELECT id FROM sequence_events WHERE sequence_id=? AND kind='stopped' LIMIT 1").get(s.id)||env.db.prepare('SELECT m.id FROM inbox_messages m JOIN inbox_threads t ON t.id=m.thread_id WHERE t.workspace_id=? AND t.contact_id=? AND m.inbound=1 AND m.at>=? LIMIT 1').get(s.workspace_id,s.contact_id,s.created_at))return 'This contact replied or opted out; this sequence cannot resume.';
 const points=env.db.prepare('SELECT value_norm FROM contact_points WHERE workspace_id=? AND contact_id=?').all<{value_norm:string}>(s.workspace_id,s.contact_id);
 for(const point of points)for(const a of actions)if(a&&isSuppressed(env.db,s.workspace_id,point.value_norm,a.provider_account_id,(JSON.parse(a.payload) as {channel?:string}).channel))return 'This contact is suppressed; this sequence cannot resume.';
 const remaining=actions.filter((a):a is ActionRow=>Boolean(a&&!terminal.has(a.state)));if(!remaining.length)return 'This sequence has completed.';
 for(const a of remaining){
  if(!['scheduled','retryable'].includes(a.state))return 'Remaining actions still require scheduling or approval.';
  if(a.not_after!==null&&env.now()>a.not_after)return 'A remaining action has expired; fresh review is required.';
  if(!a.approval_id||approvalVerdict(env.db,a,env.now()).kind!=='pass')return 'A remaining action approval is missing, changed or expired.';
  const attempt=env.db.prepare('SELECT outcome FROM action_attempts WHERE action_id=? ORDER BY attempt_no DESC LIMIT 1').get<{outcome:string}>(a.id);
  if(attempt&&['pending','uncertain'].includes(attempt.outcome))return 'An attempt has an unresolved outcome; reconcile it before resuming.';
 }
 return null;
}
function contactDetails(env:DomainEnv,s:SequenceRow){
 const c=env.db.prepare('SELECT id,full_name,first_name,timezone,attributes FROM contacts WHERE workspace_id=? AND id=?').get<{id:string;full_name:string;first_name:string|null;timezone:string|null;attributes:string}>(s.workspace_id,s.contact_id);if(!c)return null;
 const attrs=JSON.parse(c.attributes) as {sources?:string[];notes?:string};const points=env.db.prepare('SELECT kind,value_raw,consent_basis,jurisdiction,permitted_channels FROM contact_points WHERE workspace_id=? AND contact_id=?').all<{kind:string;value_raw:string;consent_basis:string;jurisdiction:string;permitted_channels:string}>(s.workspace_id,s.contact_id);
 return {id:c.id,name:c.full_name,firstName:c.first_name,timezone:c.timezone,sources:attrs.sources??[],notes:attrs.notes??'',points:points.map(p=>({kind:p.kind,value:p.value_raw,channel:(JSON.parse(p.permitted_channels) as string[])[0]??p.kind,consentBasis:p.consent_basis,jurisdiction:p.jurisdiction}))};
}
function actionDetails(env:DomainEnv,a:ActionRow|null){
 if(!a)return null;const attempts=env.db.prepare('SELECT attempt_no,outcome,started_at,finished_at,receipt,error_class,error_detail FROM action_attempts WHERE action_id=? ORDER BY attempt_no').all<Attempt>(a.id).map(r=>({attemptNo:r.attempt_no,outcome:r.outcome,startedAt:r.started_at,finishedAt:r.finished_at,receipt:r.receipt?JSON.parse(r.receipt) as unknown:null,errorClass:r.error_class,errorDetail:r.error_detail}));
 const content=JSON.parse(a.payload) as {text?:string;subject?:string;channel?:string};return {id:a.id,kind:a.kind,state:a.state,reason:a.state_reason,dueAt:a.due_at,notAfter:a.not_after,recipient:a.recipient_norm,channel:content.channel??null,text:content.text??null,subject:content.subject??null,accountId:a.provider_account_id,approvalId:a.approval_id,attempts};
}
export function getOutreachSequence(env:DomainEnv,ctx:AuthContext,id:string){
 const s=loadSequence(env,ctx,id);const rows=sequenceActions(env,s);const status=statusOf(s,rows);const progress=progressOf(rows);const actions=rows.map(a=>actionDetails(env,a));const resumeBlockedReason=resumeIssue(env,s,rows);
 const steps=(JSON.parse(s.steps) as WorkManifest['outreachSequences'][number]['steps']).map((step,index)=>{
  const action=rows[index];const account=action?.provider_account_id?env.db.prepare('SELECT id,provider,external_account_id,sender_identity,health FROM provider_accounts WHERE workspace_id=? AND id=?').get<{id:string;provider:string;external_account_id:string;sender_identity:string;health:string}>(ctx.workspaceId,action.provider_account_id):null;
  return {...step,index,accountId:action?.provider_account_id??null,account:account?{id:account.id,provider:account.provider,externalAccountId:account.external_account_id,sender:JSON.parse(account.sender_identity) as unknown,health:account.health}:null,action:actions[index]??null};
 });
 return {id:s.id,name:s.name,packageId:s.package_id,contactId:s.contact_id,contact:contactDetails(env,s),status,storedStatus:s.state,stopReason:s.stop_reason,createdAt:s.created_at,updatedAt:s.updated_at,actionIds:JSON.parse(s.action_ids) as string[],steps,actions,progress,canPause:s.state==='active'&&!['completed','failed','stopped','rejected'].includes(status),canResume:resumeBlockedReason===null,resumeBlockedReason};
}
export function listManagedOutreachSequences(env:DomainEnv,ctx:AuthContext,cursor='',limit=100){
 requireRole(ctx,'viewer');return env.db.prepare('SELECT id FROM outreach_sequences WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?').all<{id:string}>(ctx.workspaceId,cursor,Math.min(200,Math.max(1,limit))).map(r=>{
  const s=getOutreachSequence(env,ctx,r.id);return {...s,contactName:s.contact?.name??null,currentStep:s.progress.currentStep,channel:s.steps[s.progress.currentStep===null?0:s.progress.currentStep-1]?.channel??null,scheduledFor:s.actions.find(a=>a&&!terminal.has(a.state))?.dueAt??null};
 });
}
export function guardedPauseOutreachSequence(env:DomainEnv,ctx:AuthContext,id:string){
 requireRole(ctx,'operator');return env.db.transaction(()=>{
  const s=loadSequence(env,ctx,id);if(s.state==='paused')return {paused:true,sequence:getOutreachSequence(env,ctx,id)};
  if(!getOutreachSequence(env,ctx,id).canPause)throw new ConflictError('Only an active unfinished sequence can pause.');
  env.db.prepare("UPDATE outreach_sequences SET state='paused',stop_reason='operator_paused',updated_at=? WHERE workspace_id=? AND id=? AND state='active'").run(env.now(),ctx.workspaceId,id);audit(env.db,ctx,env.now(),'sequence',id,'paused',{});return {paused:true,sequence:getOutreachSequence(env,ctx,id)};
 });
}
export function resumeOutreachSequence(env:DomainEnv,ctx:AuthContext,id:string){
 requireRole(ctx,'operator');return env.db.transaction(()=>{
  const s=loadSequence(env,ctx,id);const issue=resumeIssue(env,s,sequenceActions(env,s));if(issue)throw new ConflictError(issue);
  env.db.prepare("UPDATE outreach_sequences SET state='active',stop_reason=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='paused'").run(env.now(),ctx.workspaceId,id);audit(env.db,ctx,env.now(),'sequence',id,'resumed',{});return {resumed:true,sequence:getOutreachSequence(env,ctx,id)};
 });
}
export function updateTeamMemberRoles(env:DomainEnv,ctx:AuthContext,id:string,roles:Role[],reason:string){
 requireRole(ctx,'admin');if(!reason.trim()||reason.length>1000||roles.length>4||new Set(roles).size!==roles.length||roles.some(r=>!ROLES.includes(r)))throw new ConflictError('Valid roles and a reason are required.');
 return env.db.transaction(()=>{
  const member=env.db.prepare('SELECT id,display_name,roles FROM principals WHERE workspace_id=? AND id=?').get<{id:string;display_name:string;roles:string}>(ctx.workspaceId,id);if(!member)throw new NotFoundError('member');const before=JSON.parse(member.roles) as Role[];
  if(before.includes('admin')&&!roles.includes('admin')){
   if(id===ctx.principalId)throw new ConflictError('You cannot remove your own admin access.');
   const admins=env.db.prepare("SELECT COUNT(*) n FROM principals WHERE workspace_id=? AND EXISTS (SELECT 1 FROM json_each(principals.roles) WHERE value='admin')").get<{n:number}>(ctx.workspaceId)!.n;if(admins<=1)throw new ConflictError('The workspace must retain an admin.');
  }
  env.db.prepare('UPDATE principals SET roles=? WHERE workspace_id=? AND id=?').run(JSON.stringify(roles),ctx.workspaceId,id);if(!roles.length)env.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE workspace_id=? AND principal_id=? AND revoked_at IS NULL').run(env.now(),ctx.workspaceId,id);
  audit(env.db,ctx,env.now(),'principal',id,roles.length?'roles_changed':'access_removed',{beforeRoles:before,roles,reason:reason.trim()});return {id,name:member.display_name,roles};
 });
}
export function revokeTeamInvitation(env:DomainEnv,ctx:AuthContext,id:string,reason:string){
 requireRole(ctx,'admin');if(!reason.trim()||reason.length>1000)throw new ConflictError('Enter a reason for revoking the invitation.');return env.db.transaction(()=>{
  const invite=env.db.prepare('SELECT id,email,roles,expires_at,accepted_at FROM cloud_invitations WHERE workspace_id=? AND id=?').get<{id:string;email:string;roles:string;expires_at:number;accepted_at:number|null}>(ctx.workspaceId,id);if(!invite)throw new NotFoundError('invitation');
  if(invite.accepted_at!==null||invite.expires_at<=env.now())throw new ConflictError('Only a pending invitation can be revoked.');
  env.db.prepare('DELETE FROM cloud_invitations WHERE workspace_id=? AND id=? AND accepted_at IS NULL').run(ctx.workspaceId,id);audit(env.db,ctx,env.now(),'invitation',id,'revoked',{email:invite.email,roles:JSON.parse(invite.roles) as unknown,reason:reason.trim()});return {revoked:true,invitationId:id};
 });
}
