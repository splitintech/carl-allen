import { ulid, type WorkManifest } from '@splitin/outreach-contracts';
import { audit, ConflictError, ForbiddenError, NotFoundError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { createPlanAuthorization } from './cloud-plans';
import { decideApproval, loadApproval, revokeApproval, type DecisionInput } from './approvals';
import { freezeReplyPolicy, replyAccountScope, replyScopeIssue, type ReplyPlaybookRow, type ReplyScope } from './reply-playbook-scope';
import { getWorkspaceExecutionLimits } from './workspace-policy';
export function createReplyPlaybook(env:DomainEnv,ctx:AuthContext,packageId:string,accountId:string,rule:WorkManifest['replyPlaybooks'][number],parentAuthorizationId:string) {
 requireRole(ctx,'operator');
 const pkg=env.db.prepare('SELECT revision,source_hash FROM work_packages WHERE workspace_id=? AND id=?').get<{revision:number;source_hash:string}>(ctx.workspaceId,packageId);
 if(!pkg)throw new NotFoundError('work package');
 const id=ulid(env.now());const account=replyAccountScope(env.db,ctx.workspaceId,accountId);if(!account)throw new NotFoundError('account');
 const summary:ReplyScope={kind:'reply_playbook',playbookId:id,packageId,packageRevision:pkg.revision,sourceHash:pkg.source_hash,parentAuthorizationId,accountId,account,rule,...freezeReplyPolicy(getWorkspaceExecutionLimits(env,ctx))};
 const authorization=createPlanAuthorization(env,ctx,packageId,[],summary,Date.parse(rule.validUntil));
 env.db.prepare('INSERT INTO reply_playbooks(id,workspace_id,package_id,account_id,authorization_id,rules,valid_until,enabled) VALUES (?,?,?,?,?,?,?,0)').run(id,ctx.workspaceId,packageId,accountId,authorization.authorizationId,JSON.stringify(rule),Date.parse(rule.validUntil));
 audit(env.db,ctx,env.now(),'reply_playbook',id,'prepared',authorization);return {id,...authorization};
}
function loadBook(env:DomainEnv,ctx:AuthContext,id:string):ReplyPlaybookRow {
 requireRole(ctx,'viewer');const book=env.db.prepare('SELECT * FROM reply_playbooks WHERE workspace_id=? AND id=?').get<ReplyPlaybookRow>(ctx.workspaceId,id);if(!book)throw new NotFoundError('reply playbook');return book;
}
export function reviewReplyPlaybook(env:DomainEnv,ctx:AuthContext,id:string) {
 const book=loadBook(env,ctx,id);const approval=loadApproval(env.db,ctx.workspaceId,book.authorization_id);const issue=replyScopeIssue(env.db,book,env.now());
 const decision=approval?.decision??'revoked';const status=decision==='pending'&&approval&&env.now()>approval.expires_at?'expired':decision==='approved'&&(issue||!book.enabled)?'held':decision;
 const pkg=env.db.prepare('SELECT name,revision FROM work_packages WHERE workspace_id=? AND id=?').get<{name:string;revision:number}>(ctx.workspaceId,book.package_id);
 const frozen=approval?JSON.parse(approval.preview) as {summary?:ReplyScope}:null;
 const identity=frozen?.summary?.account;const account=identity?{provider:identity.provider,externalAccountId:identity.external_account_id,sender:identity.sender_identity}:null;
 return {id:book.id,packageId:book.package_id,packageName:pkg?.name??book.package_id,packageRevision:pkg?.revision,accountId:book.account_id,account,authorizationId:book.authorization_id,operationHash:approval?.operation_hash??null,rule:JSON.parse(book.rules) as WorkManifest['replyPlaybooks'][number],bounds:frozen?.summary?.bounds??null,status,decision,enabled:Boolean(book.enabled),reason:issue??approval?.reason??null,reviewExpiresAt:approval?.expires_at,validUntil:book.valid_until,canDecide:status==='pending'&&!issue,createdAt:approval?.created_at,decidedAt:approval?.decided_at};
}
export function listReplyPlaybooks(env:DomainEnv,ctx:AuthContext,cursor='',limit=100) {
 requireRole(ctx,'viewer');return env.db.prepare('SELECT id FROM reply_playbooks WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?').all<{id:string}>(ctx.workspaceId,cursor,Math.max(1,Math.min(200,limit))).map(r=>reviewReplyPlaybook(env,ctx,r.id));
}
function requireReviewSource(ctx:AuthContext):void { if(!['http','test'].includes(ctx.source))throw new ForbiddenError('Reply approval requires the signed-in Carl-Allen review screen'); }
export function decideReplyPlaybook(env:DomainEnv,ctx:AuthContext,id:string,input:Omit<DecisionInput,'approvalId'>) {
 requireReviewSource(ctx);const book=loadBook(env,ctx,id);if(!input.reason?.trim())throw new ConflictError('Enter a reason for this reply playbook decision');
 decideApproval(env,ctx,{...input,approvalId:book.authorization_id});return reviewReplyPlaybook(env,ctx,id);
}
export function revokeReplyPlaybook(env:DomainEnv,ctx:AuthContext,id:string,reason:string) {
 requireReviewSource(ctx);const book=loadBook(env,ctx,id);if(!reason.trim())throw new ConflictError('Enter a reason for revoking this reply playbook');
 revokeApproval(env,ctx,book.authorization_id,reason);return reviewReplyPlaybook(env,ctx,id);
}
