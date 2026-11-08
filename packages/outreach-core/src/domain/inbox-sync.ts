import { CANCELLABLE_ACTION_STATES,digestCanonical,ulid,type SocialConversation } from '@splitin/outreach-contracts';
import type { DomainEnv } from './env';
import { providerContext } from '../execution/invoke';
import { transitionAction,type Actor } from '../execution/actions-repo';
import { enqueueAction } from '../execution/enqueue';
import type { ActionRow,AccountRow } from '../execution/types';
import { attachPlanAction } from './cloud-plans';
import { addSuppression,isSuppressed } from './suppressions';
import { approvedReplyScope,type ReplyPlaybookRow } from './reply-playbook-scope';
import { inboxCursorState, storeInboxPage } from './inbox-coverage';
import { pollConnectionAcceptance } from './connection-polling';
import { accountLifecycle } from './account-lifecycle';
interface ThreadRow{id:string;contact_id:string|null;peer_url:string}
const normalized=(v:string)=>v.replace(/^mailto:/i,'').replace(/\/$/,'').toLowerCase();
const actor=(now:number):Actor=>({kind:'system',id:'inbox-sync',source:'worker',traceId:ulid(now)});
export function isInboxOptOut(text:string):boolean{return /\b(unsubscribe|remove me|do not contact|don['’]t contact|stop messaging|stop emailing)\b|^\s*stop[.!\s]*$/i.test(text);}
function contactFor(env:DomainEnv,workspace:string,peer:string):string|null{
 const key=normalized(peer);const found=env.db.prepare('SELECT contact_id FROM contact_points WHERE workspace_id=? AND value_norm IN (?,?,?)').get<{contact_id:string}>(workspace,key,key+'/',`mailto:${key}`);return found?.contact_id??null;
}
function stopContact(env:DomainEnv,workspace:string,contactId:string,at:number,optOut:boolean):void{
 const sequences=env.db.prepare("SELECT id,action_ids FROM outreach_sequences WHERE workspace_id=? AND contact_id=? AND state IN ('active','paused','awaiting_approval') AND created_at<=?").all<{id:string;action_ids:string}>(workspace,contactId,optOut?Number.MAX_SAFE_INTEGER:at);
 for(const seq of sequences){env.db.prepare("UPDATE outreach_sequences SET state='stopped',stop_reason=?,updated_at=? WHERE id=?").run(optOut?'opt_out':'inbound_reply',env.now(),seq.id);
  for(const id of JSON.parse(seq.action_ids) as string[]){const action=env.db.prepare('SELECT * FROM scheduled_actions WHERE id=? AND workspace_id=?').get<ActionRow>(id,workspace);if(action&&CANCELLABLE_ACTION_STATES.includes(action.state))transitionAction(env.db,action,'cancelled',env.now(),actor(env.now()),{state_reason:optOut?'contact_opt_out':'contact_replied',lease_owner:null,lease_expires_at:null});}
  env.db.prepare('INSERT OR IGNORE INTO sequence_events(id,sequence_id,kind,event_key,data,at) VALUES (?,?,?,?,?,?)').run(ulid(env.now()),seq.id,'stopped',`reply:${at}`,JSON.stringify({reason:optOut?'opt_out':'inbound_reply'}),env.now());
 }
 if(optOut){for(const point of env.db.prepare('SELECT value_norm FROM contact_points WHERE workspace_id=? AND contact_id=?').all<{value_norm:string}>(workspace,contactId))addSuppression(env.db,{workspaceId:workspace,scope:'global',value:point.value_norm,reason:'opt_out',source:'native_inbox'},env.now());
  for(const action of env.db.prepare("SELECT * FROM scheduled_actions WHERE workspace_id=? AND json_extract(payload,'$._contactId')=?").all<ActionRow>(workspace,contactId))if(CANCELLABLE_ACTION_STATES.includes(action.state))transitionAction(env.db,action,'cancelled',env.now(),actor(env.now()),{state_reason:'contact_opt_out',lease_owner:null,lease_expires_at:null});
 }
}
function scheduleReply(env:DomainEnv,account:AccountRow,thread:ThreadRow,threadNative:string,messageId:string,text:string,messageAt:number):void{
 if(!thread.contact_id||isInboxOptOut(text)||isSuppressed(env.db,account.workspace_id,thread.peer_url,account.id))return;
 const books=env.db.prepare('SELECT * FROM reply_playbooks WHERE workspace_id=? AND account_id=? AND enabled=1 AND valid_until>=?').all<ReplyPlaybookRow>(account.workspace_id,account.id,env.now());
 for(const book of books){if(env.db.prepare('SELECT message_id FROM reply_events WHERE message_id=? AND playbook_id=?').get(messageId,book.id))continue;const scope=approvedReplyScope(env.db,book,env.now());if(!scope||!text.toLocaleLowerCase().includes(scope.rule.contains.toLocaleLowerCase()))continue;const {rule,policy,bounds}=scope;
  const authorization=env.db.prepare('SELECT decided_at FROM approvals WHERE id=?').get<{decided_at:number|null}>(book.authorization_id);if(!authorization?.decided_at||messageAt<authorization.decided_at)continue;
  const count=env.db.prepare('SELECT COUNT(*) n,MAX(e.created_at) last FROM reply_events e JOIN inbox_messages m ON m.id=e.message_id JOIN inbox_threads t ON t.id=m.thread_id WHERE e.playbook_id=? AND t.contact_id=? AND e.action_id IS NOT NULL').get<{n:number;last:number|null}>(book.id,thread.contact_id)!;
  const anyLast=env.db.prepare('SELECT MAX(e.created_at) last FROM reply_events e JOIN inbox_messages m ON m.id=e.message_id JOIN inbox_threads t ON t.id=m.thread_id WHERE t.workspace_id=? AND t.contact_id=? AND e.action_id IS NOT NULL').get<{last:number|null}>(account.workspace_id,thread.contact_id);if(anyLast?.last!==null&&anyLast?.last!==undefined&&env.now()-anyLast.last<bounds.contactMinGapHours*3600000)continue;
  if(count.n>=rule.maxResponsesPerContact||count.last!==null&&env.now()-count.last<rule.minGapHours*3600000)continue;
  const social=rule.channel!=='email';const adapter=env.adapters.get(account.provider);if(social?!adapter?.social?.message:!adapter?.email)continue;
  const contactPoint=env.db.prepare('SELECT id FROM contact_points WHERE workspace_id=? AND contact_id=? AND value_norm IN (?,?,?)').get<{id:string}>(account.workspace_id,thread.contact_id,normalized(thread.peer_url),normalized(thread.peer_url)+'/',thread.peer_url);if(!social&&!contactPoint)continue;
  const payload={...(social?{channel:rule.channel,targetUrl:thread.peer_url,text:rule.text}:{from:JSON.parse(account.sender_identity),to:[{address:normalized(thread.peer_url)}],subject:rule.subject??'Re: Your message',text:rule.text,headers:{'Auto-Submitted':'auto-replied'},providerThreadId:threadNative}),_replyPlaybookId:book.id,_contactId:thread.contact_id,_replyRuleHash:digestCanonical(rule),_inboundMessageId:messageId,_policy:policy};
  const action=enqueueAction(env.db,{workspaceId:account.workspace_id,kind:social?'social.message':'email.reply',payload,providerAccountId:account.id,purpose:social?'social_messaging':'automated_outreach',contactPointId:contactPoint?.id,recipient:social?thread.peer_url:normalized(thread.peer_url),dueAt:env.now(),notAfter:Math.min(book.valid_until,env.now()+86400000),approvalId:book.authorization_id,idempotencyKey:`reply:${book.id}:${messageId}`},actor(env.now()),env.now()).action;
  attachPlanAction(env,book.authorization_id,action);
  env.db.prepare('INSERT INTO reply_events(message_id,playbook_id,action_id,created_at) VALUES (?,?,?,?)').run(messageId,book.id,action.id,env.now());
  break; // A single inbound event never triggers competing automatic replies.
 }
}
export function ingestConversation(env:DomainEnv,account:AccountRow,conversation:SocialConversation):void{
 env.db.transaction(()=>{
  const contact=contactFor(env,account.workspace_id,conversation.peerUrl);const id=ulid(env.now());
  const existing=env.db.prepare('SELECT peer_url,contact_id FROM inbox_threads WHERE account_id=? AND native_id=?').get<{peer_url:string;contact_id:string|null}>(account.id,conversation.threadId);if(existing&&(normalized(existing.peer_url)!==normalized(conversation.peerUrl)||existing.contact_id&&contact&&existing.contact_id!==contact))throw new Error('Inbox thread participant changed; monitoring held for review');
  env.db.prepare('INSERT INTO inbox_threads(id,workspace_id,account_id,native_id,peer_url,subject,contact_id,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,native_id) DO UPDATE SET peer_url=excluded.peer_url,subject=excluded.subject,contact_id=COALESCE(inbox_threads.contact_id,excluded.contact_id),updated_at=MAX(inbox_threads.updated_at,excluded.updated_at)').run(id,account.workspace_id,account.id,conversation.threadId,conversation.peerUrl,conversation.subject??'',contact,conversation.updatedAt);
  const thread=env.db.prepare('SELECT id,contact_id,peer_url FROM inbox_threads WHERE account_id=? AND native_id=?').get<ThreadRow>(account.id,conversation.threadId)!;
  for(const message of [...conversation.messages].sort((a,b)=>a.at-b.at)){
   if(!message.id||!Number.isFinite(message.at)||message.at>env.now()+300000)throw new Error('Native inbox message has invalid timestamp or identifier');
   if(env.db.prepare('SELECT id FROM inbox_messages WHERE thread_id=? AND native_id=?').get(thread.id,message.id))continue;
   const messageId=ulid(env.now());env.db.prepare('INSERT INTO inbox_messages(id,thread_id,native_id,text,inbound,at) VALUES (?,?,?,?,?,?)').run(messageId,thread.id,message.id,message.text.slice(0,10000),message.inbound?1:0,message.at);
   if(message.inbound&&thread.contact_id){const optOut=isInboxOptOut(message.text);stopContact(env,account.workspace_id,thread.contact_id,message.at,optOut);if(!optOut)scheduleReply(env,account,thread,conversation.threadId,messageId,message.text,message.at);}
  }
 });
}
export async function pollSocialInboxes(env:DomainEnv):Promise<void>{
 const deadline=Date.now()+60000;const rows=env.db.prepare("SELECT p.* FROM provider_accounts p LEFT JOIN inbox_cursors c ON c.account_id=p.id WHERE p.health='ok' ORDER BY COALESCE(c.polled_at,0),p.id").all<AccountRow>();let polled=0;
 for(const account of rows){if(polled>=4||Date.now()>deadline)break;if(accountLifecycle(env,account.workspace_id,account.id))continue;const adapter=env.adapters.get(account.provider);const caps=JSON.parse(account.capabilities) as {socialMessage?:boolean};const reader=adapter?.inbox?.listThreads??(caps.socialMessage?adapter?.social?.conversations:undefined);if(!reader)continue;
  const cursor=env.db.prepare('SELECT cursor,polled_at FROM inbox_cursors WHERE account_id=?').get<{cursor:string|null;polled_at:number}>(account.id);if(cursor&&env.now()-cursor.polled_at<30000)continue;polled++;
  try{const context=providerContext(env.exec,account,ulid(env.now()),AbortSignal.timeout(20000));const page=await reader(context,inboxCursorState(cursor?.cursor).providerCursor||undefined);
   for(const thread of page.threads)ingestConversation(env,account,thread);
   storeInboxPage(env.db,account.id,page,env.now());
  }catch{env.db.prepare('INSERT INTO inbox_cursors(account_id,polled_at,error) VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET polled_at=excluded.polled_at,error=excluded.error').run(account.id,env.now(),'Inbox synchronization failed; check connection and permissions');}
 }
 await pollConnectionAcceptance(env,deadline);
}
