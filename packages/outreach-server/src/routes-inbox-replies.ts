import { listInboxReplies, prepareInboxReply, type Engine } from '@splitin/outreach-core';
import { z } from 'zod';
import type { Hono } from 'hono';
import { auth,type ServerEnv } from './app';
export function registerInboxReplyRoutes(app:Hono<ServerEnv>,engine:Engine):void {
 app.get('/v1/inbox/threads/:id/replies',c=>c.json({replies:listInboxReplies(engine,auth(c),c.req.param('id'))}));
 app.post('/v1/inbox/threads/:id/replies/prepare',async c=>c.json({reply:prepareInboxReply(engine,auth(c),c.req.param('id'),z.object({text:z.string().min(1).max(3000),idempotencyKey:z.string().max(100).optional()}).strict().parse(await c.req.json()))}));
}
