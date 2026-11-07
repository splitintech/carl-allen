import { decideReplyPlaybook, listReplyPlaybooks, reviewReplyPlaybook, revokeReplyPlaybook, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';
const reason=z.string().trim().min(1).max(1000);
const decision=z.object({operationHash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approved','rejected']),reason}).strict();
export function registerReplyPlaybookRoutes(app:Hono<ServerEnv>,engine:Engine):void {
 app.get('/v1/reply-playbooks',(c)=>{const q=z.object({cursor:z.string().max(200).default(''),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(c.req.query());const playbooks=listReplyPlaybooks(engine,auth(c),q.cursor,q.limit);return c.json({playbooks,nextCursor:playbooks.length===q.limit?playbooks.at(-1)?.id:null});});
 app.get('/v1/reply-playbooks/:id',(c)=>c.json({playbook:reviewReplyPlaybook(engine,auth(c),c.req.param('id'))}));
 app.post('/v1/reply-playbooks/:id/decide',async(c)=>c.json({playbook:decideReplyPlaybook(engine,auth(c),c.req.param('id'),decision.parse(await c.req.json()))}));
 app.post('/v1/reply-playbooks/:id/revoke',async(c)=>{const input=z.object({reason}).strict().parse(await c.req.json());return c.json({playbook:revokeReplyPlaybook(engine,auth(c),c.req.param('id'),input.reason)});});
}
