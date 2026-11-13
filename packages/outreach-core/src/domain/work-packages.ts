import { configuredMediaStore } from './r2-storage';
import { digestCanonical, ulid, WorkPackageManifest, HtmlImportAction, type WorkManifest, type WorkPackageIssue } from '@splitin/outreach-contracts';
import { ConflictError, NotFoundError, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { revokePackagePlan } from './cloud-plans';
import { blockingWorkPackageIssues, normalizeWorkPackageIssues, workPackageImportIssues, workPackageNotes } from './work-package-issues';
import { resolveWorkPackage } from './work-package-validation';
interface Row {original_html:string;extracted_data:string;id:string;name:string;revision:number;status:string;manifest:string;issues:string;account_map:string;media_map:string;authorization_id:string|null;source_hash:string;created_at:number;updated_at:number;external_id:string}
export interface WorkPackage {extractedActions:HtmlImportAction[];extractedTables:Record<string,string>[][];extractedText:string;id:string;name:string;revision:number;status:string;manifest:WorkManifest|null;issues:WorkPackageIssue[];accountMap:Record<string,string>;mediaMap:Record<string,string>;authorizationId:string|null;operationHash:string|null;cloudReceipt:{accepted:boolean;stored:boolean;originalRemoteReady:boolean;executionReady:boolean;placement:string;sourceHash:string;packageId:string};createdAt:number;updatedAt:number}
export function getWorkPackage(env:DomainEnv,ctx:AuthContext,id:string):WorkPackage {
 requireRole(ctx,'viewer');const r=env.db.prepare('SELECT * FROM work_packages WHERE workspace_id=? AND id=?').get<Row>(ctx.workspaceId,id);
 if(!r)throw new NotFoundError('work package');
 const a=r.authorization_id?env.db.prepare('SELECT operation_hash FROM approvals WHERE id=?').get<{operation_hash:string}>(r.authorization_id):null;
 const extracted=JSON.parse(r.extracted_data) as {tables?:Record<string,string>[][];text?:string;originalRemoteReady?:boolean;actions?:HtmlImportAction[];importIssues?:WorkPackageIssue[]};
 const manifest=JSON.parse(r.manifest) as WorkManifest|null;const stored=typeof r.original_html==='string'&&r.original_html.length>0;const inDaytona=Boolean(process.env.DAYTONA_SANDBOX_ID);
 const originalRemoteReady=stored&&(configuredMediaStore()?extracted.originalRemoteReady===true:inDaytona);const executionReady=inDaytona&&originalRemoteReady&&['awaiting_approval','scheduled'].includes(r.status);
 return {extractedActions:extracted.actions??[],extractedTables:extracted.tables??[],extractedText:extracted.text??'',id:r.id,name:r.name,revision:r.revision,status:r.status,manifest,issues:normalizeWorkPackageIssues(JSON.parse(r.issues) as WorkPackageIssue[],Boolean(manifest)),accountMap:JSON.parse(r.account_map) as Record<string,string>,mediaMap:JSON.parse(r.media_map) as Record<string,string>,authorizationId:r.authorization_id,operationHash:a?.operation_hash??null,cloudReceipt:{accepted:executionReady,stored,originalRemoteReady,executionReady,placement:inDaytona?'daytona':'local',sourceHash:r.source_hash,packageId:r.id},createdAt:r.created_at,updatedAt:r.updated_at};
}
export function listWorkPackages(env:DomainEnv,ctx:AuthContext,cursor?:string,limit=100):WorkPackage[] {
 requireRole(ctx,'viewer');return env.db.prepare('SELECT id FROM work_packages WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?').all<{id:string}>(ctx.workspaceId,cursor??'',Math.min(200,Math.max(1,limit))).map(r=>getWorkPackage(env,ctx,r.id));
}
export function storeWorkPackage(env:DomainEnv,ctx:AuthContext,input:{name:string;html:string;manifest:WorkManifest|null;issues:WorkPackageIssue[];sourceHash:string;tables?:Record<string,string>[][];text?:string;actions?:HtmlImportAction[]}):WorkPackage {
 requireRole(ctx,'operator');if(input.name.length>200||Buffer.byteLength(input.html)>20*1024*1024)throw new ConflictError('Package is too large');
 const actions=HtmlImportAction.array().max(2000).parse(input.actions??[]);
 return env.db.transaction(()=>{
  const m=input.manifest?WorkPackageManifest.parse(input.manifest):null;
  const importIssues=normalizeWorkPackageIssues(input.issues,Boolean(m));
  const external=m?.packageId??('report-'+input.sourceHash);const revision=m?.revision??1;
  const old=env.db.prepare('SELECT id,source_hash FROM work_packages WHERE workspace_id=? AND external_id=? AND revision=?').get<{id:string;source_hash:string}>(ctx.workspaceId,external,revision);
  if(old){if(old.source_hash!==input.sourceHash)throw new ConflictError('This package revision already contains different bytes; increase its revision');return getWorkPackage(env,ctx,old.id);}
  const prior=env.db.prepare('SELECT id,revision FROM work_packages WHERE workspace_id=? AND external_id=? ORDER BY revision DESC LIMIT 1').get<{id:string;revision:number}>(ctx.workspaceId,external);
  if(prior&&revision<=prior.revision)throw new ConflictError('Import a revision newer than the latest package');
  if(prior)revokePackagePlan(env,ctx,prior.id,{supersede:true});
  const id=ulid(env.now());const status=m&&!blockingWorkPackageIssues(importIssues).length?'ready_for_review':'needs_repair';
  env.db.prepare('INSERT INTO work_packages(id,workspace_id,external_id,revision,name,source_hash,original_html,manifest,status,issues,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ctx.workspaceId,external,revision,m?.name??input.name,input.sourceHash,input.html,JSON.stringify(m),status,JSON.stringify(importIssues),env.now(),env.now());
  env.db.prepare('UPDATE work_packages SET extracted_data=? WHERE id=?').run(JSON.stringify({tables:input.tables??[],text:input.text??'',actions,importIssues}),id);
  audit(env.db,ctx,env.now(),'work_package',id,'imported',{sourceHash:input.sourceHash,revision,priorRevision:prior?.id??null});
  return getWorkPackage(env,ctx,id);
 });
}
export function repairWorkPackage(env:DomainEnv,ctx:AuthContext,id:string,input:{manifest?:unknown;accountMap?:Record<string,string>;mediaMap?:Record<string,string>}):WorkPackage {
 requireRole(ctx,'operator');return env.db.transaction(()=>{
  const old=getWorkPackage(env,ctx,id);
  const manifest=WorkPackageManifest.parse(input.manifest??old.manifest);
  const accountMap=Object.fromEntries(Object.entries(input.accountMap??old.accountMap).filter(([,value])=>value.trim()));
  const mediaMap=Object.fromEntries(Object.entries(input.mediaMap??old.mediaMap).filter(([,value])=>value.trim()));
  for(const account of Object.values(accountMap))if(!env.db.prepare('SELECT id FROM provider_accounts WHERE workspace_id=? AND id=?').get(ctx.workspaceId,account))throw new NotFoundError('account');
  for(const asset of Object.values(mediaMap))if(!env.db.prepare('SELECT id FROM publishing_media WHERE workspace_id=? AND id=?').get(ctx.workspaceId,asset))throw new NotFoundError('media asset');
  revokePackagePlan(env,ctx,id);
  const raw=env.db.prepare('SELECT extracted_data FROM work_packages WHERE id=?').get<{extracted_data:string}>(id)!;
  const extracted=JSON.parse(raw.extracted_data) as Record<string,unknown>;
  const priorImportIssues=workPackageImportIssues(env,ctx,id,old.issues);
  // Only an explicit schema-validated replacement resolves original manifest errors.
  const importIssues=input.manifest===undefined?priorImportIssues:workPackageNotes(priorImportIssues);
  env.db.prepare("UPDATE work_packages SET name=?,manifest=?,account_map=?,media_map=?,status='ready_for_review',issues=?,authorization_id=NULL,extracted_data=?,updated_at=? WHERE id=?").run(manifest.name,JSON.stringify(manifest),JSON.stringify(accountMap),JSON.stringify(mediaMap),JSON.stringify(importIssues),JSON.stringify({...extracted,importIssues}),env.now(),id);
  const {issues}=resolveWorkPackage(env,ctx,getWorkPackage(env,ctx,id));
  env.db.prepare('UPDATE work_packages SET status=?,issues=? WHERE id=?').run(issues.length?'needs_repair':'ready_for_review',JSON.stringify([...workPackageNotes(importIssues),...issues]),id);
  audit(env.db,ctx,env.now(),'work_package',id,'repaired',{manifestHash:digestCanonical(manifest)});
  return getWorkPackage(env,ctx,id);
 });
}
export function workPackageOriginal(env:DomainEnv,ctx:AuthContext,id:string):string {getWorkPackage(env,ctx,id);return env.db.prepare('SELECT original_html FROM work_packages WHERE id=?').get<{original_html:string}>(id)!.original_html;}
