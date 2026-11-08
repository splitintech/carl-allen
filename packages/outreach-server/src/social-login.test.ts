import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createEngine,bootstrapWorkspace,authenticate,addPrincipal,createApiToken} from '@splitin/outreach-core';
import {FakeSocialProvider,staticSecrets} from '@splitin/outreach-fakes';
import {openSqliteDatabase} from '@splitin/outreach-store-sqlite';
import {createApp} from './app';
interface SessionDto{id:string;channel:string;status:string;loginUrl:string;accountId?:string}
const sessionJson=(response:Response)=>response.json() as Promise<SessionDto>;
describe('browser-first account sessions',()=>{
 let folder:string,previous:string|undefined,now:number,identity:{channel:string;profileUrl:string;name:string}|null;
 let engine:ReturnType<typeof createEngine>,app:ReturnType<typeof createApp>,tokens:Record<string,string>,calls:{path:string;input:unknown}[];
 beforeEach(()=>{
  folder=mkdtempSync(join(tmpdir(),'carl-login-'));previous=process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE;process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE=join(folder,'bindings.json');now=Date.UTC(2026,10,7);identity=null;calls=[];
  const db=openSqliteDatabase(':memory:');engine=createEngine({db,adapters:[new FakeSocialProvider({name:'social-browser'}).adapter()],secrets:staticSecrets({}),workerId:'login-test',now:()=>now});bootstrapWorkspace(db,{workspaceId:'ws',name:'Workspace',adminRef:'admin',adminName:'Admin'},now);const admin=authenticate(db,'ws','admin','test','test');tokens={};
  for(const role of ['admin','operator','viewer'] as const){const id=addPrincipal(engine,admin,{externalRef:role+'-api',displayName:role,roles:[role]});tokens[role]=createApiToken(engine,admin,{principalId:id,name:role,roleCeiling:role,ttlDays:1}).token;}
  app=createApp({engine,socialLogin:{browser:async(path,input)=>{calls.push({path,input});if(path==='/browser/acquire')return{leaseId:'lease-'+calls.length};if(path==='/browser/login/inspect')return{identity};return{ok:true};}}});
 });
 afterEach(()=>{engine.db.close();if(previous===undefined)delete process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE;else process.env.OUTREACH_SOCIAL_ACCOUNT_BINDINGS_FILE=previous;rmSync(folder,{recursive:true,force:true});});
 const request=(path:string,method='POST',body:unknown={},role='admin')=>app.request(path,{method,headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});
 it('reserves before login, auto-detects then confirms exactly one profile without external actions',async()=>{
  const start=await request('/v1/social/connections','POST',{channel:'instagram'});expect(start.status).toBe(201);const session=await sessionJson(start);expect(session).toMatchObject({status:'awaiting_login',channel:'instagram'});expect(JSON.stringify(session)).not.toContain('lease-');expect(session.loginUrl).toContain(session.id);
  expect(engine.db.prepare('SELECT id FROM provider_accounts').all()).toHaveLength(0);
  expect((await sessionJson(await request(`/v1/social/connections/${session.id}/check`))).status).toBe('awaiting_login');identity={channel:'instagram',profileUrl:'https://www.instagram.com/owner/',name:'Owner'};
  expect((await sessionJson(await request(`/v1/social/connections/${session.id}/check`))).status).toBe('identified');
  expect((await request(`/v1/social/connections/${session.id}/confirm`,'POST',{profileUrl:'https://www.instagram.com/wrong/'})).status).toBe(409);
  const confirmed=await request(`/v1/social/connections/${session.id}/confirm`,'POST',{profileUrl:identity.profileUrl});expect(confirmed.status).toBe(200);const result=await sessionJson(confirmed);expect(result.status).toBe('connected');
  expect((await request(`/v1/social/connections/${session.id}/confirm`,'POST',{profileUrl:identity.profileUrl})).status).toBe(200);expect(engine.db.prepare('SELECT id FROM provider_accounts').all()).toHaveLength(1);expect(engine.db.prepare('SELECT id FROM scheduled_actions').all()).toHaveLength(0);
  const bindings=JSON.parse(readFileSync(join(folder,'bindings.json'),'utf8'));expect(bindings[identity.profileUrl].connectionId).toMatch(/^login:/);expect(calls.filter(c=>c.path==='/browser/release')).toHaveLength(1);
 });
 it('enforces admin, owner and workspace before any browser IO',async()=>{
  expect((await request('/v1/social/connections','POST',{channel:'x'},'viewer')).status).toBe(403);expect(calls).toHaveLength(0);
  const session=await sessionJson(await request('/v1/social/connections','POST',{channel:'x'}));expect((await request(`/v1/social/connections/${session.id}/check`,'POST',{},'operator')).status).toBe(403);
  const original=tokens.admin!;const admin=authenticate(engine.db,'ws','admin','test','test');const id=addPrincipal(engine,admin,{externalRef:'second-admin',displayName:'Second admin',roles:['admin']});tokens.admin=createApiToken(engine,admin,{principalId:id,name:'second',roleCeiling:'admin',ttlDays:1}).token;expect((await request(`/v1/social/connections/${session.id}`,'GET')).status).toBe(404);tokens.admin=original;
 });
 it('releases paused reservations and resumes the same persistent profile',async()=>{
  const session=await sessionJson(await request('/v1/social/connections','POST',{channel:'linkedin'}));await request(`/v1/social/connections/${session.id}/pause`);expect(((await(await request('/v1/social/connections','GET')).json()) as {sessions:SessionDto[]}).sessions[0]!.status).toBe('paused');
  const resumed=await sessionJson(await request(`/v1/social/connections/${session.id}/resume`));expect(resumed.id).toBe(session.id);expect(resumed.status).toBe('awaiting_login');const acquire=calls.filter(c=>c.path==='/browser/acquire');expect(acquire[0]!.input).toEqual(acquire[1]!.input);
 });
 it('expires abandoned reservations and rejects unsafe identity channel substitutions',async()=>{
  const session=await sessionJson(await request('/v1/social/connections','POST',{channel:'tiktok'}));identity={channel:'x',profileUrl:'https://x.com/owner/',name:'Wrong'};expect((await request(`/v1/social/connections/${session.id}/check`)).status).toBe(403);now+=130000;expect((await request(`/v1/social/connections/${session.id}/check`)).status).toBe(409);expect(calls.some(c=>c.path==='/browser/release')).toBe(true);
 });
 it('bounds pending connections to two active profiles',async()=>{await request('/v1/social/connections','POST',{channel:'x'});await request('/v1/social/connections','POST',{channel:'instagram'});expect((await request('/v1/social/connections','POST',{channel:'tiktok'})).status).toBe(409);});
 it('claims concurrent confirmations once without deleting the promoted browser binding',async()=>{
  const session=await sessionJson(await request('/v1/social/connections','POST',{channel:'linkedin'}));identity={channel:'linkedin',profileUrl:'https://www.linkedin.com/in/owner/',name:'Owner'};await request(`/v1/social/connections/${session.id}/check`);
  const results=await Promise.all([request(`/v1/social/connections/${session.id}/confirm`,'POST',{profileUrl:identity.profileUrl}),request(`/v1/social/connections/${session.id}/confirm`,'POST',{profileUrl:identity.profileUrl})]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(engine.db.prepare('SELECT id FROM provider_accounts').all()).toHaveLength(1);expect(JSON.parse(readFileSync(join(folder,'bindings.json'),'utf8'))[identity.profileUrl]).toBeTruthy();
 });
});
