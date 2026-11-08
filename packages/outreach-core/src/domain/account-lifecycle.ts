import { CANCELLABLE_ACTION_STATES, ulid } from '@splitin/outreach-contracts';
import { transitionAction } from '../execution/actions-repo';
import type { ActionRow, PreflightCheck } from '../execution/types';
import { actorOf, audit, ConflictError, NotFoundError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
export interface AccountLifecycle { status: 'disabled'|'disconnected'; reason: string; disabledAt: number; profilePolicy: 'retain'|'delete' }
export interface AccountDisableInput { reason: string; profilePolicy: 'retain'|'delete'; state?: 'disabled'|'disconnected' }
export function accountLifecycle(env: Pick<DomainEnv,'db'>, workspaceId: string, accountId: string): AccountLifecycle|null {
  return env.db.prepare('SELECT status,reason,disabled_at AS disabledAt,profile_policy AS profilePolicy FROM provider_account_lifecycle WHERE workspace_id=? AND account_id=?').get<AccountLifecycle>(workspaceId,accountId) ?? null;
}
export const accountLifecyclePreflight = (): PreflightCheck => ({db,action}) => {
  const lifecycle=action.provider_account_id&&accountLifecycle({db},action.workspace_id,action.provider_account_id);
  return lifecycle?{kind:'cancel',reason:'account_'+lifecycle.status}:{kind:'pass'};
};
export function disableProviderAccount(env: DomainEnv, ctx: AuthContext, accountId: string, input: AccountDisableInput) {
  requireRole(ctx,'admin');
  if(!input.reason.trim()||input.reason.length>1000||!['retain','delete'].includes(input.profilePolicy)||input.state&&!['disabled','disconnected'].includes(input.state))throw new ConflictError('A reason and explicit retain/delete profile policy are required');
  return env.db.transaction(()=>{
    if(!env.db.prepare('SELECT id FROM provider_accounts WHERE workspace_id=? AND id=?').get(ctx.workspaceId,accountId))throw new NotFoundError('provider account');
    const status=input.state??'disabled';const now=env.now();const reason='account_'+status;const actor=actorOf(ctx);
    env.db.prepare('INSERT INTO provider_account_lifecycle(account_id,workspace_id,status,reason,disabled_at,profile_policy) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,disabled_at=excluded.disabled_at,profile_policy=excluded.profile_policy').run(accountId,ctx.workspaceId,status,input.reason.trim(),now,input.profilePolicy);
    env.db.prepare("UPDATE provider_accounts SET health='unhealthy',health_detail=?,health_checked_at=? WHERE workspace_id=? AND id=?").run(reason,now,ctx.workspaceId,accountId);
    const actions=env.db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=?').all<ActionRow>(ctx.workspaceId);const affected=new Set(actions.filter(a=>a.provider_account_id===accountId).map(a=>a.id));const approvalIds=new Set<string>();const stoppedSequenceIds=new Set<string>();
    const sequences=env.db.prepare('SELECT id,action_ids,state FROM outreach_sequences WHERE workspace_id=?').all<{id:string;action_ids:string;state:string}>(ctx.workspaceId);
    const books=env.db.prepare('SELECT id,account_id,authorization_id,package_id FROM reply_playbooks WHERE workspace_id=?').all<{id:string;account_id:string;authorization_id:string;package_id:string}>(ctx.workspaceId);const disabledBooks=new Set<string>();
    let previous=-1;
    while(previous!==affected.size+approvalIds.size+disabledBooks.size){
      previous=affected.size+approvalIds.size+disabledBooks.size;
      for(const sequence of sequences){const ids=JSON.parse(sequence.action_ids) as string[];if(!ids.some(id=>affected.has(id)))continue;for(const id of ids)affected.add(id);if(['active','paused','awaiting_approval'].includes(sequence.state))stoppedSequenceIds.add(sequence.id);}
      for(const action of actions)if(affected.has(action.id)&&action.approval_id)approvalIds.add(action.approval_id);
      const packages=new Set<string>();
      for(const id of approvalIds){const plan=env.db.prepare('SELECT subject_id FROM plan_authorizations WHERE workspace_id=? AND id=?').get<{subject_id:string}>(ctx.workspaceId,id);if(plan)packages.add(plan.subject_id);for(const row of env.db.prepare('SELECT action_id FROM plan_actions WHERE authorization_id=?').all<{action_id:string}>(id))affected.add(row.action_id);}
      for(const book of books)if(book.account_id===accountId||approvalIds.has(book.authorization_id)||packages.has(book.package_id)){disabledBooks.add(book.id);approvalIds.add(book.authorization_id);}
      for(const action of actions)if(disabledBooks.has((JSON.parse(action.payload) as {_replyPlaybookId?:string})._replyPlaybookId??''))affected.add(action.id);
    }
    const cancelledActionIds:string[]=[];const inFlightActionIds:string[]=[];const heldActionIds:string[]=[];
    for(const action of actions){if(!affected.has(action.id))continue;
      if(CANCELLABLE_ACTION_STATES.includes(action.state)||action.state==='review'&&action.attempt_count===0){transitionAction(env.db,action,'cancelled',now,actor,{state_reason:reason,lease_owner:null,lease_expires_at:null});cancelledActionIds.push(action.id);}
      else if(action.state==='executing')inFlightActionIds.push(action.id);
      else if(['uncertain','reconciling','review'].includes(action.state))heldActionIds.push(action.id);
      if(action.enrollment_id)env.db.prepare("UPDATE enrollments SET status='stopped',row_version=row_version+1,updated_at=? WHERE workspace_id=? AND id=? AND status IN ('active','paused')").run(now,ctx.workspaceId,action.enrollment_id);
    }
    const revokedApprovalIds:string[]=[];
    for(const id of approvalIds){const changed=env.db.prepare("UPDATE approvals SET decision='revoked',reason=?,decided_at=? WHERE workspace_id=? AND id=? AND decision IN ('pending','approved')").run(reason,now,ctx.workspaceId,id);if(changed.changes)revokedApprovalIds.push(id);env.db.prepare("UPDATE work_packages SET status='needs_repair',updated_at=? WHERE workspace_id=? AND authorization_id=?").run(now,ctx.workspaceId,id);}
    for(const id of stoppedSequenceIds){env.db.prepare("UPDATE outreach_sequences SET state='stopped',stop_reason=?,updated_at=? WHERE workspace_id=? AND id=?").run(reason,now,ctx.workspaceId,id);env.db.prepare('INSERT INTO sequence_events(id,sequence_id,kind,event_key,data,at) VALUES(?,?,?,?,?,?)').run(ulid(now),id,'stopped',ulid(now),JSON.stringify({reason,accountId}),now);}
    for(const id of disabledBooks)env.db.prepare('UPDATE reply_playbooks SET enabled=0 WHERE workspace_id=? AND id=?').run(ctx.workspaceId,id);
    const profileBlockers=actions.filter(a=>a.provider_account_id===accountId&&(['executing','uncertain','reconciling'].includes(a.state)||a.state==='review'&&a.attempt_count>0)).map(a=>({actionId:a.id,state:a.state}));
    audit(env.db,ctx,now,'provider_account',accountId,status,{reason:input.reason.trim(),profilePolicy:input.profilePolicy,cancelledActionIds,inFlightActionIds,heldActionIds,revokedApprovalIds,stoppedSequenceIds:[...stoppedSequenceIds]});
    return {accountId,status,disabledAt:now,cancelledActionIds,inFlightActionIds,heldActionIds,revokedApprovalIds,stoppedSequenceIds:[...stoppedSequenceIds],profile:{policy:input.profilePolicy,mayRemove:input.profilePolicy==='delete'&&!profileBlockers.length,blockers:profileBlockers,requiresRuntimeOwnershipCheck:true as const}};
  });
}
/** Re-verification is owned by the connection surface. Old approvals/actions remain revoked/cancelled. */
export function reactivateProviderAccount(env:DomainEnv,ctx:AuthContext,accountId:string){requireRole(ctx,'admin');const account=env.db.prepare('SELECT health FROM provider_accounts WHERE workspace_id=? AND id=?').get<{health:string}>(ctx.workspaceId,accountId);if(!account)throw new NotFoundError('provider account');if(account.health!=='ok')throw new ConflictError('Verify the account connection before reconnecting');env.db.prepare('DELETE FROM provider_account_lifecycle WHERE workspace_id=? AND account_id=?').run(ctx.workspaceId,accountId);audit(env.db,ctx,env.now(),'provider_account',accountId,'reactivated',{});return{accountId,active:true};}
