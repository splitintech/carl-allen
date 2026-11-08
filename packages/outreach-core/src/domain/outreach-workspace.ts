import {isSuppressed} from './suppressions';
import { ulid } from '@splitin/outreach-contracts';
import { audit, ConflictError, NotFoundError, requireRole, type AuthContext, type Role } from './auth';
import type { DomainEnv } from './env';
import { listManagedOutreachSequences, guardedPauseOutreachSequence } from './workspace-management';
import { inboxCursorState } from './inbox-coverage';
export function listPeople(env:DomainEnv,ctx:AuthContext,cursor='',limit=100){
 requireRole(ctx,'viewer');
 return env.db.prepare('SELECT id,full_name,attributes FROM contacts WHERE workspace_id=? AND merged_into_id IS NULL AND id>? ORDER BY id LIMIT ?').all<{id:string;full_name:string;attributes:string}>(ctx.workspaceId,cursor,Math.min(200,Math.max(1,limit))).map(c=>{
  const attrs=JSON.parse(c.attributes) as {sources?:string[];notes?:string};
  const points=env.db.prepare('SELECT kind,value_norm,value_raw,consent_basis,jurisdiction,source,permitted_channels FROM contact_points WHERE workspace_id=? AND contact_id=?').all<{kind:string;value_norm:string;value_raw:string;consent_basis:string|null;jurisdiction:string|null;source:string;permitted_channels:string}>(ctx.workspaceId,c.id);
  const details=points.map(p=>({kind:p.kind,value:p.value_raw,channels:JSON.parse(p.permitted_channels) as string[],consentBasis:p.consent_basis??'unknown',jurisdiction:p.jurisdiction,source:p.source}));const restricted=points.some(p=>((JSON.parse(p.permitted_channels) as string[]).length?JSON.parse(p.permitted_channels) as string[]:['*']).some(channel=>isSuppressed(env.db,ctx.workspaceId,p.value_norm,null,channel)));
  return {id:c.id,name:c.full_name,points:details,status:restricted?'Contact restriction':details.length&&details.every(p=>p.consentBasis!=='unknown')?'Reviewed basis recorded':'Needs consent review',sources:attrs.sources??[],notes:attrs.notes??'',...Object.fromEntries(points.map(p=>[p.kind==='email'?'email':(JSON.parse(p.permitted_channels) as string[])[0]??'profile',p.value_raw]))};
 });
}
export function listOutreachSequences(env:DomainEnv,ctx:AuthContext,cursor='',limit=100){
 return listManagedOutreachSequences(env,ctx,cursor,limit);
}
export function pauseOutreachSequence(env:DomainEnv,ctx:AuthContext,id:string){
 return guardedPauseOutreachSequence(env,ctx,id);
}
export function listInboxMonitoring(env:DomainEnv,ctx:AuthContext){
 requireRole(ctx,'viewer');const maximumAge=15*60000;
 return env.db.prepare('SELECT a.id,a.provider,a.health,a.capabilities,c.cursor,c.polled_at,c.error FROM provider_accounts a LEFT JOIN inbox_cursors c ON c.account_id=a.id WHERE a.workspace_id=? ORDER BY a.id').all<{id:string;provider:string;health:string;capabilities:string;cursor:string|null;polled_at:number|null;error:string|null}>(ctx.workspaceId).flatMap(a=>{
  const capabilities=JSON.parse(a.capabilities) as {socialMessage?:boolean;socialChannels?:string[]};const adapter=env.adapters.get(a.provider);if(!adapter?.inbox?.listThreads&&!(capabilities.socialMessage&&adapter?.social?.conversations))return[];
  const lastPolledAt=a.polled_at&&a.polled_at>0?a.polled_at:null;const ageMs=lastPolledAt===null?null:Math.max(0,env.now()-lastPolledAt);
  const coverage=inboxCursorState(a.cursor);const status=a.health!=='ok'?'connection_issue':a.error?'error':lastPolledAt===null?'never_polled':ageMs!>maximumAge?'stale':!coverage.coverage.complete?'incomplete':'fresh';const held=status!=='fresh';
  const holdReason=status==='connection_issue'?'Reconnect and verify this account.':status==='error'?'Inbox synchronization must succeed before follow-ups continue.':status==='never_polled'?'Waiting for the first successful inbox sync.':status==='stale'?'The last inbox sync is older than 15 minutes.':status==='incomplete'?coverage.coverage.reason??'Native inbox continuation or coverage verification is pending.':null;
  return[{accountId:a.id,provider:a.provider,channel:capabilities.socialChannels?.[0]??'email',health:a.health,status,lastPolledAt,lastCompleteAt:coverage.completedAt,coverage:coverage.coverage,ageMs,maxAgeMs:maximumAge,error:a.error,held,holdReason}];
 });
}
export function listInboxThreads(env:DomainEnv,ctx:AuthContext,cursor='',limit=100){
 requireRole(ctx,'viewer');return env.db.prepare('SELECT t.*,p.capabilities FROM inbox_threads t JOIN provider_accounts p ON p.id=t.account_id WHERE t.workspace_id=? AND t.id>? ORDER BY t.id LIMIT ?').all<{id:string;subject:string;peer_url:string;account_id:string;contact_id:string|null;assigned_to:string|null;notes:string;updated_at:number;capabilities:string}>(ctx.workspaceId,cursor,Math.min(200,Math.max(1,limit))).map(t=>{
  const messages=env.db.prepare('SELECT id,native_id,text,inbound,at FROM inbox_messages WHERE thread_id=? ORDER BY at DESC,id DESC LIMIT 100').all<{id:string;native_id:string;text:string;inbound:number;at:number}>(t.id).reverse();
  return {id:t.id,subject:t.subject,peerUrl:t.peer_url,accountId:t.account_id,contactId:t.contact_id,assignedTo:t.assigned_to,notes:t.notes,updatedAt:t.updated_at,channel:(JSON.parse(t.capabilities) as {socialChannels?:string[]}).socialChannels?.[0]??'email',snippet:messages.at(-1)?.text??'',messages};
 });
}
export function updateInboxThread(env:DomainEnv,ctx:AuthContext,id:string,input:{assignedTo?:string|null;notes?:string}){
 requireRole(ctx,'operator');if(!env.db.prepare('SELECT id FROM inbox_threads WHERE workspace_id=? AND id=?').get(ctx.workspaceId,id))throw new NotFoundError('thread');
 if(input.assignedTo&&!env.db.prepare('SELECT id FROM principals WHERE workspace_id=? AND id=?').get(ctx.workspaceId,input.assignedTo))throw new NotFoundError('member');
 if(input.assignedTo!==undefined)env.db.prepare('UPDATE inbox_threads SET assigned_to=? WHERE id=?').run(input.assignedTo,id);
 if(input.notes!==undefined)env.db.prepare('UPDATE inbox_threads SET notes=? WHERE id=?').run(input.notes,id);
 audit(env.db,ctx,env.now(),'thread',id,'updated',{});return {updated:true};
}
export function workspaceInsights(env:DomainEnv,ctx:AuthContext){
 requireRole(ctx,'viewer');const metrics:Record<string,number>={};
 for(const r of env.db.prepare('SELECT state,COUNT(*) n FROM scheduled_actions WHERE workspace_id=? GROUP BY state').all<{state:string;n:number}>(ctx.workspaceId))metrics[r.state]=r.n;
 metrics.people=env.db.prepare('SELECT COUNT(*) n FROM contacts WHERE workspace_id=?').get<{n:number}>(ctx.workspaceId)!.n;
 metrics.replies=env.db.prepare('SELECT COUNT(*) n FROM inbox_messages m JOIN inbox_threads t ON t.id=m.thread_id WHERE t.workspace_id=? AND m.inbound=1').get<{n:number}>(ctx.workspaceId)!.n;
 metrics.mediaBytes=env.db.prepare('SELECT COALESCE(SUM(size),0) n FROM publishing_media WHERE workspace_id=?').get<{n:number}>(ctx.workspaceId)!.n;
 metrics.unhealthyAccounts=env.db.prepare("SELECT COUNT(*) n FROM provider_accounts WHERE workspace_id=? AND health<>'ok'").get<{n:number}>(ctx.workspaceId)!.n;
 return metrics;
}
export function listTeam(env:DomainEnv,ctx:AuthContext){
 requireRole(ctx,'viewer');return {currentPrincipalId:ctx.principalId,members:env.db.prepare('SELECT id,display_name,roles FROM principals WHERE workspace_id=?').all<{id:string;display_name:string;roles:string}>(ctx.workspaceId).map(r=>({id:r.id,name:r.display_name,roles:JSON.parse(r.roles) as string[]})),invitations:ctx.roles.includes('admin')?env.db.prepare('SELECT id,email,roles,expires_at,accepted_at FROM cloud_invitations WHERE workspace_id=? ORDER BY created_at DESC').all<{id:string;email:string;roles:string;expires_at:number;accepted_at:number|null}>(ctx.workspaceId).map(r=>({...r,roles:JSON.parse(r.roles) as string[],status:r.accepted_at?'Accepted':r.expires_at<env.now()?'Expired':'Pending'})):[]};
}
export function inviteTeamMember(env:DomainEnv,ctx:AuthContext,email:string,roles:Role[]){
 requireRole(ctx,'admin');if(!email.includes('@')||!roles.length)throw new ConflictError('Email and roles are required');
 const id=ulid(env.now());const expiresAt=env.now()+7*86400000;
 env.db.prepare('INSERT INTO cloud_invitations(id,workspace_id,email,roles,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(id,ctx.workspaceId,email.trim().toLowerCase(),JSON.stringify(roles),expiresAt,env.now());
 audit(env.db,ctx,env.now(),'invitation',id,'created',{email,roles});return {id,email,roles,expiresAt};
}
