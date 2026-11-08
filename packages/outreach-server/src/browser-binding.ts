import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConflictError, ForbiddenError, registerProviderAccount, requireRole, type AuthContext, type Engine, type RegisterAccountInput } from '@splitin/outreach-core';

/** Admin-supplied identity is persisted separately from secrets and cannot rebind an existing profile. */
export async function registerConfiguredAccount(engine: Engine, ctx: AuthContext, input: RegisterAccountInput & { profileUrl?: string }): Promise<string> {
  requireRole(ctx, 'admin');
  assertBindingOwner(engine,ctx,input.externalAccountId);
  if(input.publishingProfileUrl || input.profileUrl && /^\/company\//.test(new URL(input.profileUrl).pathname))return registerCompanyAccount(engine,ctx,input);
  let accountInput = input;
  if (input.executionPlacement === 'daytona-browser') {
    const file = process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE ?? process.env.OUTREACH_SOCIAL_BINDINGS_FILE;
    if (!file) throw new ConflictError('Browser binding storage is not configured in this runtime');
    if (!input.profileUrl) {
      if (!existsSync(file)) throw new ConflictError('A canonical LinkedIn profile or a preconfigured browser account is required');
      const stat = lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077)) throw new ForbiddenError('Browser bindings must be a regular owner-only file');
      const configured = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { kind?: string; recipeIdentities?: Record<string, unknown> }>;
      const trusted = configured[input.externalAccountId];
      if (trusted?.kind !== 'browser' || !trusted.recipeIdentities || !Object.keys(trusted.recipeIdentities).length) throw new ConflictError('A canonical LinkedIn profile or a preconfigured browser account is required');
      const { profileUrl: _profile, ...account } = input;
      return registerProviderAccount(engine, ctx, account);
    }
    const profile = canonicalProfile(input.profileUrl);
    const expectedProfileUrl = profile.url;
    assertBindingOwner(engine,ctx,expectedProfileUrl);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    let descriptor: number;
    try { descriptor = openSync(lock, 'wx', 0o600); } catch { throw new ConflictError('Another account connection is in progress; try again'); }
    try {
      if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || (stat.mode & 0o077)) throw new ForbiddenError('Browser bindings must be a regular owner-only file'); }
      const bindings = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Record<string, { kind?: string; expectedProfileUrl: string; cdpUrl: string; userDataDir: string }>;
      const requested = bindings[input.externalAccountId];
      if (requested && (!requested.expectedProfileUrl || canonicalProfile(requested.expectedProfileUrl).url !== expectedProfileUrl)) throw new ConflictError('This account is already bound to a different browser identity');
      const identities = Object.entries(bindings).filter(([, value]) => {
        try { return value.kind !== 'browser' && canonicalProfile(value.expectedProfileUrl).url === expectedProfileUrl; } catch { return false; }
      });
      if (identities.length > 1) throw new ConflictError('Duplicate historical profiles require administrator reconciliation');
      // Reuse historical arbitrary keys, but every newly created identity uses one canonical key.
      const externalAccountId = identities[0]?.[0] ?? expectedProfileUrl;
      assertBindingOwner(engine,ctx,externalAccountId);
      const owned=bindings[externalAccountId] as {workspaceId?:string}|undefined;if(owned?.workspaceId&&owned.workspaceId!==ctx.workspaceId)throw new ForbiddenError('Browser profile belongs to another workspace');
      accountInput = { ...input, externalAccountId };
      const existing = bindings[externalAccountId];
      if (!existing) {
        const used = new Set(Object.values(bindings).map((b) => new URL(b.cdpUrl).port));
        let port = 9222;
        while (used.has(String(port)) && port < 10000) port++;
        if (port >= 10000) throw new ConflictError('No browser profile ports available');
        const root = process.env.OUTREACH_CHROME_PROFILE_DIR ?? process.env.OUTREACH_CHROME_PROFILES_DIR ?? '/data/chrome-profiles';
        bindings[externalAccountId] = { kind: profile.channel, expectedProfileUrl, cdpUrl: `http://127.0.0.1:${port}`, userDataDir: join(root, createHash('sha256').update(externalAccountId).digest('hex').slice(0, 24)) };
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(bindings)}\n`, { mode: 0o600, flag: 'wx' }); chmodSync(temp, 0o600); renameSync(temp, file);
      }
    } finally { closeSync(descriptor); unlinkSync(lock); }
  }
  const { profileUrl: _profile, ...account } = accountInput;
  if (input.profileUrl && input.executionPlacement === 'daytona-browser') {
    const existing = engine.db.prepare('SELECT id FROM provider_accounts WHERE workspace_id=? AND provider=? AND external_account_id=?').get<{id:string}>(ctx.workspaceId, account.provider, account.externalAccountId);
    if (existing) return existing.id;
  }
  return registerProviderAccount(engine, ctx, account);
}

/** Canonical account identity, not an arbitrary site URL or publication permalink. */
function canonicalProfile(raw: string): { channel: string; url: string } {
  let value: URL; try { value = new URL(raw); } catch { throw new ConflictError('Use a canonical HTTPS social profile URL'); }
  if (value.protocol !== 'https:' || value.username || value.password || value.search || value.hash || value.port) throw new ConflictError('Use a canonical HTTPS social profile URL');
  const host = value.hostname.toLowerCase();
  const rules = [
    { channel: 'linkedin', hosts: ['www.linkedin.com', 'linkedin.com'], origin: 'https://www.linkedin.com', path: /^\/in\/[a-z0-9_-]+\/?$/i },
    { channel: 'x', hosts: ['x.com', 'www.x.com'], origin: 'https://x.com', path: /^\/(?!home\/?$|compose\/?$|settings\/?$|messages\/?$|explore\/?$|notifications\/?$|i\/?$)[a-z0-9_]{1,15}\/?$/i },
    { channel: 'instagram', hosts: ['www.instagram.com', 'instagram.com'], origin: 'https://www.instagram.com', path: /^\/(?!accounts\/?$|direct\/?$|explore\/?$|reels\/?$|stories\/?$|p\/?$)[a-z0-9_.]{1,30}\/?$/i },
    { channel: 'tiktok', hosts: ['www.tiktok.com', 'tiktok.com'], origin: 'https://www.tiktok.com', path: /^\/@[a-z0-9_.]{2,24}\/?$/i },
  ];
  const rule = rules.find((r) => r.hosts.includes(host) && r.path.test(value.pathname));
  if (!rule) throw new ConflictError('Use a canonical LinkedIn, X, Instagram or TikTok profile URL');
  return { channel: rule.channel, url: `${rule.origin}${value.pathname.toLowerCase().replace(/\/?$/, '/')}` };
}

interface LoginBinding {kind?:string;expectedProfileUrl:string;loginProfileUrl?:string;connectionId?:string;cdpUrl:string;userDataDir:string;publishingProfileUrl?:string}
async function registerCompanyAccount(engine:Engine,ctx:AuthContext,input:RegisterAccountInput & {profileUrl?:string}):Promise<string>{
 if(input.executionPlacement!=='daytona-browser'||!input.loginConnectionId)throw new ConflictError('Choose an existing LinkedIn personal login connection for this page');
 const page=new URL(input.publishingProfileUrl??input.profileUrl??'');
 if(page.protocol!=='https:'||page.port||!['www.linkedin.com','linkedin.com'].includes(page.hostname)||!/^\/company\/[a-z0-9_-]+\/?$/i.test(page.pathname)||page.search||page.hash||page.username||page.password)throw new ConflictError('Use a canonical LinkedIn company page URL');
 const url=`https://www.linkedin.com${page.pathname.toLowerCase().replace(/\/?$/,'/')}`;
 assertBindingOwner(engine,ctx,url);
 const owner=engine.db.prepare('SELECT id,provider,external_account_id FROM provider_accounts WHERE workspace_id=? AND id=?').get<{id:string;provider:string;external_account_id:string}>(ctx.workspaceId,input.loginConnectionId);
 if(!owner||owner.provider!==input.provider)throw new ForbiddenError('Login connection is not available in this workspace');
 const file=process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE??process.env.OUTREACH_SOCIAL_BINDINGS_FILE;
 if(!file||!existsSync(file))throw new ConflictError('Personal login binding is unavailable');
 const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077)throw new ForbiddenError('Browser bindings must be a regular owner-only file');
 const lock=`${file}.lock`;let descriptor:number;try{descriptor=openSync(lock,'wx',0o600);}catch{throw new ConflictError('Another account connection is in progress; try again');}
 try{
  const bindings=JSON.parse(readFileSync(file,'utf8')) as Record<string,LoginBinding>;const login=bindings[owner.external_account_id];
  if(!login||login.kind!=='linkedin'||login.publishingProfileUrl||!/^https:\/\/www\.linkedin\.com\/in\//.test(login.expectedProfileUrl))throw new ConflictError('The selected account must be a configured LinkedIn personal login');
  const connectionId=login.connectionId??owner.external_account_id;const previous=bindings[url];
  if(previous&&(previous.connectionId!==connectionId||previous.publishingProfileUrl!==url))throw new ConflictError('Company page is already bound to a different login');
  bindings[url]={...login,connectionId,loginProfileUrl:login.loginProfileUrl??login.expectedProfileUrl,publishingProfileUrl:url};
  const temp=`${file}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(bindings)+'\n',{flag:'wx',mode:0o600});renameSync(temp,file);
 }finally{closeSync(descriptor);unlinkSync(lock);}
 const existing=engine.db.prepare('SELECT id FROM provider_accounts WHERE workspace_id=? AND provider=? AND external_account_id=?').get<{id:string}>(ctx.workspaceId,input.provider,url);
 const id=existing?.id??await registerProviderAccount(engine,ctx,{...input,externalAccountId:url,purposes:input.purposes.filter(p=>p==='social_publishing')});
 engine.db.prepare('INSERT INTO publishing_targets(id,workspace_id,connection_id,account_id,channel,actor_kind,actor_url) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,account_id) DO NOTHING').run(id,ctx.workspaceId,owner.id,id,'linkedin','organization',url);
 return id;
}
function assertBindingOwner(engine:Engine,ctx:AuthContext,key:string){if(engine.db.prepare('SELECT id FROM provider_accounts WHERE external_account_id=? AND workspace_id<>?').get(key,ctx.workspaceId))throw new ForbiddenError('Browser identity belongs to another workspace');}
