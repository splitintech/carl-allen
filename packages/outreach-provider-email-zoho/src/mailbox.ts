import { plainMailText } from '@splitin/outreach-provider-kit';
import type { ConversationInbox, ProviderContext, SocialConversation } from '@splitin/outreach-contracts';
import { numeric,zohoRequest,type ZohoHttp } from './http';
export interface ZohoMessage{messageId:string;folderId:string;threadId?:string;fromAddress:string;toAddress?:string;subject?:string;summary?:string;receivedTime?:number;receivedtime?:number;sentDateInGMT?:number;hasAttachment?:number;ccAddress?:string;bccAddress?:string;inReplyTo?:string;refHeader?:string}
export async function messageContent(http:ZohoHttp,ctx:ProviderContext,folder:string,id:string):Promise<string>{const account=numeric(await http.accountId(ctx));const value=await zohoRequest(http,ctx,'GET',`/api/accounts/${account}/folders/${numeric(folder)}/messages/${numeric(id)}/content`) as {content?:string};return value.content??'';}
export function zohoInbox(http:ZohoHttp):ConversationInbox{return{async listThreads(ctx,cursor){
  let state={since:0,before:ctx.now(),start:1};if(cursor){try{state=JSON.parse(Buffer.from(cursor,'base64url').toString()) as typeof state;}catch{throw new Error('Invalid Zoho inbox cursor');}}
  if(![state.since,state.before,state.start].every(Number.isSafeInteger)||state.start<1||state.start>100000)throw new Error('Invalid Zoho inbox cursor');
  const account=numeric(await http.accountId(ctx));const since=new Date(Math.max(0,state.since-120000));const search=`fromDate:${String(since.getUTCDate()).padStart(2,'0')}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][since.getUTCMonth()]}-${since.getUTCFullYear()}`;
  const value=await zohoRequest(http,ctx,'GET',`/api/accounts/${account}/messages/search?searchKey=${encodeURIComponent(search)}&receivedTime=${state.before}&start=${state.start}&limit=50&includeto=true`);
  if(!Array.isArray(value))throw new Error('Zoho inbox response is malformed');
  const threads:SocialConversation[]=value.flatMap(raw=>{const m=raw as ZohoMessage;const at=Number(m.receivedTime??m.receivedtime??m.sentDateInGMT);if(!m.messageId||!m.fromAddress||!Number.isFinite(at)||at<state.since-120000)return[];
    const inbound=m.fromAddress.toLowerCase()!==ctx.account.sender.address.toLowerCase();const peer=inbound?m.fromAddress:m.toAddress?.split(',')[0]?.trim();if(!peer||!peer.includes('@'))return[];
    return[{threadId:String(m.threadId||m.messageId),peerUrl:`mailto:${peer.toLowerCase()}`,subject:m.subject??'',messages:[{id:String(m.messageId),text:(m.summary??'').slice(0,10000),inbound,at}],updatedAt:at}];});
  for(const thread of threads){const row=value.find(raw=>String((raw as ZohoMessage).messageId)===thread.messages[0]!.id) as ZohoMessage;const content=await messageContent(http,ctx,String(row.folderId),String(row.messageId));(thread.messages as {text:string}[])[0]!.text=plainMailText(content);}
  const next=value.length===50?{...state,start:state.start+50}:{since:Math.max(state.since,state.before-120000),before:ctx.now(),start:1};
  return{threads,nextCursor:Buffer.from(JSON.stringify(next)).toString('base64url')};}};}
