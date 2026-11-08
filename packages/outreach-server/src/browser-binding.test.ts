import { mkdtempSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe,it,expect } from 'vitest';
import { createEngine,bootstrapWorkspace,authenticate } from '@splitin/outreach-core';
import { FakeSocialProvider,staticSecrets } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { registerConfiguredAccount } from './browser-binding';
describe('browser account registration binding',()=>{
 it('creates unique owner-only profile mappings and refuses identity rebinding',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'outreach-bindings-'));const file=join(directory,'bindings.json');const old=process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE;process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE=file;
  const db=openSqliteDatabase(':memory:');const provider=new FakeSocialProvider();const engine=createEngine({db,adapters:[provider.adapter()],secrets:staticSecrets({}),workerId:'binding-test'});
  bootstrapWorkspace(db,{workspaceId:'ws',name:'W',adminRef:'admin',adminName:'Admin'});const ctx=authenticate(db,'ws','admin','cli','t');
  try {
   const input={provider:provider.name,externalAccountId:'https://www.linkedin.com/in/owner/',profileUrl:'https://www.linkedin.com/in/owner/',sender:{name:'Owner',address:'owner@example.org'},purposes:['social_publishing' as const],secretRef:'env:SOCIAL',executionPlacement:'daytona-browser' as const};
   await registerConfiguredAccount(engine,ctx,input);await registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'https://www.linkedin.com/in/owner2/',profileUrl:'https://www.linkedin.com/in/owner2/'});
   for (const [_kind,profileUrl] of [['x','https://x.com/owner_x/'],['instagram','https://www.instagram.com/owner_ig/'],['tiktok','https://www.tiktok.com/@owner_tt/']] as const) await registerConfiguredAccount(engine,ctx,{...input,externalAccountId:profileUrl,profileUrl});
   const bindings=JSON.parse(readFileSync(file,'utf8')) as Record<string,{kind?:string;expectedProfileUrl:string;cdpUrl:string;userDataDir:string}>;
   for (const [kind,url] of [['x','https://x.com/owner_x/'],['instagram','https://www.instagram.com/owner_ig/'],['tiktok','https://www.tiktok.com/@owner_tt/']]) expect(bindings[url!]?.kind).toBe(kind);
   expect(bindings['https://www.linkedin.com/in/owner/']?.expectedProfileUrl).toBe(input.profileUrl);expect(bindings['https://www.linkedin.com/in/owner/']?.userDataDir).toMatch(/chrome-profiles\/[0-9a-f]{24}$/);expect(bindings['https://www.linkedin.com/in/owner/']?.cdpUrl).not.toBe(bindings['https://www.linkedin.com/in/owner2/']?.cdpUrl);expect(statSync(file).mode&0o077).toBe(0);
   const first = db.prepare('SELECT id FROM provider_accounts WHERE external_account_id=?').get<{id:string}>(input.profileUrl);
   const same = await registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'raw-alias',profileUrl:'https://linkedin.com/in/OWNER'});
   expect(same).toBe(first?.id);
   expect(db.prepare('SELECT COUNT(*) AS n FROM provider_accounts WHERE external_account_id=?').get<{n:number}>(input.profileUrl)?.n).toBe(1);
   expect(Object.keys(JSON.parse(readFileSync(file,'utf8')))).toHaveLength(5);
   await expect(registerConfiguredAccount(engine,ctx,{...input,profileUrl:'https://www.linkedin.com/in/different/'})).rejects.toThrow(/different browser identity/);
   await expect(registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'bad',profileUrl:'https://evil.example/in/owner/'})).rejects.toThrow(/canonical/);
   await expect(registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'unconfigured',profileUrl:undefined})).rejects.toThrow(/preconfigured/);
   const legacy={kind:'x',expectedProfileUrl:'https://x.com/legacy/',cdpUrl:'http://127.0.0.1:9230',userDataDir:join('/data/chrome-profiles',createHash('sha256').update('legacy-owner').digest('hex').slice(0,24))};
   writeFileSync(file,JSON.stringify({...bindings,'legacy-owner':legacy}),{mode:0o600});
   const legacyId=await registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'https://www.x.com/LEGACY',profileUrl:'https://www.x.com/LEGACY'});
   const legacyAgain=await registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'another-alias',profileUrl:'https://x.com/legacy/'});
   expect(legacyAgain).toBe(legacyId);expect(db.prepare('SELECT external_account_id FROM provider_accounts WHERE id=?').get<{external_account_id:string}>(legacyId)?.external_account_id).toBe('legacy-owner');
   expect(JSON.parse(readFileSync(file,'utf8'))['legacy-owner']).toEqual(legacy);
   writeFileSync(file,JSON.stringify({...bindings,'trusted-browser':{kind:'browser',cdpUrl:'http://127.0.0.1:9224',recipeIdentities:{'save-draft':{selector:'[data-account]',expected:'owner@example.org'}}}}),{mode:0o600});
   const trustedId=await registerConfiguredAccount(engine,ctx,{...input,externalAccountId:'trusted-browser',profileUrl:undefined});
   expect(trustedId).toBeTruthy();
   expect(JSON.parse(readFileSync(file,'utf8'))['trusted-browser'].kind).toBe('browser');
   bootstrapWorkspace(db,{workspaceId:'foreign',name:'Foreign',adminRef:'foreign-admin',adminName:'Foreign'});const foreign=authenticate(db,'foreign','foreign-admin','test','foreign');const before=readFileSync(file,'utf8');
   await expect(registerConfiguredAccount(engine,foreign, input)).rejects.toThrow('another workspace');
   await expect(registerConfiguredAccount(engine,foreign,{...input,externalAccountId:'foreign-alias'})).rejects.toThrow('another workspace');
   expect(readFileSync(file,'utf8')).toBe(before);
  } finally {db.close();if(old===undefined)delete process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE;else process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE=old;rmSync(directory,{recursive:true,force:true});}
 });
});
