import {ulid} from '@splitin/outreach-contracts';
import {audit,checkAccountHealth,reactivateProviderAccount,ConflictError,ForbiddenError,NotFoundError,requireRole,type AuthContext,type Engine} from '@splitin/outreach-core';
import {registerConfiguredAccount} from './browser-binding';
import {newLoginBinding,readLoginBindings,supervisedBrowser,updateLoginBindings} from './social-login-storage';
export interface LoginIdentity{profileUrl:string;name:string;channel:string}
export interface LoginRow{id:string;workspace_id:string;principal_id:string;channel:string;connection_key:string;binding_key:string;account_id:string|null;lease_id:string|null;identity:string|null;status:string;detail:string|null;created_at:number;expires_at:number;updated_at:number}
export interface LoginDependencies{browser:(path:string,input:unknown)=>Promise<Record<string,unknown>>}
export const defaultLoginDependencies:LoginDependencies={browser:supervisedBrowser};
export function ownedLogin(engine:Engine,ctx:AuthContext,id:string):LoginRow{
 requireRole(ctx,'admin');const row=engine.db.prepare('SELECT * FROM social_login_sessions WHERE workspace_id=? AND principal_id=? AND id=?').get<LoginRow>(ctx.workspaceId,ctx.principalId,id);
 if(!row)throw new NotFoundError('browser connection session');return row;
}
export function loginView(row:LoginRow){return{id:row.id,channel:row.channel,accountId:row.account_id,status:row.status,identity:row.identity?JSON.parse(row.identity) as LoginIdentity:null,detail:row.detail,expiresAt:row.expires_at,loginUrl:'/browser-login?session='+encodeURIComponent(row.id)};}
export async function startLogin(engine:Engine,ctx:AuthContext,input:{channel:string;accountId?:string},deps=defaultLoginDependencies){
 requireRole(ctx,'admin');let bindingKey:string;let connectionKey:string;
 if(input.accountId){
  const account=engine.db.prepare('SELECT external_account_id FROM provider_accounts WHERE workspace_id=? AND id=?').get<{external_account_id:string}>(ctx.workspaceId,input.accountId);if(!account)throw new NotFoundError('provider account');
  let binding=readLoginBindings()[account.external_account_id];if(!binding){
   const url=new URL(account.external_account_id);const hosts:Record<string,string>={linkedin:'www.linkedin.com',instagram:'www.instagram.com',x:'x.com',tiktok:'www.tiktok.com'};
   if(url.protocol!=='https:'||url.hostname!==hosts[input.channel])throw new ConflictError('Reconnect this legacy account through administrator profile recovery');
   const key='login:'+ulid(engine.now());binding={...newLoginBinding(input.channel,key),expectedProfileUrl:account.external_account_id};const created=binding;updateLoginBindings(bindings=>{bindings[account.external_account_id]=created;});
  }if(binding.kind!==input.channel)throw new ConflictError('This account does not use the selected browser platform');
  bindingKey=account.external_account_id;connectionKey=binding.connectionId??bindingKey;
 }else{
  const active=engine.db.prepare("SELECT id FROM social_login_sessions WHERE workspace_id=? AND status IN ('awaiting_login','identified') AND expires_at>?").all(ctx.workspaceId,engine.now());if(active.length>=2)throw new ConflictError('Finish an existing login first; two browser connections may be active');
  bindingKey='login:'+ulid(engine.now());connectionKey=bindingKey;updateLoginBindings(bindings=>{bindings[bindingKey]=newLoginBinding(input.channel,bindingKey);});
 }
 const lease=await deps.browser('/browser/acquire',{connectionId:connectionKey,human:true});if(typeof lease.leaseId!=='string')throw new ConflictError('Browser did not reserve a login session');
 try{
  await deps.browser('/browser/login/focus',{leaseId:lease.leaseId});
  const now=engine.now(),id=ulid(now);engine.db.prepare("INSERT INTO social_login_sessions(id,workspace_id,principal_id,channel,connection_key,binding_key,account_id,lease_id,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,ctx.workspaceId,ctx.principalId,input.channel,connectionKey,bindingKey,input.accountId??null,lease.leaseId,now,now+120000,now);
  audit(engine.db,ctx,now,'browser_login',id,'started',{channel:input.channel,accountId:input.accountId??null});return loginView(ownedLogin(engine,ctx,id));
 }catch(error){await deps.browser('/browser/release',{leaseId:lease.leaseId}).catch(()=>undefined);throw error;}
}
async function activeLogin(engine:Engine,ctx:AuthContext,id:string,deps:LoginDependencies){
 const row=ownedLogin(engine,ctx,id);if(['connected','cancelled','expired'].includes(row.status))throw new ConflictError('This login session has ended');
 if(engine.now()>row.expires_at||engine.now()>row.created_at+1800000){
  if(row.lease_id)await deps.browser('/browser/release',{leaseId:row.lease_id}).catch(()=>undefined);
  engine.db.prepare("UPDATE social_login_sessions SET status='expired',lease_id=NULL WHERE id=?").run(id);throw new ConflictError('Login session expired. Start a new connection; your saved profile remains private.');
 }
 if(!row.lease_id)throw new ConflictError('Browser reservation was lost; reconnect this account');
 await deps.browser('/browser/renew',{leaseId:row.lease_id});return row;
}
export async function inspectLogin(engine:Engine,ctx:AuthContext,id:string,focus=false,deps=defaultLoginDependencies,confirming=false){
 if(ownedLogin(engine,ctx,id).status==='confirming'&&!confirming)throw new ConflictError('This account confirmation is already in progress');
 const row=await activeLogin(engine,ctx,id,deps);
 let desktopPath:string|undefined;if(focus){const view=await deps.browser('/browser/login/focus',{leaseId:row.lease_id});if(typeof view.desktopPath!=='string'||!/^websockify\?token=[a-f0-9]{64}$/.test(view.desktopPath))throw new ConflictError('The runtime does not support private session-bound browser views; upgrade it before connecting accounts');desktopPath=view.desktopPath;}
 const found=await deps.browser('/browser/login/inspect',{leaseId:row.lease_id});let identity:LoginIdentity|null=null;
 if(found.identity&&typeof found.identity==='object'){
  const value=found.identity as LoginIdentity;const url=new URL(value.profileUrl);
  const hosts:Record<string,string>={linkedin:'www.linkedin.com',instagram:'www.instagram.com',x:'x.com',tiktok:'www.tiktok.com'};
  if(value.channel!==row.channel||url.protocol!=='https:'||url.hostname!==hosts[row.channel]||url.search||url.hash||url.username||url.password)throw new ForbiddenError('Browser returned an invalid identity');
  identity={channel:row.channel,profileUrl:value.profileUrl,name:value.name.slice(0,200)};
  const binding=readLoginBindings()[row.binding_key];const expected=binding?.loginProfileUrl??binding?.expectedProfileUrl;
  if(row.account_id&&expected&&expected!==identity.profileUrl)throw new ConflictError('A different account is signed in. Switch accounts in the private browser; the saved binding will not be changed.');
 }
 engine.db.prepare('UPDATE social_login_sessions SET identity=?,status=?,detail=?,expires_at=?,updated_at=? WHERE id=?').run(identity?JSON.stringify(identity):null,confirming?'confirming':identity?'identified':'awaiting_login',identity?null:'Finish sign-in and any verification challenge in the private browser.',Math.min(engine.now()+120000,row.created_at+1800000),engine.now(),id);
 return {...loginView(ownedLogin(engine,ctx,id)),...(desktopPath?{desktopPath}:{})};
}
export async function confirmLogin(engine:Engine,ctx:AuthContext,id:string,input:{profileUrl:string;name?:string},deps=defaultLoginDependencies){
 const prior=ownedLogin(engine,ctx,id);if(prior.status==='connected')return loginView(prior);
 if(prior.status!=='identified'||!prior.identity)throw new ConflictError('Wait for account identity verification, then review and confirm it');
 if(!engine.db.prepare("UPDATE social_login_sessions SET status='confirming' WHERE id=? AND status='identified' AND identity=?").run(id,prior.identity).changes)throw new ConflictError('This account confirmation is already in progress');
 try{
 await inspectLogin(engine,ctx,id,false,deps,true);const row=ownedLogin(engine,ctx,id);const identity=row.identity?JSON.parse(row.identity) as LoginIdentity:null;
 if(!identity||identity.profileUrl!==input.profileUrl)throw new ConflictError('The signed-in identity changed. Review it again before confirming.');
 if(!row.account_id){updateLoginBindings(bindings=>{
  if(bindings[identity.profileUrl]&&bindings[identity.profileUrl]!.connectionId!==row.connection_key)throw new ConflictError('This identity is already connected. Reconnect the existing account instead.');
  const binding=bindings[row.binding_key];if(!binding)throw new ConflictError('Login profile is unavailable');
  bindings[identity.profileUrl]={...binding,expectedProfileUrl:identity.profileUrl};if(row.binding_key!==identity.profileUrl)delete bindings[row.binding_key];
 });engine.db.prepare('UPDATE social_login_sessions SET binding_key=? WHERE id=?').run(identity.profileUrl,id);}
 // Register after releasing the human lease so the adapter health check can acquire the same login.
 await deps.browser('/browser/release',{leaseId:row.lease_id});engine.db.prepare('UPDATE social_login_sessions SET lease_id=NULL WHERE id=?').run(id);
 const handle=new URL(identity.profileUrl).pathname.replace(/[^a-z0-9_.-]/gi,'').slice(0,50)||'account';
 let accountId:string;try{accountId=row.account_id??await registerConfiguredAccount(engine,ctx,{provider:'social-browser',externalAccountId:identity.profileUrl,profileUrl:identity.profileUrl,sender:{name:input.name?.trim()||identity.name,address:`${handle}@social.invalid`},purposes:['social_publishing',...(['linkedin','instagram'].includes(row.channel)?['social_messaging' as const,'manual_correspondence' as const]:[])],secretRef:'env:OUTREACH_BROWSER_SESSION',executionPlacement:'daytona-browser'});}catch(error){engine.db.prepare("UPDATE social_login_sessions SET status='paused',expires_at=?,detail=? WHERE id=?").run(engine.now()+86400000,'Registration interrupted. Resume this connection to retry.',id);throw error;}
 engine.db.prepare("UPDATE provider_accounts SET health='ok',health_detail=NULL WHERE workspace_id=? AND id=?").run(ctx.workspaceId,accountId);reactivateProviderAccount(engine,ctx,accountId);await checkAccountHealth(engine,accountId);
 engine.db.prepare("UPDATE social_login_sessions SET account_id=?,status='connected',updated_at=? WHERE id=?").run(accountId,engine.now(),id);audit(engine.db,ctx,engine.now(),'browser_login',id,'confirmed',{accountId,profileUrl:identity.profileUrl});return loginView(ownedLogin(engine,ctx,id));
 }finally{engine.db.prepare("UPDATE social_login_sessions SET status=CASE WHEN lease_id IS NULL THEN 'paused' ELSE 'identified' END WHERE id=? AND status='confirming'").run(id);}
}
export async function cancelLogin(engine:Engine,ctx:AuthContext,id:string,deps=defaultLoginDependencies){const row=ownedLogin(engine,ctx,id);if(row.lease_id)await deps.browser('/browser/release',{leaseId:row.lease_id}).catch(()=>undefined);engine.db.prepare("UPDATE social_login_sessions SET status=CASE WHEN status='connected' THEN status ELSE 'cancelled' END,lease_id=NULL,updated_at=? WHERE id=?").run(engine.now(),id);return{cancelled:true};}
export async function pauseLogin(engine:Engine,ctx:AuthContext,id:string,deps=defaultLoginDependencies){const row=ownedLogin(engine,ctx,id);if(row.status==='connected')return loginView(row);if(row.lease_id)await deps.browser('/browser/release',{leaseId:row.lease_id}).catch(()=>undefined);engine.db.prepare("UPDATE social_login_sessions SET status='paused',lease_id=NULL,expires_at=?,updated_at=? WHERE id=?").run(engine.now()+86400000,engine.now(),id);return loginView(ownedLogin(engine,ctx,id));}
export async function resumeLogin(engine:Engine,ctx:AuthContext,id:string,deps=defaultLoginDependencies){const row=ownedLogin(engine,ctx,id);if(['expired','cancelled'].includes(row.status)||row.expires_at<engine.now())throw new ConflictError('Saved connection expired; start a new sign-in');if(row.status!=='paused')return loginView(row);if(row.expires_at<engine.now())throw new ConflictError('Saved connection expired; start a new sign-in');const lease=await deps.browser('/browser/acquire',{connectionId:row.connection_key,human:true});if(typeof lease.leaseId!=='string')throw new ConflictError('Browser reservation is unavailable');engine.db.prepare("UPDATE social_login_sessions SET status='awaiting_login',lease_id=?,created_at=?,expires_at=?,updated_at=? WHERE id=?").run(lease.leaseId,engine.now(),engine.now()+120000,engine.now(),id);await deps.browser('/browser/login/focus',{leaseId:lease.leaseId});return loginView(ownedLogin(engine,ctx,id));}
