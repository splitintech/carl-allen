import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkPackageManifest, sha256Hex } from '@splitin/outreach-contracts';
import { workspaceHome,workspaceStorage,listPeople,addSuppression, authenticate, bootstrapWorkspace, createApiToken, decideApproval, prepareWorkPackage, repairWorkPackage, storeWorkPackage } from '@splitin/outreach-core';
import { createApp } from './app';
import { makeResultsEnv, type ResultsTestEnv } from './results.test-util';
type HomeResponse={home:ReturnType<typeof workspaceHome>};type StorageResponse={storage:ReturnType<typeof workspaceStorage>};type PeopleResponse={people:ReturnType<typeof listPeople>};
const opened:ResultsTestEnv[]=[];const directories:string[]=[];
afterEach(()=>{for(const f of opened.splice(0))f.engine.db.close();for(const p of directories.splice(0))rmSync(p,{recursive:true,force:true});vi.unstubAllEnvs();});
async function fixture(){
 const f=await makeResultsEnv();opened.push(f);const app=createApp({engine:f.engine});
 bootstrapWorkspace(f.engine.db,{workspaceId:'foreign',name:'Foreign',adminRef:'foreign-admin',adminName:'Foreign'},f.now());
 const other=authenticate(f.engine.db,'foreign','foreign-admin','test','other');
 const tokens=Object.fromEntries([['admin',f.admin],['viewer',f.viewer],['operator',f.operator],['foreign',other]].map(([role,context])=>{const ctx=context as typeof f.admin;return [role,createApiToken(f.engine,role==='foreign'?other:f.admin,{principalId:ctx.principalId,name:'dashboard',roleCeiling:role==='viewer'?'viewer':role==='operator'?'operator':'admin',ttlDays:1}).token];}));
 const request=(path:string,method='GET',body?:unknown,role='viewer')=>app.request(path,{method,headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {f,request};
}
function outreach(f:ResultsTestEnv){
 const manifest=WorkPackageManifest.parse({schemaVersion:1,packageId:'outreach-only',revision:1,name:'Outreach review',timezone:'UTC',accountRefs:[{id:'mail',channel:'email',label:'Mailbox'}],contacts:[{id:'ada',name:'Ada Research',email:'ada@example.invalid',sources:['https://example.invalid/research'],notes:'Retain this source.',consentBasis:'legitimate_interest',jurisdiction:'US'}],outreachSequences:[{id:'intro',name:'Reviewed intro',contacts:['ada'],scheduledFor:new Date(f.now()+20*86400000).toISOString(),steps:[{id:'email',accountRef:'mail',channel:'email',kind:'email',subject:'Hello {{first_name}}',text:'Exact message for {{first_name}}',waitHours:0,waitFor:'elapsed'}]}]});
 const html='<script type="application/json" id="carl-allen-manifest">'+JSON.stringify(manifest)+'</script>';
 const pack=storeWorkPackage(f.engine,f.operator,{name:manifest.name,html,manifest,sourceHash:sha256Hex(html),issues:[]});repairWorkPackage(f.engine,f.operator,pack.id,{accountMap:{mail:f.accountId}});
 return prepareWorkPackage(f.engine,f.operator,pack.id);
}
describe('real workspace dashboard and storage reads',()=>{
 it('counts and links outreach-only reviews, then reports future approved email work without a publication dependency',async()=>{
  const {f,request}=await fixture();const prepared=outreach(f);expect(prepared.preview.issues).toEqual([]);
  const before=await(await request('/v1/home')).json() as HomeResponse;expect(before.home.summary).toMatchObject({pendingReviews:1,upcoming:0});expect(before.home.pendingReviews).toMatchObject([{id:prepared.authorizationId,kind:'package',subjectId:prepared.package.id,name:'Outreach review'}]);
  decideApproval(f.engine,f.approver,{approvalId:prepared.authorizationId!,operationHash:prepared.operationHash!,decision:'approved'});
  const after=await(await request('/v1/home')).json() as HomeResponse;expect(after.home.summary).toMatchObject({pendingReviews:0,upcoming:1});expect(after.home.upcoming).toMatchObject([{kind:'email.send',channel:'email',title:'Hello Ada',packageId:prepared.package.id}]);expect(f.engine.db.prepare("SELECT COUNT(*) n FROM scheduled_actions WHERE kind='social.publish'").get()).toEqual({n:0});
  const foreign=await(await request('/v1/home','GET',undefined,'foreign')).json() as HomeResponse;expect(foreign.home.summary).toEqual({pendingReviews:0,upcoming:0,needsAttention:0,connectionIssues:0});expect(foreign.home.pendingReviews).toEqual([]);expect(foreign.home.upcoming).toEqual([]);
 });
 it('reports uncertain outcomes and account holds without labeling them delivered, and hides expired reviews',async()=>{
  const {f,request}=await fixture();outreach(f);f.engine.db.prepare("UPDATE scheduled_actions SET state='uncertain',state_reason='native_receipt_missing'").run();f.engine.db.prepare("UPDATE provider_accounts SET health='reauth_required',health_detail='Sign in again' WHERE id=?").run(f.accountId);f.engine.db.prepare('UPDATE approvals SET expires_at=?').run(f.now()-1);
  const {home}=await(await request('/v1/home')).json() as HomeResponse;expect(home.summary).toMatchObject({pendingReviews:0,needsAttention:1,connectionIssues:1});expect(home.recent).toMatchObject([{state:'uncertain',reason:'native_receipt_missing'}]);expect(home.connectionIssues).toMatchObject([{id:f.accountId,detail:'Sign in again'}]);expect(home.pendingReviews).toEqual([]);
 });
 it('shows real upload reservations, cancellation and administrator quota changes without allocating quota-sized files',async()=>{
  const {request}=await fixture();const directory=mkdtempSync(join(tmpdir(),'sidebar-storage-'));directories.push(directory);vi.stubEnv('OUTREACH_MEDIA_DIR',directory);
  const size=5*1024*1024;const upload=await(await request('/v1/publishing/uploads','POST',{name:'reviewed.mp4',mime:'video/mp4',size},'operator')).json() as {uploadId:string};expect(upload.uploadId).toBeTruthy();
  const {storage}=await(await request('/v1/settings/media')).json() as StorageResponse;expect(storage).toMatchObject({quotaBytes:50*1024**3,usedBytes:0,reservedBytes:size,activeUploads:1,files:0});
  expect((await request('/v1/settings/media','PATCH',{quotaBytes:60*1024**3},'viewer')).status).toBe(403);expect((await request('/v1/settings/media','PATCH',{quotaBytes:60*1024**3},'admin')).status).toBe(200);
  expect((await request('/v1/publishing/uploads/'+upload.uploadId,'DELETE',undefined,'operator')).status).toBe(200);expect((await(await request('/v1/settings/media')).json() as StorageResponse).storage).toMatchObject({quotaBytes:60*1024**3,reservedBytes:0,activeUploads:0});
  expect((await(await request('/v1/settings/media','GET',undefined,'foreign')).json() as StorageResponse).storage).toMatchObject({quotaBytes:50*1024**3,reservedBytes:0});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXuoAAAAASUVORK5CYII=','base64');const saved=await(await request('/v1/publishing/uploads','POST',{name:'verified.png',mime:'image/png',size:png.length},'operator')).json() as {uploadId:string};expect((await request('/v1/publishing/uploads/'+saved.uploadId+'/chunks','POST',{index:0,data:png.toString('base64')},'operator')).status).toBe(200);expect((await request('/v1/publishing/uploads/'+saved.uploadId+'/complete','POST',{},'operator')).status).toBe(200);expect((await(await request('/v1/settings/media')).json() as StorageResponse).storage).toMatchObject({usedBytes:png.length,files:1,reservedBytes:0,activeUploads:0});
 });
 it('returns retained people sources and channel consent, reflects suppression and rejects unauthenticated sidebar reads',async()=>{
  const {f,request}=await fixture();outreach(f);const {people}=await(await request('/v1/people')).json() as PeopleResponse;expect(people).toMatchObject([{name:'Ada Research',status:'Reviewed basis recorded',sources:['https://example.invalid/research'],notes:'Retain this source.',points:[{value:'ada@example.invalid',consentBasis:'legitimate_interest',jurisdiction:'US'}]}]);
  addSuppression(f.engine.db,{workspaceId:'ws',scope:'global',value:'ada@example.invalid',reason:'opt_out',source:'fixture'},f.now());expect((await(await request('/v1/people')).json() as PeopleResponse).people[0]!.status).toBe('Contact restriction');expect((await(await request('/v1/people','GET',undefined,'foreign')).json() as PeopleResponse).people).toEqual([]);
  expect((await request('/v1/home','GET',undefined,'missing')).status).toBe(403);expect((await request('/v1/settings/media','GET',undefined,'missing')).status).toBe(403);
 });
});
