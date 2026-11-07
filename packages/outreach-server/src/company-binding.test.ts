import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it,expect } from 'vitest';
import { createEngine,bootstrapWorkspace,authenticate } from '@splitin/outreach-core';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { FakeSocialProvider,staticSecrets } from '@splitin/outreach-fakes';
import { registerConfiguredAccount } from './browser-binding';
it('binds a company target only to an owned personal login without duplicating its profile',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'company-binding-'));const file=join(dir,'bindings.json');const previous=process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE;process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE=file;
 const db=openSqliteDatabase(':memory:');const fake=new FakeSocialProvider();const engine=createEngine({db,adapters:[fake.adapter()],secrets:staticSecrets({}),workerId:'fixture'});bootstrapWorkspace(db,{workspaceId:'ws',name:'Workspace',adminRef:'admin',adminName:'Admin'});const ctx=authenticate(db,'ws','admin','test','fixture');
 try{const base={provider:fake.name,externalAccountId:'https://www.linkedin.com/in/owner/',profileUrl:'https://www.linkedin.com/in/owner/',sender:{name:'Owner',address:'owner@example.invalid'},purposes:['social_publishing' as const],secretRef:'env:SOCIAL',executionPlacement:'daytona-browser' as const};
  const login=await registerConfiguredAccount(engine,ctx,base);const pageUrl='https://www.linkedin.com/company/brand/';const input={...base,externalAccountId:pageUrl,profileUrl:pageUrl,publishingProfileUrl:pageUrl,loginConnectionId:login};const target=await registerConfiguredAccount(engine,ctx,input);
  const bindings=JSON.parse(readFileSync(file,'utf8'));expect(bindings[pageUrl]).toMatchObject({connectionId:base.externalAccountId,loginProfileUrl:base.profileUrl,publishingProfileUrl:pageUrl,cdpUrl:bindings[base.externalAccountId].cdpUrl,userDataDir:bindings[base.externalAccountId].userDataDir});expect(target).not.toBe(login);expect(await registerConfiguredAccount(engine,ctx,input)).toBe(target);
  await expect(registerConfiguredAccount(engine,ctx,{...input,loginConnectionId:'foreign-account'})).rejects.toThrow('workspace');expect(db.prepare('SELECT actor_kind FROM publishing_targets WHERE account_id=?').get(target)).toEqual({actor_kind:'organization'});
 }finally{db.close();if(previous===undefined)delete process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE;else process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE=previous;rmSync(dir,{recursive:true,force:true});}
});
