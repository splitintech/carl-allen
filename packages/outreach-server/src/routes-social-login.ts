import type {Hono} from 'hono';
import {z} from 'zod';
import {ensurePublishingMediaLocal,accountLifecycle,audit,ConflictError,NotFoundError,requireRole,type Engine} from '@splitin/outreach-core';
import {auth,type ServerEnv} from './app';
import {cancelLogin,confirmLogin,inspectLogin,loginView,ownedLogin,startLogin,pauseLogin,resumeLogin,type LoginDependencies} from './social-login';
export function registerSocialLoginRoutes(app:Hono<ServerEnv>,engine:Engine,dependencies?:LoginDependencies){
 const channel=z.enum(['linkedin','x','instagram','tiktok']);
 app.post('/v1/social/connections',async c=>c.json(await startLogin(engine,auth(c),z.object({channel,accountId:z.string().optional()}).strict().parse(await c.req.json()),dependencies),201));
 app.get('/v1/social/connections',c=>{const ctx=auth(c);requireRole(ctx,'admin');const rows=engine.db.prepare("SELECT id FROM social_login_sessions WHERE workspace_id=? AND principal_id=? AND status IN ('awaiting_login','identified','paused') AND expires_at>? ORDER BY updated_at DESC").all<{id:string}>(ctx.workspaceId,ctx.principalId,engine.now());return c.json({sessions:rows.map(row=>loginView(ownedLogin(engine,ctx,row.id)))});});
 app.get('/v1/social/connections/:id',c=>c.json(loginView(ownedLogin(engine,auth(c),c.req.param('id')))));
 app.post('/v1/social/connections/:id/check',async c=>c.json(await inspectLogin(engine,auth(c),c.req.param('id'),false,dependencies)));
 app.post('/v1/social/connections/:id/open',async c=>c.json(await inspectLogin(engine,auth(c),c.req.param('id'),true,dependencies)));
 app.post('/v1/social/connections/:id/confirm',async c=>c.json(await confirmLogin(engine,auth(c),c.req.param('id'),z.object({profileUrl:z.string().url(),name:z.string().trim().min(1).max(200).optional()}).strict().parse(await c.req.json()),dependencies)));
 app.post('/v1/social/connections/:id/cancel',async c=>c.json(await cancelLogin(engine,auth(c),c.req.param('id'),dependencies)));
 app.post('/v1/social/connections/:id/pause',async c=>c.json(await pauseLogin(engine,auth(c),c.req.param('id'),dependencies)));
 app.post('/v1/social/connections/:id/resume',async c=>c.json(await resumeLogin(engine,auth(c),c.req.param('id'),dependencies)));
 app.post('/v1/accounts/:id/qualify',async c=>{
  const ctx=auth(c);requireRole(ctx,'operator');const id=c.req.param('id');
  const account=engine.db.prepare('SELECT * FROM provider_accounts WHERE workspace_id=? AND id=?').get<{id:string;provider:string;external_account_id:string;sender_identity:string;secret_ref:string;capabilities:string}>(ctx.workspaceId,id);
  if(!account)throw new NotFoundError('provider account');
  if(accountLifecycle(engine,ctx.workspaceId,id))throw new ConflictError('Reconnect and confirm this account before checking publishing formats');
  const adapter=engine.adapters.get(account.provider);if(!adapter?.account.qualifyPublishing)throw new ConflictError('This account has no native publishing qualification');
  const input=z.object({format:z.enum(['feed','carousel','video','reel']).optional(),mediaIds:z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).max(20).optional()}).strict().parse(await c.req.json());const mediaUrls:string[]=[];for(const mediaId of input.mediaIds??[]){const media=await ensurePublishingMediaLocal(engine,ctx,mediaId);mediaUrls.push('outreach-media://'+media.sha256);}
  const qualification=await adapter.account.qualifyPublishing({workspaceId:ctx.workspaceId,account:{id,provider:account.provider,externalAccountId:account.external_account_id,sender:JSON.parse(account.sender_identity)},secretRef:account.secret_ref,secrets:engine.exec.secrets,traceId:ctx.traceId,signal:AbortSignal.timeout(240000),now:engine.now},{format:input.format,mediaUrls});
  engine.db.prepare('UPDATE provider_accounts SET capabilities=? WHERE workspace_id=? AND id=?').run(JSON.stringify({...JSON.parse(account.capabilities),publishingQualification:qualification}),ctx.workspaceId,id);
  audit(engine.db,ctx,engine.now(),'provider_account',id,'publishing_qualified',{formats:qualification.formats,accountType:qualification.accountType});return c.json({qualification});
 });
}
