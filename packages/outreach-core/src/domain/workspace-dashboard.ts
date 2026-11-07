import { requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { workspaceMediaQuota } from './publishing-media';

export function workspaceStorage(env: DomainEnv, ctx: AuthContext) {
 requireRole(ctx,'viewer');
 const used=env.db.prepare('SELECT COALESCE(SUM(size),0) bytes,COUNT(*) files FROM publishing_media WHERE workspace_id=?').get<{bytes:number;files:number}>(ctx.workspaceId)!;
 const pending=env.db.prepare('SELECT COALESCE(SUM(size),0) bytes,COUNT(*) files FROM publishing_uploads WHERE workspace_id=? AND completed_asset_id IS NULL AND created_at>=?').get<{bytes:number;files:number}>(ctx.workspaceId,env.now()-86400000)!;
 return {...workspaceMediaQuota(env,ctx),usedBytes:used.bytes,files:used.files,reservedBytes:pending.bytes,activeUploads:pending.files};
}
interface DashboardAction {id:string;kind:string;state:string;payload:string;due_at:number;updated_at:number;provider_account_id:string|null;state_reason:string|null;sender_identity:string|null;external_account_id:string|null}
function actionView(row:DashboardAction) {
 const payload=JSON.parse(row.payload) as {channel?:string;text?:string;subject?:string;_workPackageId?:string;publishingDraftId?:string;_sequenceId?:string};
 const sender=JSON.parse(row.sender_identity??'{}') as {name?:string;address?:string};
 return {id:row.id,kind:row.kind,state:row.state,channel:payload.channel??'email',title:payload.subject||payload.text?.slice(0,140)||row.kind,dueAt:row.due_at,updatedAt:row.updated_at,accountId:row.provider_account_id,accountName:sender.name||sender.address||row.external_account_id||'Unavailable account',reason:row.state_reason,packageId:payload._workPackageId??null,draftId:payload.publishingDraftId??null,sequenceId:payload._sequenceId??null};
}
const actionSelect='SELECT a.id,a.kind,a.state,a.payload,a.due_at,a.updated_at,a.provider_account_id,a.state_reason,p.sender_identity,p.external_account_id FROM scheduled_actions a LEFT JOIN provider_accounts p ON p.id=a.provider_account_id AND p.workspace_id=a.workspace_id';
export function workspaceHome(env:DomainEnv,ctx:AuthContext) {
 requireRole(ctx,'viewer');
 const now=env.now();
 const pendingReviews=env.db.prepare(`SELECT a.id,a.subject_id AS subjectId,a.expires_at AS expiresAt,
 CASE WHEN r.id IS NOT NULL THEN 'reply' WHEN w.id IS NOT NULL THEN 'package' WHEN d.id IS NOT NULL THEN 'draft' ELSE 'action' END AS kind,
 COALESCE(w.name,d.name,CASE WHEN r.id IS NOT NULL THEN 'Reply playbook' ELSE 'Action review' END) AS name,r.id AS playbookId
 FROM approvals a LEFT JOIN reply_playbooks r ON r.authorization_id=a.id AND r.workspace_id=a.workspace_id
 LEFT JOIN work_packages w ON w.authorization_id=a.id AND w.workspace_id=a.workspace_id
 LEFT JOIN publishing_drafts d ON d.id=a.subject_id AND d.workspace_id=a.workspace_id
 WHERE a.workspace_id=? AND a.decision='pending' AND a.expires_at>=? ORDER BY a.created_at,a.id LIMIT 20`).all<{id:string;subjectId:string;expiresAt:number;kind:'reply'|'package'|'draft'|'action';name:string;playbookId:string|null}>(ctx.workspaceId,now);
 const count=(condition:string)=>env.db.prepare('SELECT COUNT(*) n FROM scheduled_actions WHERE workspace_id=? AND '+condition).get<{n:number}>(ctx.workspaceId)!.n;
 const pending=env.db.prepare("SELECT COUNT(*) n FROM approvals WHERE workspace_id=? AND decision='pending' AND expires_at>=?").get<{n:number}>(ctx.workspaceId,now)!.n;
 const connectionIssues=env.db.prepare("SELECT id,provider,health,health_detail AS detail,external_account_id AS identity FROM provider_accounts WHERE workspace_id=? AND health<>'ok' ORDER BY id").all<{id:string;provider:string;health:string;detail:string|null;identity:string}>(ctx.workspaceId);
 return {asOf:now,summary:{pendingReviews:pending,upcoming:count("state IN ('scheduled','claimed','retryable','executing','reconciling')"),needsAttention:count("state IN ('review','uncertain','failed')"),connectionIssues:connectionIssues.length},pendingReviews,connectionIssues,
 upcoming:env.db.prepare(actionSelect+" WHERE a.workspace_id=? AND a.state IN ('scheduled','claimed','retryable','executing','reconciling') ORDER BY a.due_at,a.id LIMIT 20").all<DashboardAction>(ctx.workspaceId).map(actionView),
 recent:env.db.prepare(actionSelect+" WHERE a.workspace_id=? AND a.state IN ('succeeded','failed','uncertain','review','cancelled') ORDER BY a.updated_at DESC,a.id DESC LIMIT 20").all<DashboardAction>(ctx.workspaceId).map(actionView)};
}
