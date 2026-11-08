import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';import {extname,resolve} from 'node:path';
import {chromium,type Page} from 'playwright';
const enabled=process.env.OUTREACH_BROWSER_FIXTURES==='1';
async function fixture(page:Page,role='admin'){
 const requests:{path:string;body?:Record<string,unknown>}[]=[];let status='awaiting_login';let confirmed=false;
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());expect(url.origin).toBe('https://carl-allen.splitin.net');
  if(url.pathname==='/auth/session')return route.fulfill({json:{authenticated:true,csrf:'social-fixture',workspaceId:'ws'}});
  if(url.pathname.startsWith('/api/v1/')){const body=req.method()==='POST'?req.postDataJSON() as Record<string,unknown>:undefined;requests.push({path:url.pathname,body});let data:unknown={};
   if(url.pathname==='/api/v1/publishing')data={roles:[role],accounts:[],drafts:[],actions:[],media:[],approvals:[]};
   if(url.pathname==='/api/v1/publishing/actions')data={actions:[]};if(url.pathname==='/api/v1/publishing/drafts')data={drafts:[]};if(url.pathname==='/api/v1/mailboxes/oauth/config')data={providers:[]};if(url.pathname==='/api/v1/social/connections')data=req.method()==='POST'?{id:'login-fixture',channel:body?.channel,status,loginUrl:'/browser-login?session=login-fixture'}:{sessions:[]};
   if(url.pathname==='/api/v1/social/connections/login-fixture/check')data={id:'login-fixture',channel:'instagram',status:status='identified',identity:{channel:'instagram',profileUrl:'https://www.instagram.com/fixture_owner/',name:'Fixture Owner'}};
   if(url.pathname.endsWith('/confirm')){expect(body?.profileUrl).toBe('https://www.instagram.com/fixture_owner/');confirmed=true;data={id:'login-fixture',status:'connected',accountId:'social-fixture'};}
   if(url.pathname.endsWith('/qualify'))data={qualification:{identity:'https://www.instagram.com/fixture_owner/',accountType:'business',formats:['feed','carousel'],checkedAt:Date.now()}};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  }
  const file=resolve('apps/papr/bundle/apps/outreach-console',url.pathname==='/'?'publishing.html':url.pathname.slice(1));return route.fulfill({contentType:extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'application/javascript',body:readFileSync(file)});
 });await page.goto('https://carl-allen.splitin.net/?view=accounts');await expect.poll(()=>page.locator('#runtime-state').textContent()).toBe('Workspace connected');return{requests,confirmed:()=>confirmed};
}
describe.skipIf(!enabled)('browser-first social connection UI',()=>{
 it('uses a reserved private browser, discovers identity automatically, then confirms without scheduling effects',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.OUTREACH_TEST_CHROME?{executablePath:process.env.OUTREACH_TEST_CHROME}:{})});try{const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));const f=await fixture(page);
   await page.getByRole('button',{name:'Connect Instagram',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Connect Instagram',exact:true});expect(await dialog.locator('input[type="url"]').count()).toBe(0);await dialog.getByRole('button',{name:'Start private sign-in',exact:true}).click();expect(await dialog.getByRole('link',{name:'Open private browser'}).getAttribute('href')).toBe('/browser-login?session=login-fixture');
   await expect.poll(()=>dialog.getByRole('button',{name:'Confirm this account',exact:true}).count(),{timeout:15000}).toBe(1);expect(await dialog.textContent()).toContain('https://www.instagram.com/fixture_owner/');expect(f.confirmed()).toBe(false);await dialog.getByRole('button',{name:'Confirm this account',exact:true}).click();await expect.poll(f.confirmed).toBe(true);await expect.poll(()=>dialog.textContent()).toContain('feed, carousel');expect(f.requests.some(r=>r.path.includes('/publishing/plans')||r.path==='/api/v1/actions')).toBe(false);expect(errors).toEqual([]);
  }finally{await browser.close();}
 },60000);
 it('keeps connection creation unavailable to a viewer',async()=>{const browser=await chromium.launch({headless:true,...(process.env.OUTREACH_TEST_CHROME?{executablePath:process.env.OUTREACH_TEST_CHROME}:{})});try{const page=await browser.newPage();const f=await fixture(page,'viewer');expect(await page.getByRole('button',{name:'Connect Instagram',exact:true}).isDisabled()).toBe(true);expect(f.requests.some(r=>r.path==='/api/v1/social/connections')).toBe(false);}finally{await browser.close();}},30000);
});
