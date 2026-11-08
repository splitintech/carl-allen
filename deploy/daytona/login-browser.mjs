import {chromium} from 'playwright';
import {inspectSignedInPage} from '@splitin/outreach-provider-social-browser';
const ORIGINS={linkedin:'https://www.linkedin.com',x:'https://x.com',instagram:'https://www.instagram.com',tiktok:'https://www.tiktok.com'};
/** Human-owned leases are resolved by the supervisor before this module receives a binding. */
export async function loginBrowser(binding, operation) {
 const origin=ORIGINS[binding.kind];if(!origin)throw new Error('Unsupported login platform');
 const browser=await chromium.connectOverCDP(binding.cdpUrl,{timeout:10000});
 try{
  const context=browser.contexts()[0];if(!context)throw new Error('Persistent browser is unavailable');
  let page=context.pages().find(p=>{try{return new URL(p.url()).origin===origin;}catch{return false;}});
  if(!page){page=await context.newPage();await page.goto(origin,{waitUntil:'domcontentloaded',timeout:20000});}
  if(operation==='focus'){await page.bringToFront();return{focused:true};}
  // Scan native pages already open in this account profile; never navigate a form mid-login.
  for(const candidate of context.pages()){
   const identity=await inspectSignedInPage(candidate,binding.kind);if(identity)return{identity};
  }
  return{identity:null,detail:'Finish sign-in and any verification challenge in the private browser.'};
 }finally{await browser.close();} // CDP detach; the supervisor retains the persistent Chrome process.
}
