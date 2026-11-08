import type { Page } from 'playwright';
interface ScrollNode {scrollTop:number;scrollHeight:number;clientHeight:number;dispatchEvent(event:Event):boolean}
declare const document:{querySelector<T extends ScrollNode>(selector:string):T|null;scrollingElement:ScrollNode|null;querySelectorAll(selector:string):{length:number}};
export async function scanConversationLinks(page:Page,channel:'linkedin'|'instagram',offset:number,origin:string,known:readonly string[],rounds=8):Promise<{links:string[];offset:number;complete:boolean}> {
 const selector=channel==='linkedin'?'a[href*="/messaging/thread/"]':'a[href*="/direct/t/"]';const container='[data-inbox-list], .msg-conversations-container__conversations-list, [aria-label="Chats"], [data-thread-list]';
 const links=new Set<string>();let position=offset;let stable=0;
 await page.evaluate(({container,offset})=>{const el=document.querySelector<ScrollNode>(container)??document.scrollingElement;if(el)el.scrollTop=offset;},{container,offset});
 const deadline=Date.now()+6000;for(let round=0;round<rounds&&Date.now()<deadline;round++){
  await page.waitForTimeout(80);for(const href of await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')).filter((v):v is string=>Boolean(v)))){const url=new URL(href,origin);if(url.origin===origin)links.add(url.pathname);}
  const more=page.getByRole('button',{name:/^(Load more|Older conversations|Next)$/i}).first();if(await more.isVisible().catch(()=>false)){await more.click();stable=0;continue;}
  const bounds=await page.evaluate(container=>{const el=document.querySelector<ScrollNode>(container)??document.scrollingElement;return el?{top:el.scrollTop,height:el.scrollHeight,client:el.clientHeight}:null;},container);
  if(!bounds)return{links:[...links],offset:position,complete:false};const bottom=bounds.top+bounds.client>=bounds.height-2;
  const empty=await page.getByText(/No messages|Your messages|Send private photos and messages|No (?:message )?requests/i).count();
  if(bottom){stable++;if(stable>=3){const idle=await page.waitForLoadState('networkidle',{timeout:1500}).then(()=>true,()=>false);const unchanged=await page.evaluate(({container,height})=>(document.querySelector<ScrollNode>(container)??document.scrollingElement)?.scrollHeight===height,{container,height:bounds.height});return{links:[...links],offset:bounds.top,complete:idle&&unchanged&&(links.size>0||known.length>0||empty>0)};}}else stable=0;
  position=bottom?bounds.top:Math.min(bounds.height,bounds.top+Math.max(200,bounds.client*.8));
  await page.evaluate(({container,position})=>{const el=document.querySelector<ScrollNode>(container)??document.scrollingElement;if(el){el.scrollTop=position;el.dispatchEvent(new Event('scroll',{bubbles:true}));}},{container,position});
 }
 return{links:[...links],offset:position,complete:false};
}
export async function scrollConversationHistory(page:Page,rounds:number,deadline:number):Promise<boolean> {
 const container='[data-message-list], .msg-s-message-list, [role="log"]';let previous='';let stable=0;
 for(let round=0;round<rounds&&Date.now()<deadline;round++){
  const more=page.getByRole('button',{name:/^(Load older messages|Older messages|Load more messages)$/i}).first();if(await more.isVisible().catch(()=>false)){await more.click();stable=0;await page.waitForTimeout(80);continue;}
  const value=await page.evaluate(container=>{const el=document.querySelector<ScrollNode>(container)??document.scrollingElement;if(!el)return null;el.scrollTop=0;el.dispatchEvent(new Event('scroll',{bubbles:true}));return{height:el.scrollHeight,count:document.querySelectorAll('[data-message-id], [data-event-urn], [data-item-id]').length,top:el.scrollTop};},container);
  await page.waitForTimeout(80);if(!value)return false;const signature=JSON.stringify(value);stable=signature===previous?stable+1:0;previous=signature;if(stable>=2&&value.top===0){const idle=await page.waitForLoadState('networkidle',{timeout:1500}).then(()=>true,()=>false);const unchanged=await page.evaluate(({container,height,count})=>{const el=document.querySelector<ScrollNode>(container)??document.scrollingElement;return el?.scrollHeight===height&&document.querySelectorAll('[data-message-id], [data-event-urn], [data-item-id]').length===count;},{container,height:value.height,count:value.count});if(idle&&unchanged)return true;}
 }
 return false;
}
