import { CANCELLABLE_ACTION_STATES, digestCanonical, ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { assertPlanCapacity } from './plan-capacity';
import { createApproval } from './approvals';
import { actorOf, audit, ConflictError, ForbiddenError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { transitionAction } from '../execution/actions-repo';
import type { ActionRow, PreflightVerdict } from '../execution/types';
export const SCHEDULE_HORIZON_MS = 90 * 86400000;
export const PUBLISHING_GRACE_MS = 3600000;
export interface PlanAuthorization { id: string; workspace_id: string; subject_id: string; manifest_hash: string; valid_until: number; created_at: number }
interface FrozenAction {content_hash:string;approved_due_at:number;provider_account_id:string|null;recipient_norm:string|null;action_kind:string|null;purpose:string|null;approved_not_after:number|null;execution_due_at:number|null}
export function attachPlanAction(env:DomainEnv,authorizationId:string,a:ActionRow):void {
 env.db.prepare('INSERT INTO plan_actions(authorization_id,action_id,content_hash,approved_due_at,provider_account_id,recipient_norm,action_kind,purpose,approved_not_after,execution_due_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(authorizationId,a.id,a.content_hash,a.due_at,a.provider_account_id,a.recipient_norm,a.kind,a.purpose,a.not_after,a.due_at);
}
function frozenMatches(item:FrozenAction,action:ActionRow):boolean {
 return item.action_kind===action.kind&&item.provider_account_id===action.provider_account_id&&item.recipient_norm===action.recipient_norm&&item.purpose===action.purpose&&item.approved_not_after===action.not_after&&item.execution_due_at===action.due_at;
}
export function createPlanAuthorization(env:DomainEnv,ctx:AuthContext,subjectId:string,actions:readonly ActionRow[],summary:unknown,validUntil?:number):{authorizationId:string;operationHash:string} {
 requireRole(ctx,'operator');
 if(actions.some(a=>a.workspace_id!==ctx.workspaceId||!['planned','scheduled','awaiting_approval'].includes(a.state)||a.attempt_count>0))throw new ConflictError('Only this workspace’s unattempted work can enter a fresh plan review');
 assertPlanCapacity(env.db,ctx.workspaceId,actions);
 const now=env.now(); const dates=actions.map(a=>a.due_at);
 if(dates.some(n=>n<now||n>now+SCHEDULE_HORIZON_MS))throw new ConflictError('Schedules must be future times within 90 days');
 const ends=validUntil??Math.max(now,...dates)+PUBLISHING_GRACE_MS;
 if(ends>now+SCHEDULE_HORIZON_MS+PUBLISHING_GRACE_MS||ends<=now)throw new ConflictError('Invalid plan execution validity');
 const preview={summary,validUntil:ends,actions:actions.map(a=>({id:a.id,contentHash:a.content_hash,accountId:a.provider_account_id,recipient:a.recipient_norm,kind:a.kind,purpose:a.purpose,notAfter:a.not_after,dueAt:a.due_at,payload:JSON.parse(a.payload) as unknown}))};
 const hash=digestCanonical(preview);
 const id=createApproval(env.db,{workspaceId:ctx.workspaceId,scope:'batch',subjectId,operationHash:hash,preview,requestedBy:ctx.principalId},now);
 env.db.prepare('INSERT INTO plan_authorizations(id,workspace_id,subject_id,manifest_hash,valid_until,created_at) VALUES (?,?,?,?,?,?)').run(id,ctx.workspaceId,subjectId,hash,ends,now);
 for(const a of actions) {
  if(a.approval_id)env.db.prepare("UPDATE approvals SET decision='revoked',reason='Grouped into exact plan review',decided_at=? WHERE id=? AND decision='pending'").run(now,a.approval_id);
  attachPlanAction(env,id,a);
  env.db.prepare("UPDATE scheduled_actions SET approval_id=?,state='awaiting_approval' WHERE id=?").run(id,a.id);
 }
 audit(env.db,ctx,now,'plan',subjectId,'prepared',{authorizationId:id,operationHash:hash,count:actions.length,validUntil:ends});
 return {authorizationId:id,operationHash:hash};
}
export function planVerdict(db:SqlDatabase,action:ActionRow,now:number):PreflightVerdict|null {
 if(!action.approval_id)return null;
 const plan=db.prepare('SELECT * FROM plan_authorizations WHERE id=? AND workspace_id=?').get<PlanAuthorization>(action.approval_id,action.workspace_id);
 if(!plan)return null;
 const approval=db.prepare('SELECT decision,operation_hash,preview FROM approvals WHERE id=?').get<{decision:string;operation_hash:string;preview:string}>(plan.id);
 if(approval?.decision==='rejected'||approval?.decision==='revoked')return {kind:'cancel',reason:'plan_'+approval.decision};
 if(approval?.decision!=='approved')return {kind:'await_approval',reason:'plan_not_approved'};
 if(approval.operation_hash!==plan.manifest_hash||now>plan.valid_until)return {kind:'await_approval',reason:'plan_expired_or_changed'};
 const preview=JSON.parse(approval.preview) as {validUntil?:number};if(preview.validUntil!==plan.valid_until||digestCanonical(preview)!==plan.manifest_hash)return{kind:'await_approval',reason:'plan_expired_or_changed'};
 const item=db.prepare('SELECT * FROM plan_actions WHERE authorization_id=? AND action_id=?').get<FrozenAction>(plan.id,action.id);
 if(!item||!frozenMatches(item,action)||item.content_hash!==action.content_hash||digestCanonical(JSON.parse(action.payload))!==action.content_hash)return {kind:'await_approval',reason:'plan_hash_mismatch'};
 if(action.kind==='social.publish'&&now>item.approved_due_at+PUBLISHING_GRACE_MS)return {kind:'review',reason:'missed_publishing_slot'};
 return {kind:'pass'};
}
export function assertPlanDecision(env:DomainEnv,ctx:AuthContext,id:string,hash:string):void {
 const plan=env.db.prepare('SELECT * FROM plan_authorizations WHERE id=? AND workspace_id=?').get<PlanAuthorization>(id,ctx.workspaceId);
 if(!plan)return;
 if(ctx.source!=='http'&&ctx.source!=='test')throw new ForbiddenError('Plan approval requires the signed-in Carl-Allen review screen');
 if(plan.manifest_hash!==hash||env.now()>plan.valid_until)throw new ConflictError('Plan changed or execution window expired; prepare it again');
 const approval=env.db.prepare('SELECT preview FROM approvals WHERE id=?').get<{preview:string}>(id);if(!approval||digestCanonical(JSON.parse(approval.preview))!==hash||(JSON.parse(approval.preview) as {validUntil?:number}).validUntil!==plan.valid_until)throw new ConflictError('Plan preview changed; fresh review required');
 const rows=env.db.prepare('SELECT a.* FROM plan_actions p JOIN scheduled_actions a ON a.id=p.action_id WHERE p.authorization_id=?').all<ActionRow>(id);
 for(const a of rows){const item=env.db.prepare('SELECT * FROM plan_actions WHERE authorization_id=? AND action_id=?').get<FrozenAction>(id,a.id);if(a.state!=='awaiting_approval'||!item||!frozenMatches(item,a)||a.content_hash!==item.content_hash||digestCanonical(JSON.parse(a.payload))!==item.content_hash)throw new ConflictError('Plan actions changed; fresh review required');}
}
export function completePlanDecision(env:DomainEnv,id:string,approved:boolean):void {
 const p=env.db.prepare('SELECT subject_id FROM plan_authorizations WHERE id=?').get<{subject_id:string}>(id);
 if(!p)return;
 env.db.prepare('UPDATE work_packages SET status=?,updated_at=? WHERE authorization_id=?').run(approved?'scheduled':'ready_for_review',env.now(),id);
 env.db.prepare("UPDATE outreach_sequences SET state=?,updated_at=? WHERE package_id=? AND state='awaiting_approval'").run(approved?'active':'rejected',env.now(),p.subject_id);
 if(!approved)env.db.prepare('UPDATE reply_playbooks SET enabled=0 WHERE authorization_id=?').run(id);
}
export function stopPlanExecution(env:DomainEnv,authorizationId:string,reason:string):void {
 const plan=env.db.prepare('SELECT workspace_id,subject_id FROM plan_authorizations WHERE id=?').get<{workspace_id:string;subject_id:string}>(authorizationId);if(!plan)return;
 env.db.prepare("UPDATE work_packages SET status='ready_for_review',updated_at=? WHERE authorization_id=?").run(env.now(),authorizationId);
 env.db.prepare("UPDATE outreach_sequences SET state='stopped',stop_reason=?,updated_at=? WHERE package_id=? AND state IN ('active','paused','awaiting_approval')").run(reason,env.now(),plan.subject_id);
 env.db.prepare('UPDATE reply_playbooks SET enabled=0 WHERE authorization_id=?').run(authorizationId);
 for(const a of env.db.prepare('SELECT a.* FROM scheduled_actions a JOIN plan_actions p ON p.action_id=a.id WHERE p.authorization_id=? AND a.workspace_id=?').all<ActionRow>(authorizationId,plan.workspace_id))if(CANCELLABLE_ACTION_STATES.includes(a.state))transitionAction(env.db,a,'cancelled',env.now(),{kind:'system',id:'plan-authorization',source:'worker',traceId:ulid(env.now())},{state_reason:reason,lease_owner:null,lease_expires_at:null});
}
export function revokePackagePlan(env:DomainEnv,ctx:AuthContext,packageId:string,options:{supersede?:boolean}={}):void {
 const rows=env.db.prepare('SELECT a.* FROM scheduled_actions a JOIN plan_actions pa ON pa.action_id=a.id JOIN plan_authorizations p ON p.id=pa.authorization_id WHERE p.workspace_id=? AND p.subject_id=?').all<ActionRow>(ctx.workspaceId,packageId);
 if(!options.supersede&&rows.some(a=>['claimed','executing','uncertain','reconciling','succeeded'].includes(a.state)))throw new ConflictError('Attempted or in-flight work cannot be edited; create a new package revision');
 for(const a of rows)if(CANCELLABLE_ACTION_STATES.includes(a.state)||a.state==='review')transitionAction(env.db,a,'cancelled',env.now(),actorOf(ctx),{state_reason:'package_changed',lease_owner:null,lease_expires_at:null});
 env.db.prepare("UPDATE approvals SET decision='revoked',reason='Package changed',decided_at=? WHERE id IN (SELECT id FROM plan_authorizations WHERE workspace_id=? AND subject_id=?) AND decision IN ('pending','approved')").run(env.now(),ctx.workspaceId,packageId);
 env.db.prepare("UPDATE outreach_sequences SET state='stopped',stop_reason='package_changed',updated_at=? WHERE package_id=?").run(env.now(),packageId);
 env.db.prepare('UPDATE reply_playbooks SET enabled=0 WHERE package_id=?').run(packageId);
 env.db.prepare("UPDATE work_packages SET status=?,updated_at=? WHERE id=?").run(options.supersede?'superseded':'ready_for_review',env.now(),packageId);
}
export function planId():string{return ulid();}
export { actorOf };
