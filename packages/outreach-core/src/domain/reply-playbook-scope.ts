import { digestCanonical, type SqlDatabase, type WorkManifest } from '@splitin/outreach-contracts';
export type ReplyRule = WorkManifest['replyPlaybooks'][number];
export const REPLY_RESPONSE_BOUNDS={accountPerDay:10,domainPerDay:3,channelPerDay:10,contactMinGapHours:24,maxPerIncomingEvent:1} as const;
export const REPLY_EXECUTION_POLICY={limits:{accountPerDay:10,domainPerDay:3,channelPerDay:10},window:{timezone:'UTC',fallback:'UTC',days:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],start:'00:00',end:'23:59'},expireAfter:'P1D',approval:'every_action',firstBatchSize:20,unsubscribe:'reply',requirePostalAddress:false} as const;
export function freezeReplyPolicy(limits:{accountPerDay:number;channelPerDay:number}) {
 const daily={accountPerDay:Math.min(10,limits.accountPerDay),channelPerDay:Math.min(10,limits.channelPerDay)};
 return {policy:{...REPLY_EXECUTION_POLICY,limits:{...REPLY_EXECUTION_POLICY.limits,...daily}},bounds:{...REPLY_RESPONSE_BOUNDS,...daily}};
}
export interface ReplyPlaybookRow { id:string; workspace_id:string; package_id:string; account_id:string; authorization_id:string; rules:string; valid_until:number; enabled:number }
interface PackageScope { revision:number; source_hash:string; manifest:string; account_map:string; authorization_id:string|null; status:string }
interface AccountScope {provider:string;external_account_id:string;sender_identity:unknown;purposes:string[];capabilities:Record<string,unknown>}
export interface ReplyScope { kind:'reply_playbook'; playbookId:string; packageId:string; packageRevision:number; sourceHash:string; parentAuthorizationId:string; accountId:string; account:AccountScope; rule:ReplyRule; policy:ReturnType<typeof freezeReplyPolicy>['policy']; bounds:ReturnType<typeof freezeReplyPolicy>['bounds'] }
export function replyAccountScope(db:SqlDatabase,workspaceId:string,accountId:string):AccountScope|null {
 const account=db.prepare('SELECT provider,external_account_id,sender_identity,purposes,capabilities FROM provider_accounts WHERE workspace_id=? AND id=?').get<{provider:string;external_account_id:string;sender_identity:string;purposes:string;capabilities:string}>(workspaceId,accountId);
 if(!account)return null;const capabilities=JSON.parse(account.capabilities) as Record<string,unknown>;delete capabilities.discoveredAt;
 return {...account,sender_identity:JSON.parse(account.sender_identity) as unknown,purposes:(JSON.parse(account.purposes) as string[]).sort(),capabilities};
}
export function replyScopeIssue(db:SqlDatabase,book:ReplyPlaybookRow,now:number):string|null {
 try {
  const plan=db.prepare('SELECT manifest_hash,valid_until FROM plan_authorizations WHERE id=? AND workspace_id=?').get<{manifest_hash:string;valid_until:number}>(book.authorization_id,book.workspace_id);
  const approval=db.prepare('SELECT preview,operation_hash FROM approvals WHERE id=? AND workspace_id=?').get<{preview:string;operation_hash:string}>(book.authorization_id,book.workspace_id);
  if(!plan||!approval||plan.manifest_hash!==approval.operation_hash)return 'reply_authorization_missing_or_changed';
  const preview=JSON.parse(approval.preview) as {summary?:ReplyScope;validUntil:number};const s=preview.summary;
  if(digestCanonical(preview)!==plan.manifest_hash||!s||s.kind!=='reply_playbook'||s.playbookId!==book.id||s.packageId!==book.package_id||s.accountId!==book.account_id)return 'reply_scope_changed';
  if(!s.policy?.limits||![s.policy.limits.accountPerDay,s.policy.limits.channelPerDay].every(v=>Number.isSafeInteger(v)&&v>=1&&v<=10))return 'reply_bounds_changed';
  const expected=freezeReplyPolicy(s.policy.limits);
  if(digestCanonical(s.policy)!==digestCanonical(expected.policy)||digestCanonical(s.bounds??null)!==digestCanonical(expected.bounds))return 'reply_bounds_changed';
  if(plan.valid_until!==preview.validUntil||book.valid_until!==plan.valid_until||Date.parse(s.rule.validUntil)!==book.valid_until||now>book.valid_until)return 'reply_expired_or_changed';
  if(digestCanonical(s.rule)!==digestCanonical(JSON.parse(book.rules))||digestCanonical(s.account)!==digestCanonical(replyAccountScope(db,book.workspace_id,book.account_id)))return 'reply_rule_or_account_changed';
  const pkg=db.prepare('SELECT revision,source_hash,manifest,account_map,authorization_id,status FROM work_packages WHERE workspace_id=? AND id=?').get<PackageScope>(book.workspace_id,book.package_id);
  const manifest=pkg&&JSON.parse(pkg.manifest) as WorkManifest|null;
  if(!pkg||pkg.status==='superseded'||pkg.revision!==s.packageRevision||pkg.source_hash!==s.sourceHash||pkg.authorization_id!==s.parentAuthorizationId||JSON.parse(pkg.account_map)[s.rule.accountRef]!==book.account_id||digestCanonical(manifest?.replyPlaybooks.find(r=>r.id===s.rule.id)??null)!==digestCanonical(s.rule))return 'reply_package_changed';
  const parent=db.prepare('SELECT decision FROM approvals WHERE id=? AND workspace_id=?').get<{decision:string}>(s.parentAuthorizationId,book.workspace_id);
  return !parent||['rejected','revoked','expired'].includes(parent.decision)?'reply_parent_stopped':null;
 } catch { return 'reply_scope_invalid'; }
}
export function approvedReplyScope(db:SqlDatabase,book:ReplyPlaybookRow,now:number):ReplyScope|null {
 const approval=db.prepare('SELECT decision,preview FROM approvals WHERE id=? AND workspace_id=?').get<{decision:string;preview:string}>(book.authorization_id,book.workspace_id);
 return book.enabled&&approval?.decision==='approved'&&!replyScopeIssue(db,book,now)?(JSON.parse(approval.preview) as {summary:ReplyScope}).summary:null;
}
