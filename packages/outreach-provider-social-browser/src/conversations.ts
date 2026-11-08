import type { ProviderContext, SocialConversation, InboxPage } from '@splitin/outreach-contracts';
import type { Page } from 'playwright';
import type { AccountBinding } from './runtime';
import type { SocialSession } from './session';
import { canonicalSocialProfile } from './platforms';
import { networkReady, type NetworkOptions } from './network-publish';
import { linkedInReady, type LinkedInOptions } from './linkedin';
import { scanConversationLinks, scrollConversationHistory } from './conversation-scroll';

export function conversationCursor(value: string | null | undefined): number {
  if (!value) return 0; const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid conversation cursor'); return n;
}
const canonical = (url: string, channel: string) => { const p=canonicalSocialProfile(url);if(p.channel!==channel)throw new Error('Conversation participant is on the wrong platform');return p.url; };
export function instagramThreads(body: unknown, expectedUser: string): SocialConversation[] {
  if(!body||typeof body!=='object')return[];
  const inbox=(body as {inbox?:{threads?:unknown[]};threads?:unknown[]}).inbox;
  const threads=inbox?.threads??(body as {threads?:unknown[]}).threads;
  if(!Array.isArray(threads))return[];
  return threads.flatMap(value=>{
    const t=value as {thread_id?:string;users?:{pk?:string|number;username?:string}[];items?:{item_id?:string;text?:string;user_id?:string|number;timestamp?:string|number;item_type?:string}[]};
    const peers=t.users?.filter(u=>u.username?.toLowerCase()!==expectedUser.toLowerCase());
    if(peers&&peers.length>1)return[];
    if(!t.thread_id||peers?.length!==1||!peers[0]?.username||!peers[0].pk)throw new Error('Inbox conversation peer identifier is unavailable');
    const peer=peers[0];const messages=(t.items??[]).flatMap(m=>{
      const at=Number(m.timestamp);if(!m.item_id||!Number.isFinite(at)||!m.user_id)throw new Error('Inbox native message identifier is unavailable');
      return[{id:String(m.item_id),text:(m.text??`[Instagram ${m.item_type??'message'}]`).slice(0,10000),inbound:String(m.user_id)===String(peer.pk),at:Math.round(at>1e14?at/1000:at)}];
    });
    if(!messages.length)return[];
    return[{threadId:String(t.thread_id),peerUrl:canonical(`https://www.instagram.com/${peer.username}/`,'instagram'),messages,updatedAt:Math.max(...messages.map(m=>m.at))}];
  });
}
async function domThread(page:Page,channel:'linkedin'|'instagram',binding:AccountBinding):Promise<SocialConversation> {
  const peerSelector=binding.messageRecipientSelector??(channel==='linkedin'?'.msg-thread__topcard a[href*="/in/"], .msg-overlay-bubble-header a[href*="/in/"]':'header a[href], [data-conversation-peer]');
  const peer=await page.locator(peerSelector).first().getAttribute('href',{timeout:5000});
  if(!peer)throw new Error('Inbox conversation has no verified peer');
  const peerUrl=canonical(new URL(peer,channel==='linkedin'?'https://www.linkedin.com':'https://www.instagram.com').href,channel);
  const login=canonical(binding.loginProfileUrl??binding.expectedProfileUrl??'',channel);const participants=await page.locator(peerSelector).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')).filter((v):v is string=>Boolean(v)));const peers=new Set(participants.map(href=>canonical(new URL(href,channel==='linkedin'?'https://www.linkedin.com':'https://www.instagram.com').href,channel)).filter(url=>url!==login));if(peers.size!==1)throw new Error('Group or unverified conversation participants require manual review');
  const thread=page.locator('[data-conversation-id], [data-conversation-urn], [data-thread-id]').first();
  const threadId=await thread.getAttribute('data-conversation-id').catch(()=>null)??await thread.getAttribute('data-conversation-urn').catch(()=>null)??await thread.getAttribute('data-thread-id').catch(()=>null)??new URL(page.url()).pathname.match(/\/(?:t|thread)\/([^/]+)/)?.[1];
  if(!threadId)throw new Error('Inbox lacks a native conversation identifier');
  const rows=await page.locator('[data-message-id], [data-event-urn], [data-item-id]').evaluateAll(nodes=>nodes.map(row=>({id:row.getAttribute('data-message-id')??row.getAttribute('data-event-urn')??row.getAttribute('data-item-id'),sender:row.getAttribute('data-sender-profile-url')??row.querySelector('a[href*="/in/"],a[data-sender-profile]')?.getAttribute('href'),timestamp:row.getAttribute('data-timestamp')??row.querySelector('time[datetime]')?.getAttribute('datetime'),text:row.querySelector('[data-message-text],.msg-s-event-listitem__body')?.textContent??row.textContent??''})));
  const messages:SocialConversation['messages'][number][]=[];
  for(const {id,sender,timestamp,text}of rows){
    const at=timestamp?(/^\d+$/.test(timestamp)?Number(timestamp):Date.parse(timestamp)):NaN;
    if(!id||!sender||!Number.isFinite(at))throw new Error('Inbox message identity or timestamp is unavailable; monitoring held');
    const senderUrl=canonical(new URL(sender,channel==='linkedin'?'https://www.linkedin.com':'https://www.instagram.com').href,channel);
    if(senderUrl!==peerUrl&&senderUrl!==login)throw new Error('Inbox message author is outside the bound conversation');
    messages.push({id,text:text.slice(0,10000),inbound:senderUrl===peerUrl,at});
  }
  return{threadId,peerUrl,messages,updatedAt:messages.length?Math.max(...messages.map(m=>m.at)):0};
}
interface Continuation {version:2;channel:string;folder:number;folderPaths:string[];offset:number;seen:string[];queue:string[];listDone:boolean;listRounds:number;history:Record<string,number>;folders:string[];maxAt:number;skippedGroup:boolean}
function continuation(value:string|null|undefined,channel:string):Continuation {
 const empty:Continuation={version:2,channel,folder:0,folderPaths:channel==='instagram'?['/direct/inbox/','/direct/requests/']:['/messaging/'],offset:0,seen:[],queue:[],listDone:false,listRounds:8,history:{},folders:[],maxAt:0,skippedGroup:false};if(!value)return empty;
 if(/^\d+$/.test(value))return{...empty,maxAt:conversationCursor(value)};
 let s:Continuation;try{s=JSON.parse(value) as Continuation;}catch{throw new Error('Invalid conversation continuation');}
 if(s.version!==2||s.channel!==channel||!Number.isSafeInteger(s.folder)||s.folder<0||!Number.isFinite(s.offset)||s.offset<0||!Array.isArray(s.seen)||!Array.isArray(s.queue)||s.seen.length>10000||s.queue.length>10000||[...s.seen,...s.queue].some(v=>typeof v!=='string'||!/^\/(?:direct\/t|messaging\/thread)\/[^/?#]+\/?$/.test(v)))throw new Error('Invalid conversation continuation');
 if(!Array.isArray(s.folderPaths)||s.folderPaths.length>20||s.folderPaths.some(path=>!['@general','@hidden','/direct/inbox/','/direct/requests/','/messaging/'].includes(path)&&!/^\/direct\/requests\/[A-Za-z0-9_/-]+\/?$/.test(path)))throw new Error('Invalid conversation folder continuation');
 return s.folder>=s.folderPaths.length?{...empty,maxAt:s.maxAt,skippedGroup:s.skippedGroup}:s;
}
function folderControl(page:Page,name:string){return page.getByRole('button',{name,exact:true}).or(page.getByRole('tab',{name,exact:true})).or(page.locator('a[href*="/direct/inbox"],a[href*="/direct/requests"]').filter({hasText:new RegExp('^'+name+'$','i')}));}
export async function readConversations(session:SocialSession,ctx:ProviderContext,binding:AccountBinding,channel:'linkedin'|'instagram',options:LinkedInOptions|NetworkOptions,cursor?:string|null):Promise<InboxPage> {
 const state=continuation(cursor,channel);const folderName=(path:string)=>path==='@general'?'general':path==='@hidden'||/hidden/.test(path)?'hidden_requests':path.includes('/requests/')?'requests':'inbox';return session.withPage(ctx.signal,async page=>{
  const collected:SocialConversation[]=[];const pending:Promise<void>[]=[];let parseFailed=false;let nativeHasMore:boolean|undefined;const expected=new URL(binding.loginProfileUrl??binding.expectedProfileUrl??'').pathname.split('/')[1]??'';
  const listener=(r:import('playwright').Response)=>{if(channel==='instagram'&&/direct_v2\/(?:inbox|pending_inbox|threads)/.test(r.url())&&r.ok())pending.push(r.json().then(data=>{collected.push(...instagramThreads(data,expected));const body=data as {inbox?:{has_older?:boolean;threads?:{users?:{username?:string}[]}[]};threads?:{users?:{username?:string}[]}[]};const native=body.inbox?.threads??body.threads;state.skippedGroup ||= Array.isArray(native)&&native.some(t=>(t.users??[]).filter(u=>u.username?.toLowerCase()!==expected.toLowerCase()).length>1);if(typeof body.inbox?.has_older==='boolean')nativeHasMore=body.inbox.has_older;}).catch(()=>{parseFailed=true;}));};page.on('response',listener);
  try{
   if(channel==='linkedin')await linkedInReady(page,binding,options);else await networkReady(page,binding,'instagram',options);
   const path=state.folderPaths[state.folder]!;await page.goto(`${options.origin}${path==='@general'?'/direct/inbox/':path==='@hidden'?'/direct/requests/':path}`,{waitUntil:'domcontentloaded'});if(new URL(page.url()).origin!==options.origin)throw new Error('Inbox left its bound origin');
   if(path==='@general'||path==='@hidden'){await folderControl(page,path==='@general'?'General':'Hidden requests').first().click();if(new URL(page.url()).origin!==options.origin)throw new Error('Inbox folder left its bound origin');}
   if(channel==='instagram'){for(const href of await page.locator('a[href*="/direct/requests/"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')).filter((v):v is string=>Boolean(v)))){const link=new URL(href,options.origin);if(link.origin===options.origin&&/^\/direct\/requests\/[A-Za-z0-9_/-]+\/?$/.test(link.pathname)&&!state.folderPaths.includes(link.pathname))state.folderPaths.push(link.pathname);}for(const [label,token]of [['General','@general'],['Hidden requests','@hidden']]as const)if(await folderControl(page,label).count()&&!state.folderPaths.includes(token)&&!(token==='@hidden'&&state.folderPaths.some(p=>p.includes('/hidden'))))state.folderPaths.push(token);}
   if(!state.listDone){const scan=await scanConversationLinks(page,channel,state.offset,options.origin,state.seen,state.listRounds);await Promise.all(pending);if(parseFailed)throw new Error('Inbox response identifiers could not be verified; monitoring held');
    const links=[...scan.links,...collected.map(t=>channel==='instagram'?'/direct/t/'+encodeURIComponent(t.threadId)+'/':'/messaging/thread/'+encodeURIComponent(t.threadId)+'/')];for(const href of new Set(links))if(!state.seen.includes(href)){state.seen.push(href);state.queue.push(href);}state.offset=scan.offset;state.listDone=scan.complete&&nativeHasMore!==true;if(!state.listDone)state.listRounds=(state.listRounds??8)+8;
   }
   const deadline=Date.now()+8000;let processed=0;let historyPending=false;
   while(state.queue.length&&processed<12&&Date.now()<deadline){const href=state.queue.shift()!;const url=new URL(href,options.origin);if(url.origin!==options.origin)throw new Error('Conversation continuation left its bound origin');await page.goto(url.href,{waitUntil:'domcontentloaded'});const rounds=state.history[href]??6;const complete=await scrollConversationHistory(page,rounds,deadline);collected.push(await domThread(page,channel,binding));processed++;
    if(!complete){state.history[href]=rounds+6;state.queue.unshift(href);historyPending=true;break;}delete state.history[href];
   }
   if(state.listDone&&!state.queue.length){state.folders.push(folderName(state.folderPaths[state.folder]!));state.folder++;state.offset=0;state.seen=[];state.listDone=false;state.listRounds=8;}
   const unique=new Map<string,SocialConversation>();for(const t of collected){const prior=unique.get(t.threadId);unique.set(t.threadId,prior?{...t,messages:[...new Map([...prior.messages,...t.messages].map(m=>[m.id,m])).values()],updatedAt:Math.max(prior.updatedAt,t.updatedAt)}:t);}state.maxAt=Math.max(state.maxAt,...[...unique.values()].map(t=>t.updatedAt),0);
   const complete=!state.skippedGroup&&state.folder>=state.folderPaths.length;return{threads:[...unique.values()],nextCursor:JSON.stringify(state),coverage:{complete,folders:[...state.folders],...(!complete?{reason:state.skippedGroup?'Multi-participant conversations require manual review; automatic follow-ups remain held.':historyPending?'Older message history is still being backfilled.':`Native ${folderName(state.folderPaths[state.folder]!)} inbox continuation is pending.`}:{})}};
  }finally{page.off('response',listener);}
 });
}
