import type { SqlDatabase } from '@splitin/outreach-contracts';
import { ConflictError } from './auth';
import type { ActionRow } from '../execution/types';
interface Policy {window?:{timezone?:string;fallback?:string};limits?:{accountPerDay?:number}}
export interface AccountCapConflict {accountId:string;date:string;timezone:string;count:number;limit:number}
const budgeted=(a:ActionRow)=>Boolean(a.provider_account_id)&&(a.kind.startsWith('social.')||a.kind.startsWith('email.')||a.kind==='browser.task');
function policy(a:ActionRow):{zone:string;limit:number}{const p=(JSON.parse(a.payload) as {_policy?:Policy})._policy;const zone=p?.window?.timezone==='recipient'?(p.window.fallback??'America/New_York'):(p?.window?.timezone??'America/New_York');const limit=p?.limits?.accountPerDay??10;if(!Number.isSafeInteger(limit)||limit<1)throw new ConflictError('Invalid account daily policy');try{new Intl.DateTimeFormat('en-CA',{timeZone:zone}).format();}catch{throw new ConflictError('Invalid account forecast timezone');}return{zone,limit};}
/** A plan reserves account/day capacity together with already queued work. Comments and outreach
 * consume the same target account's policy budget. Requested rows already inserted in SQLite are
 * excluded from the existing side, so callers may freeze a complete transactional batch safely.
 */
export function forecastPlanCapacity(db:SqlDatabase,workspaceId:string,actions:readonly ActionRow[]):AccountCapConflict[]{
 const requested=actions.filter(budgeted);const requestedIds=new Set(actions.map(a=>a.id));
 const existing=db.prepare("SELECT * FROM scheduled_actions WHERE workspace_id=? AND state IN ('planned','awaiting_approval','scheduled','claimed','executing','retryable','uncertain','reconciling','succeeded','review')").all<ActionRow>(workspaceId).filter(a=>!requestedIds.has(a.id)&&budgeted(a));
 const policies=new Map<string,ReturnType<typeof policy>>();const policyOf=(a:ActionRow)=>{let p=policies.get(a.id);if(!p){p=policy(a);policies.set(a.id,p);}return p;};
 const all=[...requested,...existing];const formatters=new Map<string,Intl.DateTimeFormat>();const dates=new Map<string,string>();
 const date=(at:number,zone:string)=>{const key=zone+':'+at;let day=dates.get(key);if(!day){let formatter=formatters.get(zone);if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});formatters.set(zone,formatter);}day=formatter.format(at);dates.set(key,day);}return day;};
 const buckets=new Map<string,{accountId:string;date:string;timezone:string;limit:number}>();
 for(const a of requested){const p=policyOf(a);const day=date(a.due_at,p.zone);const key=JSON.stringify([a.provider_account_id,p.zone,day]);const old=buckets.get(key);buckets.set(key,{accountId:a.provider_account_id!,date:day,timezone:p.zone,limit:Math.min(old?.limit??p.limit,p.limit)});}
 const conflicts:AccountCapConflict[]=[];
 for(const bucket of buckets.values()){const members=all.filter(a=>a.provider_account_id===bucket.accountId&&date(a.due_at,bucket.timezone)===bucket.date);const limit=Math.min(bucket.limit,...members.map(a=>policyOf(a).limit));if(members.length>limit)conflicts.push({...bucket,limit,count:members.length});}
 return conflicts;
}
export function assertPlanCapacity(db:SqlDatabase,workspaceId:string,actions:readonly ActionRow[]):void{const conflicts=forecastPlanCapacity(db,workspaceId,actions);if(conflicts.length)throw new ConflictError('Daily account cap forecast exceeded: '+conflicts.slice(0,10).map(c=>`${c.accountId} ${c.date} (${c.timezone}): ${c.count} actions, cap ${c.limit}`).join('; '));}
