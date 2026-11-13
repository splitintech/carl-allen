import { z } from 'zod';
import { extractWorkPackage, workPackageTemplate } from '@splitin/outreach-import';
import { getWorkspaceExecutionLimits,setWorkspaceExecutionLimits,workspaceStorage,workspaceHome,putImmutableDocument,configuredMediaStore,storeWorkPackage,getWorkPackage,listWorkPackages,repairWorkPackage,prepareWorkPackage,decideApproval,listPeople,listOutreachSequences,pauseOutreachSequence,listInboxThreads,listInboxMonitoring,updateInboxThread,workspaceInsights,listTeam,inviteTeamMember,requireRole,ConflictError, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { auth, type ServerEnv } from './app';
import {stageWorkPackageMedia} from '@splitin/outreach-core';
import { workPackageView } from './work-package-views';
import { registerDocumentJobRoutes } from './routes-document-jobs';
const page=z.object({cursor:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).passthrough();
const repair=z.object({manifest:z.unknown().optional(),accountMap:z.record(z.string(),z.string()).optional(),mediaMap:z.record(z.string(),z.string()).optional()}).strict();
export function registerWorkspaceRoutes(app:Hono<ServerEnv>,engine:Engine):void {
 registerDocumentJobRoutes(app,engine);
 app.get('/v1/home',(c)=>c.json({home:workspaceHome(engine,auth(c))}));
 app.get('/v1/work-packages/template',(c)=>{requireRole(auth(c),'viewer');return c.json({html:workPackageTemplate()});});
 app.post('/v1/work-packages',async(c)=>{
  const input=z.object({name:z.string().min(1).max(200),html:z.string().min(1).max(20*1024*1024)}).strict().parse(await c.req.json());
  let extracted;try{extracted=extractWorkPackage(input.html);}catch(e){throw new ConflictError((e as Error).message);}
  const pkg=storeWorkPackage(engine,auth(c),{...input,...extracted});
  if(configuredMediaStore()){await putImmutableDocument(auth(c).workspaceId,extracted.sourceHash,input.html);
    const row=engine.db.prepare('SELECT extracted_data FROM work_packages WHERE id=?').get<{extracted_data:string}>(pkg.id)!;
    engine.db.prepare('UPDATE work_packages SET extracted_data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.extracted_data),originalRemoteReady:true}),pkg.id);
  }
  return c.json({package:workPackageView(engine,auth(c),getWorkPackage(engine,auth(c),pkg.id))},201);
 });
 app.get('/v1/work-packages',(c)=>{const q=page.parse(c.req.query());const packages=listWorkPackages(engine,auth(c),q.cursor,q.limit).map(pack=>workPackageView(engine,auth(c),pack));return c.json({packages,nextCursor:packages.length===q.limit?packages.at(-1)?.id:null});});
 app.get('/v1/work-packages/:id',(c)=>c.json({package:workPackageView(engine,auth(c),getWorkPackage(engine,auth(c),c.req.param('id')))}));
 app.patch('/v1/work-packages/:id',async(c)=>c.json({package:workPackageView(engine,auth(c),repairWorkPackage(engine,auth(c),c.req.param('id'),repair.parse(await c.req.json())))}));
 app.post('/v1/work-packages/:id/prepare',async(c)=>{await stageWorkPackageMedia(engine,auth(c),c.req.param('id'));const prepared=prepareWorkPackage(engine,auth(c),c.req.param('id'));return c.json({...prepared,package:workPackageView(engine,auth(c),prepared.package)});});
 app.post('/v1/plan-authorizations/:id/approve',async(c)=>{
  const input=z.object({operationHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await c.req.json());const approval=decideApproval(engine,auth(c),{approvalId:c.req.param('id'),decision:'approved',...input});
  const actions=engine.db.prepare('SELECT action_id FROM plan_actions WHERE authorization_id=?').all<{action_id:string}>(approval.id);
  return c.json({approved:true,packageId:approval.subject_id,actionIds:actions.map(a=>a.action_id)});
 });
 app.get('/v1/people',(c)=>{const q=page.parse(c.req.query());const people=listPeople(engine,auth(c),q.cursor,q.limit);return c.json({people,nextCursor:people.length===q.limit?people.at(-1)?.id:null});});
 app.get('/v1/outreach/sequences',(c)=>{const q=page.parse(c.req.query());const sequences=listOutreachSequences(engine,auth(c),q.cursor,q.limit);return c.json({sequences,nextCursor:sequences.length===q.limit?sequences.at(-1)?.id:null});});
 app.post('/v1/outreach/sequences/:id/pause',(c)=>c.json(pauseOutreachSequence(engine,auth(c),c.req.param('id'))));
 app.get('/v1/inbox/monitoring',(c)=>c.json({monitoring:listInboxMonitoring(engine,auth(c))}));
 app.get('/v1/inbox/threads',(c)=>{const q=page.parse(c.req.query());const threads=listInboxThreads(engine,auth(c),q.cursor,q.limit);return c.json({threads,nextCursor:threads.length===q.limit?threads.at(-1)?.id:null});});
 app.patch('/v1/inbox/threads/:id',async(c)=>c.json(updateInboxThread(engine,auth(c),c.req.param('id'),z.object({assignedTo:z.string().nullable().optional(),notes:z.string().max(10000).optional()}).strict().parse(await c.req.json()))));
 app.get('/v1/settings/policy',(c)=>c.json({policy:getWorkspaceExecutionLimits(engine,auth(c))}));
 app.patch('/v1/settings/policy',async(c)=>c.json({policy:setWorkspaceExecutionLimits(engine,auth(c),await c.req.json())}));
 app.get('/v1/settings/media',(c)=>{requireRole(auth(c),'viewer');const storage=workspaceStorage(engine,auth(c));return c.json({...storage,storage});});
 app.patch('/v1/settings/media',async(c)=>{const ctx=auth(c);requireRole(ctx,'admin');const v=z.object({quotaBytes:z.number().int().min(5*1024*1024).max(1024*1024*1024*1024)}).strict().parse(await c.req.json());const row=engine.db.prepare('SELECT settings FROM workspaces WHERE id=?').get<{settings:string}>(ctx.workspaceId)!;engine.db.prepare('UPDATE workspaces SET settings=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.settings),mediaQuotaBytes:v.quotaBytes}),ctx.workspaceId);return c.json(workspaceStorage(engine,ctx));});
 app.get('/v1/insights',(c)=>c.json({metrics:workspaceInsights(engine,auth(c))}));
 app.get('/v1/team',(c)=>c.json(listTeam(engine,auth(c))));
 app.post('/v1/team/invitations',async(c)=>{const v=z.object({email:z.string().email(),roles:z.array(z.enum(['viewer','operator','approver','admin'])).min(1).max(4)}).strict().parse(await c.req.json());return c.json({invitation:inviteTeamMember(engine,auth(c),v.email,v.roles)},201);});
}
