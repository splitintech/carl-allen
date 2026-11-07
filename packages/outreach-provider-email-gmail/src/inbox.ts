import { plainMailText } from '@splitin/outreach-provider-kit';
import type { AccessTokenSource, ConversationInbox, ProviderContext, SocialConversation } from '@splitin/outreach-contracts';
import { gmailRequest,type HttpDeps } from './http';
interface Part{mimeType?:string;body?:{data?:string};parts?:Part[];headers?:{name:string;value:string}[]}
interface Message{id:string;internalDate?:string;snippet?:string;payload?:Part;labelIds?:string[]}
const address=(value:string)=>{const match=value.match(/<([^<>]+)>/);return(match?.[1]??value).trim().toLowerCase();};
const text=(p:Part):string=>p.body?.data&&['text/plain','text/html'].includes(p.mimeType??'')?plainMailText(Buffer.from(p.body.data,'base64url').toString('utf8'),p.mimeType==='text/plain'?'text':'html'):(p.parts??[]).map(text).filter(Boolean).join('\n');
export function gmailInbox(http:HttpDeps,tokens:AccessTokenSource):ConversationInbox{
  const get=async(ctx:ProviderContext,path:string)=>{const result=await gmailRequest(http,ctx,await tokens.get(ctx),'GET',path);if(result.status===401)tokens.invalidate(ctx);if(result.status!==200)throw new Error(`Gmail inbox synchronization failed (HTTP ${result.status})`);return result.body;};
  return{async listThreads(ctx,cursor){
    let state:{since:number;page?:string;maximum?:number}={since:0};if(cursor){try{state=JSON.parse(Buffer.from(cursor,'base64url').toString()) as typeof state;}catch{throw new Error('Invalid Gmail inbox cursor');}}
    if(!Number.isSafeInteger(state.since)||state.since<0||state.page&&state.page.length>4096)throw new Error('Invalid Gmail inbox cursor');
    const q=`-in:drafts after:${Math.max(0,Math.floor((state.since-120000)/1000))}`;
    const page=await get(ctx,`/gmail/v1/users/me/threads?maxResults=50&q=${encodeURIComponent(q)}${state.page?`&pageToken=${encodeURIComponent(state.page)}`:''}`);const threads:SocialConversation[]=[];let maximum=state.maximum??state.since;
    for(const row of(page.threads??[]) as {id:string}[]){
      const value=await get(ctx,`/gmail/v1/users/me/threads/${encodeURIComponent(row.id)}?format=full`);const messages=(value.messages??[]) as Message[];
      const participants=new Set(messages.flatMap(m=>(m.payload?.headers??[]).filter(h=>['from','to','cc'].includes(h.name.toLowerCase())).flatMap(h=>h.value.split(',').map(address))).filter(a=>a&&a!==ctx.account.sender.address.toLowerCase()));if(participants.size!==1)continue;
      const incoming=messages.filter(m=>address(m.payload?.headers?.find(h=>h.name.toLowerCase()==='from')?.value??'')!==ctx.account.sender.address.toLowerCase());
      const last=incoming.at(-1)??messages.at(-1);if(!last)continue;const header=(m:Message,name:string)=>m.payload?.headers?.find(h=>h.name.toLowerCase()===name)?.value??'';
      const peer=address(incoming.length?header(last,'from'):header(last,'to').split(',')[0]??'');if(!peer.includes('@'))continue;
      const native=messages.filter(m=>!m.labelIds?.includes('DRAFT')).map(m=>({id:m.id,text:(text(m.payload??{})||m.snippet||'').slice(0,10000),inbound:address(header(m,'from'))!==ctx.account.sender.address.toLowerCase(),at:Number(m.internalDate??0)})).filter(m=>m.id&&Number.isFinite(m.at));
      if(!native.length)continue;const updatedAt=Math.max(...native.map(m=>m.at));maximum=Math.max(maximum,updatedAt);threads.push({threadId:row.id,peerUrl:`mailto:${peer}`,subject:header(last,'subject'),messages:native,updatedAt});
    }
    const next=typeof page.nextPageToken==='string'?{...state,page:page.nextPageToken,maximum}:{since:Math.max(state.since,maximum-120000)};
    return{threads,nextCursor:Buffer.from(JSON.stringify(next)).toString('base64url')};
  }};
}
