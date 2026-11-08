import type {Page} from 'playwright';
import type {ProviderContext,PublishingQualification} from '@splitin/outreach-contracts';
import type {AccountBinding} from './runtime';
import type {SocialSession} from './session';
import {accountChannel} from './platforms';
import {linkedInReady,type LinkedInOptions} from './linkedin';
import {compose,networkReady,type NetworkOptions} from './network-publish';
import {loadMedia} from './media';
import {publishingFormatIssues} from '@splitin/outreach-contracts';
const visible=async(page:Page,selector:string)=>page.locator(selector).first().isVisible().catch(()=>false);
/** Never submits a post. Explicit selected-media probes may stage immutable bytes in the native composer. */
export async function qualifyPublishing(session:SocialSession,ctx:ProviderContext,binding:AccountBinding,options:LinkedInOptions|NetworkOptions,sample?:{format?:'feed'|'carousel'|'video'|'reel';mediaUrls?:readonly string[]}):Promise<PublishingQualification>{
 const channel=accountChannel(binding);return session.withPage(ctx.signal,async page=>{
  if(channel==='linkedin')await linkedInReady(page,binding,options);else await networkReady(page,binding,channel,options);
  const formats:('feed'|'carousel'|'video'|'reel')[]=[];let accountType:PublishingQualification['accountType']=binding.publishingProfileUrl?'organization':channel==='instagram'?'unknown':'personal';
  let detail='No supported native composer was confirmed; finish account setup or reconnect.';
  if(channel==='linkedin'){
   if(binding.publishingProfileUrl)await page.goto(`${options.origin}${new URL(binding.publishingProfileUrl).pathname}admin/page-posts/published/`,{waitUntil:'domcontentloaded'});
   const create=page.locator('button.share-box-feed-entry__trigger, button:has-text("Start a post")').first();
   if(await create.isVisible().catch(()=>false)){
    await create.click();let actor=true;
    if(binding.publishingProfileUrl){const node=page.locator(binding.publishingIdentitySelector??'[data-publishing-identity], [data-view-name="share-creation-actor"] a[href*="/company/"]').first();const href=await node.getAttribute('href').catch(()=>null)??await node.getAttribute('data-publishing-identity').catch(()=>null);actor=!!href&&new URL(href,options.origin).pathname.replace(/\/$/,'').toLowerCase()===new URL(binding.publishingProfileUrl).pathname.replace(/\/$/,'').toLowerCase();}
    if(actor&&await visible(page,'.ql-editor, div[role="textbox"][contenteditable="true"]'))formats.push('feed');
    if(actor&&await visible(page,'button[aria-label*="photo" i],button[aria-label*="image" i],button[aria-label*="media" i]')){
     // Native controls may install file inputs only when selected. Opening them does not upload media.
     await page.locator('button[aria-label*="photo" i],button[aria-label*="image" i],button[aria-label*="media" i]').first().click();
    }
    if(actor&&await page.locator('input[type="file"][multiple][accept*="image"]').count())formats.push('carousel');
    if(actor&&(await page.locator('input[type="file"][accept*="video"]').count()||await visible(page,'button[aria-label*="video" i]')))formats.push('video');
    if(!actor)detail='The composer does not identify the selected company page. Verify page administrator permission.';
   }
  }else if(channel==='x'){
   if(await visible(page,'[data-testid="tweetTextarea_0"]'))formats.push('feed');
   if(await page.locator('input[type="file"][multiple]').count())formats.push('carousel');
   if(await page.locator('input[type="file"][accept*="video"]').count())formats.push('video');
  }else if(channel==='tiktok'){
   if(await page.locator('input[type="file"][accept*="video"]').count())formats.push('feed','video');
  }else{
   await page.goto(options.origin+'/accounts/professional_account_settings/',{waitUntil:'domcontentloaded'});
   if(await page.getByText(/^Business tools and controls$|^Business account$/i).count())accountType='business';
   else if(await page.getByText(/^Creator tools and controls$|^Creator account$/i).count())accountType='creator';
   await networkReady(page,binding,'instagram',options);
   const create=page.getByRole('link',{name:/^New post$|^Create$/i}).or(page.getByRole('button',{name:/^Create$|^New post$/i})).first();
   if(['business','creator'].includes(accountType)&&await create.isVisible().catch(()=>false)){
    if(sample?.mediaUrls?.length){
     const files=await loadMedia(ctx,sample.mediaUrls,options.media,channel);const issues=publishingFormatIssues(channel,sample.format,files.map(file=>file.mimeType));if(issues.length)throw new Error(issues.join('; '));
     await compose(page,'instagram',{channel:'instagram',actionId:'qualification',idempotencyKey:'qualification',text:'',...sample},files,options);
     if(files.some(file=>file.mimeType.startsWith('video/')))formats.push('feed','video','reel');else formats.push('feed',...(files.length>1?['carousel' as const]:[]));
    }else await create.click();if(await page.locator('input[type="file"][accept*="image"]').count())formats.push('feed');
    if(await page.locator('input[type="file"][multiple][accept*="image"]').count())formats.push('carousel');
    // Video/reel requires an explicit native indication; an input accepting video alone is insufficient.
    if(await page.locator('input[type="file"][accept*="video"]').count()&&await page.getByText(/^New reel$|videos? (?:will be |are )shared as reels/i).count())formats.push('video','reel');
   }
   if(accountType==='unknown')detail='Instagram professional account type could not be confirmed. Connect a Business or Creator account and check its native settings.';
  }
  if(new URL(page.url()).origin!==options.origin)throw new Error('Publishing qualification left its bound origin');
  return{identity:binding.publishingProfileUrl??binding.expectedProfileUrl!,accountType,formats:[...new Set(formats)],checkedAt:ctx.now(),...(formats.length?{}:{detail})};
 });
}
