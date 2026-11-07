import { plainMailText } from '@splitin/outreach-provider-kit';
import type { AccessTokenSource, ConversationInbox, SocialConversation } from '@splitin/outreach-contracts';
import { graphGet,type HttpDeps } from './graph';
interface Message{id:string;conversationId?:string;subject?:string;from?:{emailAddress?:{address?:string}};toRecipients?:{emailAddress?:{address?:string}}[];ccRecipients?:{emailAddress?:{address?:string}}[];bodyPreview?:string;body?:{content?:string;contentType?:string};receivedDateTime?:string;sentDateTime?:string;isDraft?:boolean}
export function outlookInbox(http:HttpDeps,tokens:AccessTokenSource):ConversationInbox{return{async listThreads(ctx,cursor){
 let state:{since:number;next?:string;maximum?:number}={since:0};if(cursor){try{state=JSON.parse(Buffer.from(cursor,'base64url').toString()) as typeof state;}catch{throw new Error('Invalid Outlook inbox cursor');}}
 if(!Number.isSafeInteger(state.since)||state.since<0||state.next&&state.next.length>8192)throw new Error('Invalid Outlook inbox cursor');
 const select='id,conversationId,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,sentDateTime,isDraft';
 const result=await graphGet(http,ctx,await tokens.get(ctx),state.next??'/me/messages',state.next?undefined:{$top:'50',$select:select,$filter:`isDraft eq false and receivedDateTime ge ${new Date(Math.max(0,state.since-120000)).toISOString()}`,$orderby:'receivedDateTime asc'});
 if(result.status===401)tokens.invalidate(ctx);if(result.status!==200)throw new Error(`Outlook inbox synchronization failed (HTTP ${result.status})`);
 const grouped=new Map<string,SocialConversation>();let maximum=state.maximum??state.since;
 for(const m of(result.body.value??[]) as Message[]){if(m.isDraft||!m.id)continue;const sender=m.from?.emailAddress?.address?.toLowerCase();if(!sender)continue;const participants=new Set([sender,...(m.toRecipients??[]).map(r=>r.emailAddress?.address?.toLowerCase()),...(m.ccRecipients??[]).map(r=>r.emailAddress?.address?.toLowerCase())].filter(a=>a&&a!==ctx.account.sender.address.toLowerCase()));if(participants.size!==1)continue;const inbound=sender!==ctx.account.sender.address.toLowerCase();const peer=inbound?sender:m.toRecipients?.[0]?.emailAddress?.address?.toLowerCase();const at=Date.parse(m.receivedDateTime??m.sentDateTime??'');if(!peer||!Number.isFinite(at))continue;
  const id=m.conversationId??m.id;const old=grouped.get(id);const message={id:m.id,text:m.body?.content?plainMailText(m.body.content,m.body.contentType??'html'):(m.bodyPreview??'').slice(0,10000),inbound,at};if(old&&old.peerUrl!==`mailto:${peer}`)throw new Error('Outlook conversation has multiple participants; monitoring held');if(old){grouped.set(id,{...old,messages:[...old.messages,message],updatedAt:Math.max(old.updatedAt,at)});}else grouped.set(id,{threadId:id,peerUrl:`mailto:${peer}`,subject:m.subject??'',messages:[message],updatedAt:at});maximum=Math.max(maximum,at);
 }
 const next=typeof result.body['@odata.nextLink']==='string'?{...state,next:result.body['@odata.nextLink'],maximum}:{since:Math.max(state.since,maximum-120000)};
 return{threads:[...grouped.values()],nextCursor:Buffer.from(JSON.stringify(next)).toString('base64url')};
}};}
