import { digestCanonical, type SqlDatabase } from '@splitin/outreach-contracts';
import type { ActionRow } from '../execution/types';
export function replyAccountIdentity(db:SqlDatabase,workspaceId:string,accountId:string|null):string {
 const account=db.prepare('SELECT provider,external_account_id,sender_identity FROM provider_accounts WHERE workspace_id=? AND id=?').get<{provider:string;external_account_id:string;sender_identity:string}>(workspaceId,accountId);
 return digestCanonical(account?{...account,sender_identity:JSON.parse(account.sender_identity) as unknown}:null);
}
export function inboxReplyIssue(db:SqlDatabase,action:ActionRow):string|null {
 const p=JSON.parse(action.payload) as {_manualReplyThreadId?:string;_replyAccountIdentity?:string;threadId?:string;targetUrl?:string};if(!p._manualReplyThreadId)return null;
 const thread=db.prepare('SELECT account_id,native_id,peer_url FROM inbox_threads WHERE workspace_id=? AND id=?').get<{account_id:string;native_id:string;peer_url:string}>(action.workspace_id,p._manualReplyThreadId);
 return !thread||thread.account_id!==action.provider_account_id||thread.native_id!==p.threadId||thread.peer_url!==p.targetUrl||action.recipient_norm!==p.targetUrl?.toLowerCase()||replyAccountIdentity(db,action.workspace_id,action.provider_account_id)!==p._replyAccountIdentity?'manual_reply_thread_or_recipient_changed':null;
}
