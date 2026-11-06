import { digestCanonical, ulid, type ActionKind, type ProviderPurpose } from '@splitin/outreach-contracts';
import { enqueueAction } from '../execution/enqueue';
import { transitionAction } from '../execution/actions-repo';
import type { ActionRow } from '../execution/types';
import { ConflictError, NotFoundError, actorOf, audit, requireRole, type AuthContext } from './auth';
import { createApproval } from './approvals';
import { accountRecipeHash, executionAccountIssues } from './compile';
import type { DomainEnv } from './env';
import { PlaybookError, PolicySchema, type Policy } from './playbook';
import { nextSlot, resolveZone, durationMs } from './calendar';
export interface ScheduleActionInput {
    readonly kind: 'social.publish' | 'social.message' | 'social.connect' | 'browser.task';
    readonly providerAccountId: string;
    readonly payload: Record<string, unknown>;
    readonly purpose?: ProviderPurpose;
    readonly dueAt?: number;
    readonly idempotencyKey?: string;
    readonly approval?: 'always' | 'none';
    readonly policy?: Policy;
}
function managedAction(env: DomainEnv, ctx: AuthContext, id: string): ActionRow {
    const action = env.db.prepare('SELECT * FROM scheduled_actions WHERE workspace_id=? AND id=?').get<ActionRow>(ctx.workspaceId, id);
    if (!action)
        throw new NotFoundError('action');
    if (!['planned', 'scheduled', 'awaiting_approval', 'retryable'].includes(action.state))
        throw new ConflictError(`action is ${action.state}; resolve in-flight or uncertain effects before editing`);
    if (env.db.prepare("SELECT id FROM action_attempts WHERE action_id=? AND outcome IN ('pending','succeeded','uncertain') LIMIT 1").get(id))
        throw new ConflictError('an uncertain or accepted attempt must be resolved through review');
    return action;
}
function validatePayload(kind: string, payload: Record<string, unknown>): void {
    if (kind === 'browser.task') {
        if (typeof payload.recipeId !== 'string' || !payload.recipeId || !payload.input || typeof payload.input !== 'object' || Array.isArray(payload.input))
            throw new PlaybookError(['browser task requires recipeId and input object']);
    }
    else {
        if (typeof payload.channel !== 'string' || !payload.channel)
            throw new PlaybookError(['social action requires channel']);
        if (kind !== 'social.connect' && (typeof payload.text !== 'string' || (!payload.text.trim() && !(kind === 'social.publish' && Array.isArray(payload.mediaUrls) && payload.mediaUrls.length))))
            throw new PlaybookError(['social action requires text']);
        if (kind === 'social.connect' && payload.text !== undefined && typeof payload.text !== 'string')
            throw new PlaybookError(['connection note must be text']);
        if (kind !== 'social.publish') {
            if (typeof payload.targetUrl !== 'string')
                throw new PlaybookError(['social action requires targetUrl']);
            const url = new URL(payload.targetUrl);
            if (url.protocol !== 'https:')
                throw new PlaybookError(['social target must use HTTPS']);
        }
    }
    if (payload.mediaUrls !== undefined) {
        if (kind !== 'social.publish' || !Array.isArray(payload.mediaUrls) || payload.mediaUrls.length > 10) throw new PlaybookError(['up to ten post media URLs are supported']);
        for (const value of payload.mediaUrls) {
            if (typeof value !== 'string') throw new PlaybookError(['invalid media URL']);
            if (/^outreach-media:\/\/[0-9a-f]{64}$/.test(value)) continue;
            try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid media'); }
            catch { throw new PlaybookError(['media must use credential-free HTTPS or a stored immutable asset']); }
        }
    }
    if (JSON.stringify(payload).length > 100000)
        throw new PlaybookError(['action payload too large']);
}
export function scheduleAction(env: DomainEnv, ctx: AuthContext, input: ScheduleActionInput): {
    actionId: string;
    approvalId: string | null;
} {
    requireRole(ctx, 'operator');
    validatePayload(input.kind, input.payload);
    const purpose: ProviderPurpose = input.kind === 'social.publish' ? 'social_publishing' : input.kind.startsWith('social.') ? 'social_messaging' : input.purpose ?? 'manual_correspondence';
    const issues = executionAccountIssues(env, ctx.workspaceId, input.kind, input.providerAccountId, purpose);
    if (issues.length)
        throw new PlaybookError(issues);
    if (input.dueAt !== undefined && !Number.isFinite(input.dueAt))
        throw new PlaybookError(['invalid dueAt']);
    return env.db.transaction(() => {
        const now = env.now();
        const needsApproval = input.kind === 'browser.task' || input.approval !== 'none';
        const policy = PolicySchema.parse(input.policy ?? { approval: needsApproval ? 'every_action' : 'none', unsubscribe: 'reply', requirePostalAddress: false, limits: { accountPerDay: 10, channelPerDay: 10 } });
        const recipeHash = input.kind === 'browser.task' ? accountRecipeHash(env, ctx.workspaceId, input.providerAccountId, String(input.payload.recipeId)) : null;
        if (input.kind === 'browser.task' && !recipeHash)
            throw new PlaybookError(['browser recipe must declare an immutable definition hash']);
        const payload = { ...input.payload, ...(recipeHash ? { recipeHash } : {}), _policy: policy };
        const dueAt = nextSlot(Math.max(now, input.dueAt ?? now), policy.window, resolveZone(policy.window, null));
        const { action, created } = enqueueAction(env.db, { workspaceId: ctx.workspaceId, kind: input.kind, payload, idempotencyKey: input.idempotencyKey ?? `operator:${ulid(now)}`, dueAt, notAfter: dueAt + durationMs(policy.expireAfter), providerAccountId: input.providerAccountId, purpose, recipient: typeof input.payload.targetUrl === 'string' ? input.payload.targetUrl : null, awaitingApproval: needsApproval }, actorOf(ctx), now);
        if (!created) {
            if (action.kind !== input.kind || action.provider_account_id !== input.providerAccountId || action.content_hash !== digestCanonical(payload))
                throw new ConflictError('idempotency key already belongs to different action parameters');
            return { actionId: action.id, approvalId: action.approval_id };
        }
        const approvalId = needsApproval ? createApproval(env.db, { workspaceId: ctx.workspaceId, scope: 'action', subjectId: action.id, operationHash: action.content_hash, preview: { kind: action.kind, payload, dueAt: action.due_at, accountId: input.providerAccountId }, requestedBy: ctx.principalId }, now) : null;
        if (approvalId)
            env.db.prepare('UPDATE scheduled_actions SET approval_id=? WHERE id=?').run(approvalId, action.id);
        return { actionId: action.id, approvalId };
    });
}
function revokeActionApproval(env: DomainEnv, action: ActionRow): void {
    if (action.approval_id)
        env.db.prepare("UPDATE approvals SET decision='revoked',decided_at=?,reason='scheduled action changed' WHERE id=? AND scope='action' AND decision IN ('pending','approved')").run(env.now(), action.approval_id);
}
export function updateScheduledAction(env: DomainEnv, ctx: AuthContext, id: string, input: {
    text?: string;
    scheduledFor?: string;
    input?: Record<string, unknown>;
    mediaUrls?: string[];
}): {
    actionId: string;
    approvalId: string;
} {
    requireRole(ctx, 'operator');
    return env.db.transaction(() => {
        const action = managedAction(env, ctx, id);
        if (!action.kind.startsWith('social.') && action.kind !== 'browser.task')
            throw new ConflictError('only social/browser drafts can be edited here');
        const payload = JSON.parse(action.payload) as Record<string, unknown>;
        if (input.text !== undefined)
            payload.text = input.text;
        if (input.input !== undefined)
            payload.input = input.input;
        if(input.mediaUrls!==undefined)payload.mediaUrls=input.mediaUrls;
        validatePayload(action.kind, payload);
        if (action.kind === 'browser.task') {
            const hash = accountRecipeHash(env, ctx.workspaceId, action.provider_account_id ?? '', String(payload.recipeId));
            if (!hash)
                throw new PlaybookError(['browser recipe must declare an immutable definition hash']);
            payload.recipeHash = hash;
        }
        const dueAt = input.scheduledFor === undefined ? action.due_at : Date.parse(input.scheduledFor);
        if (!Number.isFinite(dueAt))
            throw new PlaybookError(['invalid scheduledFor']);
        revokeActionApproval(env, action);
        const hash = digestCanonical(payload);
        const approvalId = createApproval(env.db, { workspaceId: ctx.workspaceId, scope: 'action', subjectId: id, operationHash: hash, preview: { actionId: id, payload, dueAt, accountId: action.provider_account_id }, requestedBy: ctx.principalId }, env.now());
        // This mutation is atomic with the fresh approval and cannot race a claimed action.
        env.db.prepare("UPDATE scheduled_actions SET payload=?,content_hash=?,due_at=?,not_after=?,approval_id=?,state='awaiting_approval',state_reason='edited_requires_approval',updated_at=? WHERE id=?").run(JSON.stringify(payload), hash, dueAt, action.not_after === null ? null : dueAt + Math.max(0, action.not_after - action.due_at), approvalId, env.now(), id);
        audit(env.db, ctx, env.now(), 'action', id, 'draft_updated', { approvalId });
        return { actionId: id, approvalId };
    });
}
export function cancelScheduledAction(env: DomainEnv, ctx: AuthContext, id: string, reason: string): {
    actionId: string;
} {
    requireRole(ctx, 'operator');
    if (!reason.trim())
        throw new PlaybookError(['reason required']);
    return env.db.transaction(() => {
        const action = managedAction(env, ctx, id);
        revokeActionApproval(env, action);
        transitionAction(env.db, action, 'cancelled', env.now(), actorOf(ctx), { state_reason: reason, lease_owner: null, lease_expires_at: null });
        return { actionId: id };
    });
}
export function convertSocialActionToManual(env: DomainEnv, ctx: AuthContext, id: string, reason: string): {
    actionId: string;
} {
    requireRole(ctx, 'operator');
    return env.db.transaction(() => {
        const action = managedAction(env, ctx, id);
        if (!action.kind.startsWith('social.'))
            throw new ConflictError('only social actions have a manual fallback');
        const payload = JSON.parse(action.payload) as {
            channel: string;
            text?: string;
            targetUrl?: string;
        };
        cancelScheduledAction(env, ctx, id, reason);
        const result = enqueueAction(env.db, { workspaceId: ctx.workspaceId, kind: 'manual.task' as ActionKind, payload: { channel: payload.channel, draft: payload.text ?? '', targetUrl: payload.targetUrl }, idempotencyKey: `manual-fallback:${id}`, dueAt: env.now(), enrollmentId: action.enrollment_id, campaignId: action.campaign_id, stepId: action.step_id, contactPointId: action.contact_point_id }, actorOf(ctx), env.now());
        return { actionId: result.action.id };
    });
}
