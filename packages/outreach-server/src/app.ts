import { registerReplyPlaybookRoutes } from './routes-reply-playbooks';
import { registerSocialLoginRoutes } from './routes-social-login';
import {registerAccountLifecycleRoutes} from './routes-account-lifecycle';
import {registerInboxReplyRoutes} from './routes-inbox-replies';
import {registerMailboxOAuthRoutes} from './routes-mailbox-oauth';
import {registerMailboxDraftRoutes} from './routes-mailbox-drafts';
import type {MailboxOAuthDependencies} from './mailbox-oauth-storage';
import type {LoginDependencies} from './social-login';
import { registerWorkspaceManagementRoutes } from './routes-workspace-management';
import { handleRemoteMcp } from '@splitin/outreach-mcp';
import { authenticateCloudRequest } from './cloud-auth';
import { registerWorkspaceRoutes } from './routes-workspace';
import { registerPublishingRoutes } from './routes-publishing';
import { registerAuthoringRoutes } from './routes-authoring';
import { ulid } from '@splitin/outreach-contracts';
import { authenticateToken, ForbiddenError, type AuthContext, type Engine } from '@splitin/outreach-core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { toApiError } from './errors';
import { registerCampaignRoutes } from './routes-campaigns';
import { registerOperationRoutes } from './routes-operations';
import { registerPublicRoutes } from './routes-public';

export interface ServerEnv {
  Variables: { auth: AuthContext; traceId: string };
}

export type ServerContext = Context<ServerEnv>;

export interface ServerOptions {
  readonly engine: Engine;
  /** JSON bodies; imports have their own larger limit. */
  readonly maxJsonBytes?: number;
  readonly maxImportBytes?: number;
  readonly socialLogin?:LoginDependencies;
  readonly mailboxOAuth?:MailboxOAuthDependencies;
}

export function auth(c: ServerContext): AuthContext {
  return c.get('auth');
}

/**
 * The HTTP surface (BUILD_PLAN.md §11.2). Thin by design: every route authenticates, parses with zod and
 * calls one application service. Business rules live in @splitin/outreach-core only.
 */
export function createApp(options: ServerOptions): Hono<ServerEnv> {
  const { engine } = options;
  const app = new Hono<ServerEnv>();
  const internalContexts = new WeakMap<Request, AuthContext>();

  app.use('*', async (c, next) => {
    const traceId = ulid();
    c.set('traceId', traceId);
    await next();
    c.header('x-trace-id', traceId);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
  });

  app.onError((error, c) => {
    const apiError = toApiError(error);
    if (apiError.status === 500) console.error(`[outreach-server] ${c.get('traceId')}`, error);
    return c.json({ error: apiError.code, message: apiError.message, ...(apiError.issues ? { issues: apiError.issues } : {}), traceId: c.get('traceId') }, apiError.status);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'no such route', traceId: c.get('traceId') }, 404));

  registerPublicRoutes(app, engine);

  app.use('/v1/*', async (c, next) => {
    // Provider webhooks authenticate by signature, not by bearer token.
    if (c.req.path.startsWith('/v1/webhooks/')) return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const delegated = internalContexts.get(c.req.raw) ?? await authenticateCloudRequest(c.req.raw, engine, c.get('traceId'));
    c.set('auth', delegated ?? engine.db.transaction(() => authenticateToken(engine.db, token, 'http', c.get('traceId'), engine.now())));
    return next();
  });
  app.use('/v1/imports/preview', bodyLimit({ maxSize: options.maxImportBytes ?? 25 * 1024 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  app.use('/v1/*', async (c, next) => {
    if (c.req.path.startsWith('/v1/work-packages')) return bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (ctx) => ctx.json({error:'too_large'},413) })(c,next);
    if (c.req.path === '/v1/imports/preview' || c.req.path.startsWith('/v1/webhooks/')) return next();
    return bodyLimit({ maxSize: options.maxJsonBytes ?? 256 * 1024, onError: (ctx) => ctx.json({ error: 'too_large' }, 413) })(c, next);
  });

  app.all('/mcp', bodyLimit({maxSize:1024*1024,onError:(c)=>c.json({error:'too_large'},413)}), async (c) => {
    const ctx=await authenticateCloudRequest(c.req.raw,engine,c.get('traceId'));
    if(!ctx||ctx.source!=='mcp')throw new ForbiddenError('Authenticated MCP delegation required');
    const signed=JSON.parse(Buffer.from(c.req.header('x-carl-delegation')!,'base64url').toString()) as {scopes:string[]};
    return handleRemoteMcp(c.req.raw,{publicOrigin:process.env.CARL_PUBLIC_ORIGIN??'https://carl-allen.splitin.net',scopes:signed.scopes,requestApi:async(method,path,body)=>{
      const request=new Request('http://internal'+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      internalContexts.set(request,ctx);
      const result=await app.fetch(request);
      if(!result.ok)throw new Error('MCP operation refused');
      return result.json();
    }});
  });
  app.get('/v1/me', (c) => {
    const ctx = auth(c);
    return c.json({ workspaceId: ctx.workspaceId, principalId: ctx.principalId, roles: ctx.roles });
  });
  registerCampaignRoutes(app, engine);
  registerOperationRoutes(app, engine);
  registerAuthoringRoutes(app, engine);
  registerPublishingRoutes(app, engine);
  registerWorkspaceRoutes(app,engine);
  registerReplyPlaybookRoutes(app,engine);
  registerWorkspaceManagementRoutes(app,engine);
  registerSocialLoginRoutes(app,engine,options.socialLogin);
  registerAccountLifecycleRoutes(app,engine,options.socialLogin?.browser);
  registerInboxReplyRoutes(app,engine);
  registerMailboxOAuthRoutes(app,engine,options.mailboxOAuth);
  registerMailboxDraftRoutes(app,engine,options.mailboxOAuth);
  return app;
}
