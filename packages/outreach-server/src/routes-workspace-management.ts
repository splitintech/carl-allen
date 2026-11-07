import { getOutreachSequence, resumeOutreachSequence, revokeTeamInvitation, updateTeamMemberRoles, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';
const reason=z.string().trim().min(1).max(1000);
export function registerWorkspaceManagementRoutes(app:Hono<ServerEnv>,engine:Engine):void {
 app.get('/v1/outreach/sequences/:id',c=>c.json({sequence:getOutreachSequence(engine,auth(c),c.req.param('id'))}));
 app.post('/v1/outreach/sequences/:id/resume',c=>c.json(resumeOutreachSequence(engine,auth(c),c.req.param('id'))));
 app.patch('/v1/team/members/:id',async c=>{const input=z.object({roles:z.array(z.enum(['viewer','operator','approver','admin'])).max(4),reason}).strict().parse(await c.req.json());return c.json({member:updateTeamMemberRoles(engine,auth(c),c.req.param('id'),input.roles,input.reason)});});
 app.delete('/v1/team/invitations/:id',async c=>{const input=z.object({reason}).strict().parse(await c.req.json());return c.json(revokeTeamInvitation(engine,auth(c),c.req.param('id'),input.reason));});
}
