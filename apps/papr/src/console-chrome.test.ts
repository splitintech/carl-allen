import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { it, expect } from 'vitest';
import { chromium } from 'playwright';

it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1')('authors, edits, schedules and cancels through the actual console browser controls', async () => {
  const executablePath = process.env.OUTREACH_TEST_CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await chromium.launch({ headless: true, timeout: 90_000, ...(executablePath ? { executablePath } : {}) });
  const artifacts = process.env.OUTREACH_BROWSER_ARTIFACT_DIR ?? resolve('coverage/browser');
  mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const actions: {action:string;params:Record<string,unknown>}[]=[];
    const account={id:'01ARZ3NDEKTSV4RRFFQ69G5FAV',provider:'social-browser',externalAccountId:'https://www.linkedin.com/in/owner/',sender:{name:'Owner',address:'owner@example.org'},capabilities:{socialPublish:true,socialMessage:true,socialConnect:true,executionPlacement:'daytona-browser'},health:'ok'};
    const email={...account,id:'01ARZ3NDEKTSV4RRFFQ69G5FAW',provider:'gmail',drafts:true,capabilities:{}};
    const generic={...account,id:'01ARZ3NDEKTSV4RRFFQ69G5FAY',externalAccountId:'trusted-mail-browser',capabilities:{browserTasks:true,executionPlacement:'daytona-browser'}};
    let content: unknown[]=[];
    let drafts: unknown[]=[];
    await page.route('https://console.test/**',async(route)=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/api/')){
        const request=route.request().postDataJSON() as {params:Record<string,unknown>};
        const action=url.pathname.split('/').at(-1)!;
        actions.push({action,params:request.params});
        let data: unknown={saved:true};
        if(action==='content-compose') {
          const input=request.params.input as {name:string;text:string;mediaUrls:string[];providerAccountId:string;scheduledFor:string};
          content=[{campaignId:'01ARZ3NDEKTSV4RRFFQ69G5FAX',name:input.name,status:'draft',providerAccountId:input.providerAccountId,posts:[{id:'post',channel:'linkedin',text:input.text,mediaUrls:input.mediaUrls,scheduledFor:input.scheduledFor}]}];
        }
        if(action==='content-activate')content=[];
        if(action==='drafts-save')drafts=[{id:'draft-fixture',content:request.params.input}];
        if(action==='drafts-delete')drafts=[];
        if(action==='overview') data={campaigns:[],statuses:[],approvals:[],review:[],tasks:[],upcoming:[],calendar:[],content,accounts:[account,email,generic],social:{accounts:[account],liveViewUrl:'https://view.example.test'}};
        if(action==='drafts-list')data={drafts};
        await route.fulfill({contentType:'application/json',body:JSON.stringify({stdout:JSON.stringify({ok:true,data})})});return;
      }
      const path=resolve('apps/papr/bundle/apps/outreach-console',url.pathname==='/'?'index.html':url.pathname.slice(1));
      const type=extname(path)==='.html'?'text/html':extname(path)==='.css'?'text/css':'application/javascript';
      await route.fulfill({contentType:type,body:readFileSync(path)});
    });
    await page.goto('https://console.test/');
    await expect.poll(async()=>page.locator('#summary').textContent(),{timeout:90_000}).toContain('going out');
    expect(errors).toEqual([]);
    await page.getByRole('button',{name:'Create a post',exact:true}).click();
    await page.getByLabel('Title',{exact:true}).fill('Launch draft');
    await page.getByLabel('Post',{exact:true}).fill('Hello from the operator');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='content-compose').length).toBe(1);
    await page.locator('#content-drafts').getByRole('button',{name:'Edit draft',exact:true}).click();
    await page.getByLabel('Post',{exact:true}).fill('Edited before scheduling');
    await page.getByLabel('Image URLs (one HTTPS URL per line, approved hosts only)',{exact:true}).fill('https://assets.example.test/approved.png');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='content-compose').length).toBe(2);
    const edited=actions.filter((a)=>a.action==='content-compose')[1]!.params.input as {text:string;mediaUrls:string[];campaignId:string};
    expect(edited.text).toBe('Edited before scheduling');
    expect(edited.mediaUrls).toEqual(['https://assets.example.test/approved.png']);
    expect(edited.campaignId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAX');
    await page.locator('#content-drafts').getByRole('button',{name:'Schedule for approval',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='content-activate').length).toBe(1);
    await page.getByRole('button',{name:'Schedule message or browser action'}).click();
    await page.getByLabel('Action',{exact:true}).selectOption('social.connect');
    await page.getByLabel('Recipient profile URL (messages and connections)',{exact:true}).fill('https://www.linkedin.com/in/recipient/');
    await page.getByLabel('Message or connection note',{exact:true}).fill('Hello');
    await page.getByRole('button',{name:'Queue for approval',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='action-schedule').length).toBe(1);
    expect((actions.find((a)=>a.action==='action-schedule')!.params.input as {kind:string;approval:string}).kind).toBe('social.connect');
    await page.getByRole('button',{name:'Schedule message or browser action'}).click();
    await page.getByLabel('Account',{exact:true}).selectOption(generic.id);
    expect(await page.getByLabel('Action',{exact:true}).locator('option').count()).toBe(1);
    expect(await page.getByLabel('Action',{exact:true}).inputValue()).toBe('browser.task');
    await page.getByLabel('Configured task name (browser tasks)',{exact:true}).fill('save-draft');
    await page.getByLabel('Task fields as JSON (browser tasks)',{exact:true}).fill('{"subject":"Draft in a signed-in browser"}');
    await page.getByRole('button',{name:'Queue for approval',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='action-schedule').length).toBe(2);
    const browserAction=actions.filter((a)=>a.action==='action-schedule')[1]!.params.input as {kind:string;approval:string};
    expect(browserAction.kind).toBe('browser.task');expect(browserAction.approval).toBe('always');
    await page.getByRole('button',{name:'Check session after login'}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='account-check').length).toBe(1);
    await page.getByRole('button',{name:'New draft',exact:true}).click();
    await page.getByLabel('To (comma-separated email addresses)').fill('recipient@example.net');
    await page.getByLabel('Subject',{exact:true}).fill('Draft only');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='drafts-save').length).toBe(1);
    await page.locator('#mail-drafts').getByRole('button',{name:'Edit draft',exact:true}).click();
    await page.getByLabel('Message',{exact:true}).fill('Draft edit remains unsent');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='drafts-save').length).toBe(2);
    expect((actions.filter((a)=>a.action==='drafts-save')[1]!.params.input as {id:string;text:string}).text).toBe('Draft edit remains unsent');
    await page.locator('#mail-drafts').getByRole('button',{name:'Delete draft',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='drafts-delete').length).toBe(1);
    await page.getByRole('button',{name:'Connect configured browser account',exact:true}).click();
    await page.getByLabel('Configured browser account ID',{exact:true}).fill('trusted-mail-browser');
    await page.getByLabel('Your name',{exact:true}).fill('Owner');
    await page.getByLabel('Account email',{exact:true}).fill('owner@example.org');
    await page.getByRole('button',{name:'Register configured account',exact:true}).click();
    await expect.poll(()=>actions.filter((a)=>a.action==='account-register').length).toBe(1);
    const registered=actions.find((a)=>a.action==='account-register')!.params.input as {externalAccountId:string;profileUrl?:string};
    expect(registered.externalAccountId).toBe('trusted-mail-browser');
    expect(registered.profileUrl).toBeUndefined();
    await page.getByRole('button',{name:'Set up later',exact:true}).click();
    const mutations = () => actions.filter((action) => !['overview', 'drafts-list'].includes(action.action));
    const beforeCancel=mutations().length;
    await page.getByRole('button',{name:'Create a post',exact:true}).click();
    await page.keyboard.press('Escape');
    await expect.poll(()=>page.locator('dialog').count()).toBe(0);
    expect(await page.evaluate('document.activeElement?.id')).toBe('create-post');
    expect(mutations().length).toBe(beforeCancel);
    expect(actions.some((a)=>a.action==='email-send')).toBe(false);
    expect(errors).toEqual([]);
    await page.evaluate('scrollTo(0,0)');
    await page.screenshot({path:resolve(artifacts,'console-chrome.png'),fullPage:true});
  } finally { await browser.close(); }
}, 300_000);


it.skipIf(process.env.OUTREACH_BROWSER_FIXTURES !== '1')('connects an account later with recoverable errors, private login, identity check and mobile controls', async () => {
  const executablePath = process.env.OUTREACH_TEST_CHROME ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await chromium.launch({ headless: true, timeout: 90_000, ...(executablePath ? { executablePath } : {}) });
  const artifacts = process.env.OUTREACH_BROWSER_ARTIFACT_DIR ?? resolve('coverage/browser');
  mkdirSync(artifacts, { recursive: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const actions: { action: string; params: Record<string, unknown> }[] = [];
    const accounts: Record<string, unknown>[] = [];
    let registerAttempts = 0;
    const loginUrl = 'https://private-browser.example.test/login';
    await page.route('https://console.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) {
        const { params } = route.request().postDataJSON() as { params: Record<string, unknown> };
        const action = url.pathname.split('/').at(-1)!;
        actions.push({ action, params });
        let data: unknown = {};
        if (action === 'overview') data = { campaigns: [], statuses: [], approvals: [], review: [], tasks: [], upcoming: [], calendar: [], content: [], accounts, social: { accounts, liveViewUrl: loginUrl } };
        if (action === 'account-register') {
          registerAttempts++;
          if (registerAttempts === 1) {
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: false, error: 'An administrator role is required', status: 403 }) }) }); return;
          }
          const input = params.input as Record<string, unknown>;
          accounts.push({ ...input, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', health: 'reauth_required', detail: 'Sign into the expected profile', capabilities: { executionPlacement: 'daytona-browser' } });
          data = { accountId: accounts[0]!.id };
        }
        if (action === 'account-check') {
          accounts[0]!.health = 'ok'; accounts[0]!.detail = null;
          data = { status: 'ok' };
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stdout: JSON.stringify({ ok: true, data }) }) }); return;
      }
      const path = resolve('apps/papr/bundle/apps/outreach-console', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      await route.fulfill({ contentType: extname(path) === '.html' ? 'text/html' : extname(path) === '.css' ? 'text/css' : 'application/javascript', body: readFileSync(path) });
    });
    await page.goto('https://console.test/');
    await expect.poll(() => page.locator('#social').textContent(), { timeout: 90_000 }).toContain('No accounts yet');
    await page.locator('#social').scrollIntoViewIfNeeded();
    await page.evaluate('scrollTo(0, 0)');
    await page.screenshot({ path: resolve(artifacts, 'accounts-empty.png'), fullPage: true });
    await page.locator('#social').screenshot({ path: resolve(artifacts, 'accounts-panel.png') });
    await page.getByRole('button', { name: 'Connect LinkedIn account', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('dialog').count()).toBe(0);
    expect(await page.evaluate('document.activeElement?.textContent')).toBe('Connect LinkedIn account');
    expect(actions.filter((a) => a.action === 'account-register')).toHaveLength(0);
    await page.getByRole('button', { name: 'Set up Gmail', exact: true }).click();
    expect(await page.getByRole('dialog').textContent()).toContain('does not yet open mailbox OAuth consent');
    expect(await page.getByRole('dialog').locator('input').count()).toBe(0);
    await page.getByRole('button', { name: 'Set up later', exact: true }).click();
    await page.getByRole('button', { name: 'Connect LinkedIn account', exact: true }).click();
    await page.getByLabel('Your canonical LinkedIn profile URL', { exact: true }).fill('https://www.linkedin.com/company/not-a-person/');
    await page.getByLabel('Your name', { exact: true }).fill('Owner');
    await page.getByLabel('Account email', { exact: true }).fill('owner@example.org');
    await page.getByRole('button', { name: 'Create browser connection', exact: true }).click();
    expect(await page.getByRole('dialog').textContent()).toContain('Enter a profile URL');
    expect(actions.filter((a) => a.action === 'account-register')).toHaveLength(0);
    await page.getByLabel('Your canonical LinkedIn profile URL', { exact: true }).fill('https://linkedin.com/in/owner');
    await page.getByRole('button', { name: 'Create browser connection', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('Connection was not confirmed');
    await page.getByRole('button', { name: 'Create browser connection', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('Your browser connection is saved');
    const registered = actions.filter((a) => a.action === 'account-register')[1]!.params.input as Record<string, unknown>;
    expect(registered.profileUrl).toBe('https://www.linkedin.com/in/owner/');
    expect(registered.executionPlacement).toBe('daytona-browser');
    const link = page.getByRole('dialog').getByRole('link', { name: 'Open secure browser login' });
    expect(await link.getAttribute('href')).toBe(loginUrl);
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await page.locator('#social').textContent()).toContain('Sign-in needed');
    await page.screenshot({ path: resolve(artifacts, 'accounts-sign-in.png') });
    await page.getByRole('dialog').getByRole('button', { name: 'Check session after login', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('Your account is connected');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    expect(await page.locator('#social .chip').textContent()).toBe('Connected');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#social').scrollIntoViewIfNeeded();
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.evaluate(`scrollTo(0, document.querySelector('#social').closest('section').offsetTop - document.querySelector('.bar').getBoundingClientRect().height - 8)`);
    expect(await page.evaluate(`document.querySelector('#social').getBoundingClientRect().top >= document.querySelector('.bar').getBoundingClientRect().bottom`)).toBe(true);
    await page.screenshot({ path: resolve(artifacts, 'accounts-mobile-viewport.png') });
    await page.evaluate('scrollTo(0, 0)');
    await page.screenshot({ path: resolve(artifacts, 'accounts-connected-mobile.png'), fullPage: true });
    expect(actions.every((a) => ['overview', 'account-register', 'account-check'].includes(a.action))).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 180_000);
