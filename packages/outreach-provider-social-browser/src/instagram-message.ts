import type { ProviderContext, SendResult, SocialMessageInput } from '@splitin/outreach-contracts';
import type { Response } from 'playwright';
import type { SocialSession } from './session';
import type { AccountBinding } from './runtime';
import { canonicalSocialProfile } from './platforms';
import { networkReady, type NetworkOptions } from './network-publish';
import { preEffectFailure } from './linkedin';

function nativeId(body:unknown):string|undefined{
  if(!body||typeof body!=='object')return;
  for(const [key,value]of Object.entries(body)){if(['item_id','message_id'].includes(key)&&typeof value==='string'&&/^\d{8,}$/.test(value))return value;const nested=nativeId(value);if(nested)return nested;}
  return undefined;
}
export async function instagramMessage(session:SocialSession,ctx:ProviderContext,binding:AccountBinding,options:NetworkOptions,input:SocialMessageInput):Promise<SendResult>{
  let target:ReturnType<typeof canonicalSocialProfile>;
  try{target=canonicalSocialProfile(input.targetUrl);if(input.channel!=='instagram'||target.channel!=='instagram'||!input.text.trim()||input.text.length>1000)throw new Error('Instagram messaging requires a profile target and 1..1000 characters');}
  catch(error){return{kind:'rejected',errorClass:'unsupported',detail:(error as Error).message};}
  let crossed=false;let authenticated=false;let pageUrl:string|undefined;
  try{return await session.withPage(ctx.signal,async page=>{
    await networkReady(page,binding,'instagram',options);authenticated=true;
    await page.goto(`${options.origin}${new URL(target.url).pathname}`,{waitUntil:'domcontentloaded'});pageUrl=page.url();
    if(new URL(page.url()).origin!==options.origin)throw new Error('Profile left bound Instagram origin');
    await page.getByRole('button',{name:/^Message$/i}).or(page.getByRole('link',{name:/^Message$/i})).first().click();
    const recipient=await page.locator(binding.messageRecipientSelector??'header a[href], [data-conversation-peer]').first().getAttribute('href',{timeout:options.confirmationTimeoutMs??15000});
    if(!recipient||canonicalSocialProfile(new URL(recipient,'https://www.instagram.com').href).url!==target.url)throw new Error('Opened conversation recipient does not match approved Instagram target');
    const selector='[data-message-id], [data-item-id]';const before=await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-message-id')??n.getAttribute('data-item-id')));
    await page.getByRole('textbox').last().fill(input.text);
    const receipt:Promise<Response|null>=page.waitForResponse(r=>r.request().method()==='POST'&&/direct_v2\/threads\/[^/]+\/items\//.test(r.url())&&r.request().postData()?.includes(input.text)===true,{timeout:options.confirmationTimeoutMs??15000}).catch(()=>null);
    ctx.signal.throwIfAborted();if(new URL(page.url()).origin!==options.origin)throw new Error('Conversation left bound Instagram origin');crossed=true;
    await page.getByRole('button',{name:/^Send$/i}).last().click();
    const deadline=Date.now()+(options.confirmationTimeoutMs??15000);let id:string|undefined;
    while(Date.now()<deadline&&!id){const rows=page.locator(selector).filter({hasText:input.text});for(let i=0;i<await rows.count();i++){const value=await rows.nth(i).getAttribute('data-message-id')??await rows.nth(i).getAttribute('data-item-id');if(value&&!before.includes(value)){id=value;break;}}if(!id)await page.waitForTimeout(100);}
    if(!id){const response=await receipt;if(response?.ok())id=nativeId(await response.json().catch(()=>null));}
    if(!id)throw new Error('Instagram send lacks a new native message identifier');
    return{kind:'accepted',receipt:{providerMessageId:id,providerThreadId:new URL(page.url()).pathname.match(/\/t\/([^/]+)/)?.[1],acceptedAt:ctx.now()}};
  });}catch(error){return crossed?{kind:'unknown',detail:`Instagram effect attempted; confirmation uncertain: ${(error as Error).message}`}:preEffectFailure(error,authenticated,ctx.signal.aborted,pageUrl);}
}
