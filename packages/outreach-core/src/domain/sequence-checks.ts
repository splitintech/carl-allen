import type { PreflightCheck, ActionRow } from '../execution/types';
import { inboxCoverageVerdict } from './inbox-coverage';
import { inboxReplyIssue } from './inbox-reply-scope';
/** Deterministic checks only: browser status is refreshed by inbox-sync before the claim pass. */
export function sequencePreflight():PreflightCheck{return({db,action,now})=>{
 const replyIssue=inboxReplyIssue(db,action);if(replyIssue)return{kind:'review',reason:replyIssue};
 const p=JSON.parse(action.payload) as {_dependsOn?:string;_sequenceId?:string;_sequenceStep?:number;_waitFor?:string;_waitHours?:number;_replyPlaybookId?:string;_contactId?:string};
 if(p._dependsOn){const prior=db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=? AND id=?').get<ActionRow>(action.workspace_id,p._dependsOn);
  if(!prior)return{kind:'review',reason:'dependency_missing'};
  if(['failed','cancelled'].includes(prior.state))return{kind:'cancel',reason:'dependency_not_published'};
  if(['uncertain','reconciling','review'].includes(prior.state))return{kind:'review',reason:'dependency_uncertain'};
  if(prior.state!=='succeeded')return{kind:'defer',until:now+60000,reason:'waiting_for_publication_receipt'};
 }
 if(p._replyPlaybookId){const rule=db.prepare('SELECT enabled,valid_until FROM reply_playbooks WHERE workspace_id=? AND id=?').get<{enabled:number;valid_until:number}>(action.workspace_id,p._replyPlaybookId);if(!rule?.enabled||now>rule.valid_until)return{kind:'cancel',reason:'reply_playbook_disabled_or_expired'};
  const coverage=inboxCoverageVerdict(db,action.provider_account_id,now);if(coverage.held)return{kind:'defer',until:now+60000,reason:coverage.reason};
 }
 if(!p._sequenceId)return{kind:'pass'};
 const sequence=db.prepare('SELECT state,action_ids FROM outreach_sequences WHERE workspace_id=? AND id=?').get<{state:string;action_ids:string}>(action.workspace_id,p._sequenceId);
 if(!sequence)return{kind:'review',reason:'sequence_missing'};
 if(sequence.state==='awaiting_approval')return{kind:'await_approval',reason:'sequence_not_approved'};
 if(sequence.state==='paused')return{kind:'defer',until:now+60000,reason:'sequence_paused'};
 if(sequence.state!=='active')return{kind:'cancel',reason:'sequence_'+sequence.state};
 const ids=JSON.parse(sequence.action_ids) as string[];const index=ids.indexOf(action.id);if(index<0||p._sequenceStep!==index)return{kind:'review',reason:'sequence_action_mismatch'};
 const coverage=inboxCoverageVerdict(db,action.provider_account_id,now);if(coverage.held)return{kind:'defer',until:now+60000,reason:coverage.reason};
 if(index>0){const previous=db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=? AND id=?').get<ActionRow>(action.workspace_id,ids[index-1]!);
  if(!previous)return{kind:'review',reason:'prior_step_missing'};
  if(['failed','cancelled'].includes(previous.state))return{kind:'cancel',reason:'prior_step_failed'};
  if(previous.state!=='succeeded')return{kind:'defer',until:now+60000,reason:'waiting_for_prior_step'};
  const notBefore=previous.updated_at+Math.max(0,p._waitHours??0)*3600000;if(now<notBefore)return{kind:'defer',until:notBefore,reason:'sequence_wait'};
 }
 if(p._waitFor==='connected'){
  const result=db.prepare("SELECT data,at FROM sequence_events WHERE sequence_id=? AND kind='connection_status' ORDER BY at DESC LIMIT 1").get<{data:string;at:number}>(p._sequenceId);
  if(!result||now-result.at>15*60000||JSON.parse(result.data).state!=='connected')return{kind:'defer',until:now+60000,reason:'waiting_for_connection_acceptance'};
 }
 return{kind:'pass'};
};}
