import {firstCommentIssues} from '@splitin/outreach-contracts';
import type { ProviderContext, SendResult, SocialCommentInput } from '@splitin/outreach-contracts';
import type { Page } from 'playwright';
import type { AccountBinding } from './runtime';
import type { SocialSession } from './session';
import { linkedInReady, preEffectFailure, type LinkedInOptions } from './linkedin';
import { networkReady, type NetworkOptions } from './network-publish';

export function publicationUrl(channel:string,value:string):string{
  const p=new URL(value);if(p.protocol!=='https:'||p.username||p.password||p.search||p.hash)throw new Error('Comment target must be an exact native publication URL');
  if(channel==='linkedin'&&p.hostname==='www.linkedin.com'&&(/^\/feed\/update\/urn:li:activity:\d+\/?$/.test(p.pathname)||/^\/posts\/[^/]+-activity-\d+[^/]*\/?$/.test(p.pathname)))return p.href;
  if(channel==='instagram'&&p.hostname==='www.instagram.com'&&/^\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(p.pathname))return p.href;
  throw new Error('Only supported LinkedIn/Instagram publication targets can receive a first comment');
}
function profile(value:string):string{const p=new URL(value);return `${p.origin}${p.pathname.replace(/\/+$/,'').toLowerCase()}`;}
async function ownPublication(page:Page,binding:AccountBinding,channel:string):Promise<void>{
  const selector=channel==='linkedin'?'article a.update-components-actor__meta-link, [data-post-author]':'article header a[href], [data-post-author]';
  const node=page.locator(selector).first();const url=await node.getAttribute('href')??await node.getAttribute('data-post-author');
  const expected=binding.publishingProfileUrl??binding.loginProfileUrl??binding.expectedProfileUrl;
  if(!url||!expected||profile(new URL(url,channel==='linkedin'?'https://www.linkedin.com':'https://www.instagram.com').href)!==profile(expected))throw new Error('Publication owner does not match the approved publishing identity');
}
export async function socialComment(session:SocialSession,ctx:ProviderContext,binding:AccountBinding,options:LinkedInOptions|NetworkOptions,input:SocialCommentInput):Promise<SendResult>{
  let target:string;try{target=publicationUrl(input.channel,input.targetUrl);const issues=firstCommentIssues(input.channel,input.text);if(!input.text.trim()||issues.length)throw new Error(issues.join('; ')||'First comment must contain text');}catch(error){return{kind:'rejected',errorClass:'unsupported',detail:(error as Error).message};}
  let crossed=false;let authenticated=false;let currentUrl:string|undefined;
  try{return await session.withPage(ctx.signal,async page=>{
    if(input.channel==='linkedin')await linkedInReady(page,binding,options);else await networkReady(page,binding,'instagram',options);authenticated=true;
    await page.goto(`${options.origin}${new URL(target).pathname}`,{waitUntil:'domcontentloaded'});currentUrl=page.url();if(new URL(page.url()).origin!==options.origin)throw new Error('Publication left bound origin');
    await ownPublication(page,binding,input.channel);
    const selector='[data-comment-id], .comments-comment-entity[data-id]';const before=await page.locator(selector).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-comment-id')??n.getAttribute('data-id')));
    const editor=page.locator(input.channel==='linkedin'?'.comments-comment-box__form [contenteditable="true"], textarea[aria-label*="comment" i]':'textarea[aria-label*="comment" i], [contenteditable="true"][aria-label*="comment" i]').first();
    await editor.fill(input.text);ctx.signal.throwIfAborted();crossed=true;
    await page.locator(input.channel==='linkedin'?'button.comments-comment-box__submit-button':'button:text-is("Post"), [role="button"]:text-is("Post")').last().click();
    const deadline=Date.now()+(options.confirmationTimeoutMs??15000);
    while(Date.now()<deadline){const rows=page.locator(selector).filter({hasText:input.text});for(let i=0;i<await rows.count();i++){const id=await rows.nth(i).getAttribute('data-comment-id')??await rows.nth(i).getAttribute('data-id');if(id&&!before.includes(id))return{kind:'accepted',receipt:{providerMessageId:id,providerThreadId:target,acceptedAt:ctx.now()}};}await page.waitForTimeout(100);}
    throw new Error('Comment has no new native receipt');
  });}catch(error){return crossed?{kind:'unknown',detail:`Comment effect attempted; confirmation uncertain: ${(error as Error).message}`}:preEffectFailure(error,authenticated,ctx.signal.aborted,currentUrl);}
}
