import { ulid } from '@splitin/outreach-contracts';
import { audit, ConflictError, NotFoundError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import type { ActionRow } from '../execution/types';
import { scheduleAction } from './scheduled-management';
import { createPlanAuthorization } from './cloud-plans';
import { newPlanPolicy } from './workspace-policy';
import { replyAccountIdentity } from './inbox-reply-scope';
import { isSuppressed } from './suppressions';
import { accountLifecycle } from './account-lifecycle';
interface Thread {id:string;account_id:string;native_id:string;peer_url:string;contact_id:string|null}
function threadFor(env:DomainEnv,ctx:AuthContext,id:string):Thread {
 requireRole(ctx,'viewer');const thread=env.db.prepare('SELECT id,account_id,native_id,peer_url,contact_id FROM inbox_threads WHERE workspace_id=? AND id=?').get<Thread>(ctx.workspaceId,id);if(!thread)throw new NotFoundError('conversation');return thread;
}
export function listInboxReplies(env:DomainEnv,ctx:AuthContext,id:string){
 threadFor(env,ctx,id);return env.db.prepare("SELECT a.*,p.manifest_hash FROM scheduled_actions a JOIN plan_authorizations p ON p.id=a.approval_id WHERE a.workspace_id=? AND json_extract(a.payload,'$._manualReplyThreadId')=? ORDER BY a.created_at DESC,a.id DESC LIMIT 100").all<ActionRow&{manifest_hash:string}>(ctx.workspaceId,id).map(a=>{
  const payload=JSON.parse(a.payload) as {channel:string;text:string;targetUrl:string;threadId:string};const attempts=env.db.prepare('SELECT attempt_no,outcome,receipt,error_class,finished_at FROM action_attempts WHERE action_id=? ORDER BY attempt_no').all<{attempt_no:number;outcome:string;receipt:string|null;error_class:string|null;finished_at:number|null}>(a.id).map(r=>({...r,receipt:r.receipt?JSON.parse(r.receipt) as unknown:null}));
  return {id:a.id,state:a.state,reason:a.state_reason,accountId:a.provider_account_id,dueAt:a.due_at,authorizationId:a.approval_id,operationHash:a.manifest_hash,review:{accountId:a.provider_account_id,channel:payload.channel,peerUrl:payload.targetUrl,nativeThreadId:payload.threadId,text:payload.text},attempts};
 });
}
export function prepareInboxReply(env:DomainEnv,ctx:AuthContext,id:string,input:{text:string;idempotencyKey?:string}){
 requireRole(ctx,'operator');return env.db.transaction(()=>{
  const thread=threadFor(env,ctx,id);const account=env.db.prepare('SELECT capabilities,health FROM provider_accounts WHERE workspace_id=? AND id=?').get<{capabilities:string;health:string}>(ctx.workspaceId,thread.account_id);if(!account)throw new NotFoundError('account');
  const lifecycle=accountLifecycle(env,ctx.workspaceId,thread.account_id);if(lifecycle)throw new ConflictError('This account is '+lifecycle.status+'; reconnect it before preparing a response.');
  const caps=JSON.parse(account.capabilities) as {socialChannels?:string[];socialMessage?:boolean};const channel=caps.socialChannels?.[0];const url=new URL(thread.peer_url);
  if(!['linkedin','instagram'].includes(channel??'')||!caps.socialMessage||url.protocol!=='https:'||url.username||url.password||!(channel==='linkedin'?/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/$/:/^https:\/\/www\.instagram\.com\/[^/?#]+\/$/).test(thread.peer_url))throw new ConflictError('Manual replies require a verified LinkedIn personal or Instagram conversation. Mailbox sending stays in its supported draft workflow.');
  if(account.health!=='ok')throw new ConflictError('Reconnect this account before preparing a response.');
  if((!thread.native_id||thread.native_id.length>500||/[/?#\\\s]/.test(thread.native_id)||[...thread.native_id].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))||!input.text.trim()||input.text.length>(channel==='instagram'?1000:3000))throw new ConflictError('Enter a response within this platform limit and verify the native thread.');
  if(isSuppressed(env.db,ctx.workspaceId,thread.peer_url,thread.account_id,channel))throw new ConflictError('This recipient is suppressed.');
  const last=env.db.prepare('SELECT text FROM inbox_messages WHERE thread_id=? AND inbound=1 ORDER BY at DESC,id DESC LIMIT 1').get<{text:string}>(id);if(last&&/\b(unsubscribe|remove me|do not contact|stop messaging)\b|^\s*stop[.!\s]*$/i.test(last.text))throw new ConflictError('This conversation contains an opt-out.');
  const key=input.idempotencyKey??ulid(env.now());if(!/^[A-Za-z0-9_-]{1,100}$/.test(key))throw new ConflictError('Invalid reply request key.');const existing=env.db.prepare('SELECT id,payload FROM scheduled_actions WHERE workspace_id=? AND idempotency_key=?').get<{id:string;payload:string}>(ctx.workspaceId,`manual-reply:${id}:${key}`);
  if(existing){if((JSON.parse(existing.payload) as {text:string}).text!==input.text)throw new ConflictError('This reply request key already contains different content.');return listInboxReplies(env,ctx,id).find(a=>a.id===existing.id)!;}
  const {actionId}=scheduleAction(env,ctx,{kind:'social.message',providerAccountId:thread.account_id,payload:{channel,text:input.text,targetUrl:thread.peer_url,threadId:thread.native_id,_manualReplyThreadId:id,_contactId:thread.contact_id,_replyAccountIdentity:replyAccountIdentity(env.db,ctx.workspaceId,thread.account_id)},policy:newPlanPolicy(env,ctx,'UTC'),idempotencyKey:`manual-reply:${id}:${key}`});
  const action=env.db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=? AND id=?').get<ActionRow>(ctx.workspaceId,actionId)!;createPlanAuthorization(env,ctx,'inbox-reply:'+id,[action],{kind:'manual_inbox_reply',threadId:id,accountId:thread.account_id,peerUrl:thread.peer_url,nativeThreadId:thread.native_id,text:input.text});audit(env.db,ctx,env.now(),'inbox_reply',action.id,'prepared',{threadId:id});return listInboxReplies(env,ctx,id).find(a=>a.id===action.id)!;
 });
}
