import type { ProviderContext, SocialConversation } from '@splitin/outreach-contracts';
import type { Page } from 'playwright';
import type { AccountBinding } from './runtime';
import type { SocialSession } from './session';
import { canonicalSocialProfile } from './platforms';
import { networkReady, type NetworkOptions } from './network-publish';
import { linkedInReady, type LinkedInOptions } from './linkedin';

export function conversationCursor(value: string | null | undefined): number {
  if (!value) return 0; const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid conversation cursor'); return n;
}
const canonical = (url: string, channel: string) => { const p=canonicalSocialProfile(url);if(p.channel!==channel)throw new Error('Conversation participant is on the wrong platform');return p.url; };
export function instagramThreads(body: unknown, expectedUser: string): SocialConversation[] {
  if(!body||typeof body!=='object')return[];
  const inbox=(body as {inbox?:{threads?:unknown[]};threads?:unknown[]}).inbox;
  const threads=inbox?.threads??(body as {threads?:unknown[]}).threads;
  if(!Array.isArray(threads))return[];
  return threads.slice(0,50).flatMap(value=>{
    const t=value as {thread_id?:string;users?:{pk?:string|number;username?:string}[];items?:{item_id?:string;text?:string;user_id?:string|number;timestamp?:string|number;item_type?:string}[]};
    const peers=t.users?.filter(u=>u.username?.toLowerCase()!==expectedUser.toLowerCase());
    if(peers&&peers.length>1)return[];
    if(!t.thread_id||peers?.length!==1||!peers[0]?.username||!peers[0].pk)throw new Error('Inbox conversation peer identifier is unavailable');
    const peer=peers[0];const messages=(t.items??[]).slice(0,100).flatMap(m=>{
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
  const thread=page.locator('[data-conversation-id], [data-conversation-urn], [data-thread-id]').first();
  const threadId=await thread.getAttribute('data-conversation-id').catch(()=>null)??await thread.getAttribute('data-conversation-urn').catch(()=>null)??await thread.getAttribute('data-thread-id').catch(()=>null)??new URL(page.url()).pathname.match(/\/(?:t|thread)\/([^/]+)/)?.[1];
  if(!threadId)throw new Error('Inbox lacks a native conversation identifier');
  const rows=page.locator('[data-message-id], [data-event-urn], [data-item-id]');const messages:SocialConversation['messages'][number][]=[];
  for(let i=0;i<Math.min(await rows.count(),100);i++){
    const row=rows.nth(i);const id=await row.getAttribute('data-message-id')??await row.getAttribute('data-event-urn')??await row.getAttribute('data-item-id');
    const sender=await row.getAttribute('data-sender-profile-url')??await row.locator('a[href*="/in/"],a[data-sender-profile]').first().getAttribute('href').catch(()=>null);
    const timestamp=await row.getAttribute('data-timestamp')??await row.locator('time[datetime]').first().getAttribute('datetime').catch(()=>null);
    const at=timestamp?(/^\d+$/.test(timestamp)?Number(timestamp):Date.parse(timestamp)):NaN;
    if(!id||!sender||!Number.isFinite(at))throw new Error('Inbox message identity or timestamp is unavailable; monitoring held');
    const senderUrl=canonical(new URL(sender,channel==='linkedin'?'https://www.linkedin.com':'https://www.instagram.com').href,channel);
    const login=canonical(binding.loginProfileUrl??binding.expectedProfileUrl??'',channel);
    if(senderUrl!==peerUrl&&senderUrl!==login)throw new Error('Inbox message author is outside the bound conversation');
    const text=await row.locator('[data-message-text],.msg-s-event-listitem__body').first().textContent().catch(()=>null)??await row.textContent()??'';
    messages.push({id,text:text.slice(0,10000),inbound:senderUrl===peerUrl,at});
  }
  return{threadId,peerUrl,messages,updatedAt:messages.length?Math.max(...messages.map(m=>m.at)):0};
}
export async function readConversations(session:SocialSession,ctx:ProviderContext,binding:AccountBinding,channel:'linkedin'|'instagram',options:LinkedInOptions|NetworkOptions,cursor?:string|null):Promise<{threads:SocialConversation[];nextCursor:string}> {
  const since=conversationCursor(cursor);return session.withPage(ctx.signal,async page=>{
    const collected:SocialConversation[]=[];const pending:Promise<void>[]=[];let parseFailed=false;
    const listener=(r:import('playwright').Response)=>{if(channel==='instagram'&&/direct_v2\/(?:inbox|threads)/.test(r.url())&&r.ok())pending.push(r.json().then(data=>{collected.push(...instagramThreads(data,new URL(binding.loginProfileUrl??binding.expectedProfileUrl??'').pathname.split('/')[1]??''));}).catch(()=>{parseFailed=true;}));};
    page.on('response',listener);
    if(channel==='linkedin')await linkedInReady(page,binding,options);else await networkReady(page,binding,'instagram',options);
    await page.goto(`${options.origin}${channel==='linkedin'?'/messaging/':'/direct/inbox/'}`,{waitUntil:'domcontentloaded'});
    if(new URL(page.url()).origin!==options.origin)throw new Error('Inbox left its bound origin');
    await page.waitForTimeout(250);await Promise.all(pending);if(parseFailed)throw new Error('Inbox response identifiers could not be verified; monitoring held');
    if(!collected.length){
      const links=await page.locator(channel==='linkedin'?'a[href*="/messaging/thread/"]':'a[href*="/direct/t/"]').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.getAttribute('href')).filter(Boolean))]);
      for(const href of links.slice(0,20)){const url=new URL(href!,options.origin);if(url.origin!==options.origin)continue;await page.goto(url.href,{waitUntil:'domcontentloaded'});collected.push(await domThread(page,channel,binding));}
      if(!links.length&&!await page.getByText(/No messages|Your messages|Send private photos and messages/i).count())throw new Error('Inbox layout or native identifiers unavailable; monitoring held');
    }
    page.off('response',listener);const unique=[...new Map(collected.map(t=>[t.threadId,t])).values()];
    return{threads:unique.filter(t=>t.updatedAt>=since),nextCursor:String(Math.max(since,...unique.map(t=>t.updatedAt),0))};
  });
}
