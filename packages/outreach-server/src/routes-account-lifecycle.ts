import type {Hono} from 'hono';
import {z} from 'zod';
import {disableProviderAccount,NotFoundError,requireRole,type Engine} from '@splitin/outreach-core';
import {auth,type ServerEnv} from './app';
import {supervisedBrowser,updateLoginBindingsAsync} from './social-login-storage';
export function registerAccountLifecycleRoutes(app:Hono<ServerEnv>,engine:Engine,browser=supervisedBrowser){
 app.post('/v1/accounts/:id/disconnect',async c=>{
  const ctx=auth(c);requireRole(ctx,'admin');const id=c.req.param('id');const input=z.object({reason:z.string().trim().min(1).max(1000),profilePolicy:z.enum(['retain','delete'])}).strict().parse(await c.req.json());
  const account=engine.db.prepare('SELECT external_account_id,provider FROM provider_accounts WHERE workspace_id=? AND id=?').get<{external_account_id:string;provider:string}>(ctx.workspaceId,id);if(!account)throw new NotFoundError('provider account');
  if(account.provider!=='social-browser')return c.json({error:'Use the mailbox disconnect flow to revoke its grant'},409);
  const result=disableProviderAccount(engine,ctx,id,{...input,state:'disconnected'});let removed=false;let detail=input.profilePolicy==='retain'?'The private sign-in profile is retained for reconnection.':'Profile removal is held until pending/uncertain operations are reviewed.';
  if(result.profile.mayRemove){try{await updateLoginBindingsAsync(async bindings=>{
   const binding=bindings[account.external_account_id];if(!binding){detail='No stored browser binding remains.';return;}
   const connection=binding.connectionId??account.external_account_id;
   if(engine.db.prepare('SELECT id FROM provider_accounts WHERE external_account_id=? AND id<>?').all(account.external_account_id,id).length){detail='Other accounts reference this profile. It was retained.';return;}
   if(Object.entries(bindings).some(([key,value])=>key!==account.external_account_id&&(value.connectionId??key)===connection)){detail='The profile is shared by other publishing targets and was retained.';return;}
   const sessions=engine.db.prepare("SELECT id FROM social_login_sessions WHERE connection_key=? AND lease_id IS NOT NULL AND status IN ('awaiting_login','identified') AND expires_at>?").all(connection,engine.now());if(sessions.length){detail='The browser is reserved for an active sign-in; its profile was retained.';return;}
   await browser('/browser/remove',{connectionId:connection});delete bindings[account.external_account_id];removed=true;detail='The private browser profile was removed.';
  });}catch{detail='The profile is busy or its runtime could not confirm safe removal. The account is disconnected and its profile was retained.';}}
  return c.json({...result,profile:{...result.profile,removed,detail}});
 });
}
