import { ulid } from '@splitin/outreach-contracts';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { authenticate, ForbiddenError, ROLES, type AuthContext, type Engine, type Role } from '@splitin/outreach-core';

export interface CloudDelegation {
  identityProvider?: 'google'; sub: string; workspaceId: string; surface: 'http' | 'mcp'; scopes: string[];
  email?: string; emailVerified?: boolean;
  iat: number; exp: number; jti: string; method: string; path: string; bodySha256: string;
}
function forbidden(): never { throw new ForbiddenError('invalid cloud delegation'); }

/** The gateway authenticates; the engine owns invitation claims, membership, roles and replay state. */
export async function authenticateCloudRequest(request: Request, engine: Pick<Engine, 'db' | 'now'>, traceId: string, secret = process.env.CLOUD_GATEWAY_SECRET): Promise<AuthContext | null> {
  const encoded = request.headers.get('x-carl-delegation');
  const signature = request.headers.get('x-carl-signature');
  if (!encoded && !signature) return null;
  if (!encoded || !signature || !secret || secret.length < 32 || encoded.length > 8192 || !/^[a-f0-9]{64}$/.test(signature)) forbidden();
  const expected = createHmac('sha256', secret).update(encoded).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) forbidden();
  let value: CloudDelegation;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as CloudDelegation; } catch { return forbidden(); }
  const now = Math.floor(engine.now() / 1000);
  if (!value || typeof value.sub !== 'string' || value.sub.length > 200 || !value.sub || typeof value.workspaceId !== 'string' || value.workspaceId.length > 200 || !value.workspaceId || !['http', 'mcp'].includes(value.surface) || !Array.isArray(value.scopes) || value.scopes.some(s => typeof s !== 'string') || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || value.iat > now + 5 || value.iat < now - 60 || value.exp < now || value.exp > value.iat + 60 || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.jti)) forbidden();
  const url = new URL(request.url);
  if (value.method !== request.method || value.path !== url.pathname + url.search) forbidden();
  const reader = request.clone().body?.getReader();
  const digest = createHash('sha256'); let bytes = 0;
  if (reader) try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 25 * 1024 * 1024) { await reader.cancel(); forbidden(); } digest.update(chunk.value); }
  } finally { reader.releaseLock(); }
  if (value.bodySha256 !== digest.digest('hex')) forbidden();
  return engine.db.transaction(() => {
    engine.db.prepare('DELETE FROM gateway_requests WHERE expires_at < ?').run(now);
    if (engine.db.prepare('SELECT id FROM gateway_requests WHERE id=?').get(value.jti)) forbidden();
    if (value.identityProvider !== 'google') forbidden();
    const external = `google:${value.sub}`;
    let member = engine.db.prepare('SELECT id FROM principals WHERE workspace_id=? AND external_ref=?').get(value.workspaceId, external);
    if (!member && value.emailVerified === true && typeof value.email === 'string') {
      const email = value.email.trim().toLowerCase();
      const invite = engine.db.prepare('SELECT id,roles FROM cloud_invitations WHERE workspace_id=? AND lower(email)=? AND accepted_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1').get<{id:string;roles:string}>(value.workspaceId, email, engine.now());
      if (invite) {
        const roles = JSON.parse(invite.roles) as unknown;
        if (!Array.isArray(roles) || !roles.length || roles.some(r => !(ROLES as readonly unknown[]).includes(r))) forbidden();
        const id = ulid(engine.now());
        engine.db.prepare('INSERT INTO principals(id,workspace_id,external_ref,display_name,roles) VALUES (?,?,?,?,?)').run(id, value.workspaceId, external, email, JSON.stringify(roles));
        engine.db.prepare('UPDATE cloud_invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL').run(engine.now(), invite.id);
        member = { id };
      }
    }
    if (!member) forbidden();
    const ctx = authenticate(engine.db, value.workspaceId, external, value.surface, traceId);
    const ceiling = value.surface === 'mcp' ? (value.scopes.includes('carl:prepare') || value.scopes.includes('carl:control') ? 1 : 0) : 3;
    const highest = Math.min(ceiling, Math.max(-1, ...ctx.roles.map(r => ROLES.indexOf(r))));
    const role: Role | undefined = ROLES[highest];
    if (!role || (value.surface === 'mcp' && !value.scopes.includes('carl:read'))) forbidden();
    engine.db.prepare('INSERT INTO gateway_requests(id,expires_at) VALUES (?,?)').run(value.jti, value.exp);
    return { ...ctx, roles: [role] };
  });
}
