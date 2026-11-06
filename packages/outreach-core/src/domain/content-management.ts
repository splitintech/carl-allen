import { digestCanonical, ulid } from '@splitin/outreach-contracts';
import { ConflictError, NotFoundError, audit, requireRole, type AuthContext } from './auth';
import { compileContentCalendarIssues } from './compile';
import type { DomainEnv } from './env';
import { parseContentCalendar, PlaybookError, type ContentCalendar } from './playbook';
export interface ContentCampaignDraft {
    campaignId: string;
    name: string;
    status: string;
    calendar: ContentCalendar;
    providerAccountId: string;
}
export function getContentCampaign(env: DomainEnv, ctx: AuthContext, id: string): ContentCampaignDraft {
    requireRole(ctx, 'viewer');
    const row = env.db.prepare(`SELECT c.id,c.name,c.status,cv.provider_account_id,cv.policy,sv.spec,sv.name AS calendar_name
 FROM campaigns c JOIN campaign_versions cv ON cv.campaign_id=c.id JOIN sequence_versions sv ON sv.id=cv.sequence_version_id
 WHERE c.workspace_id=? AND c.id=? AND c.campaign_kind='content' ORDER BY cv.version DESC LIMIT 1`)
        .get<{
        id: string;
        name: string;
        status: string;
        provider_account_id: string;
        policy: string;
        spec: string;
        calendar_name: string;
    }>(ctx.workspaceId, id);
    if (!row)
        throw new NotFoundError('content campaign');
    return { campaignId: row.id, name: row.name, status: row.status, providerAccountId: row.provider_account_id, calendar: parseContentCalendar({ apiVersion: 'outreach.splitin.net/v1alpha1', kind: 'ContentCalendar', metadata: { name: row.calendar_name }, spec: { purpose: 'social_publishing', policy: JSON.parse(row.policy), posts: (JSON.parse(row.spec) as {
                    posts: unknown;
                }).posts } }) };
}
export function listContentCampaigns(env: DomainEnv, ctx: AuthContext): ContentCampaignDraft[] {
    requireRole(ctx, 'viewer');
    return env.db.prepare("SELECT id FROM campaigns WHERE workspace_id=? AND campaign_kind='content' ORDER BY created_at DESC LIMIT 500").all<{
        id: string;
    }>(ctx.workspaceId).map(row => getContentCampaign(env, ctx, row.id));
}
export function updateContentCampaign(env: DomainEnv, ctx: AuthContext, id: string, input: {
    name?: string;
    calendar?: unknown;
    providerAccountId?: string;
}): {
    campaignId: string;
    versionId: string;
} {
    requireRole(ctx, 'operator');
    return env.db.transaction(() => {
        const old = getContentCampaign(env, ctx, id);
        if (old.status !== 'draft')
            throw new ConflictError('only draft campaigns can be edited; edit scheduled actions after activation');
        const calendar = parseContentCalendar(input.calendar ?? old.calendar);
        const accountId = input.providerAccountId ?? old.providerAccountId;
        const issues = compileContentCalendarIssues(env, ctx.workspaceId, calendar, accountId);
        if (issues.length)
            throw new PlaybookError(issues);
        const now = env.now(), spec = JSON.stringify({ posts: calendar.spec.posts }), hash = digestCanonical({ posts: calendar.spec.posts });
        let sequence = env.db.prepare('SELECT id FROM sequence_versions WHERE workspace_id=? AND spec_hash=?').get<{
            id: string;
        }>(ctx.workspaceId, hash);
        if (!sequence) {
            sequence = { id: ulid(now) };
            const version = env.db.prepare('SELECT MAX(version) AS n FROM sequence_versions WHERE workspace_id=? AND name=?').get<{
                n: number | null;
            }>(ctx.workspaceId, calendar.metadata.name);
            env.db.prepare('INSERT INTO sequence_versions (id,workspace_id,name,version,spec,spec_hash,created_at) VALUES (?,?,?,?,?,?,?)').run(sequence.id, ctx.workspaceId, calendar.metadata.name, (version?.n ?? 0) + 1, spec, hash, now);
        }
        const current = env.db.prepare('SELECT id,version,approval_id FROM campaign_versions WHERE campaign_id=? ORDER BY version DESC LIMIT 1').get<{
            id: string;
            version: number;
            approval_id: string | null;
        }>(id);
        if (current?.approval_id)
            env.db.prepare("UPDATE approvals SET decision='revoked',decided_at=? WHERE id=? AND decision IN ('approved','pending')").run(now, current.approval_id);
        const versionId = ulid(now);
        env.db.prepare('INSERT INTO campaign_versions (id,campaign_id,version,sequence_version_id,provider_account_id,policy,policy_hash,audience) VALUES (?,?,?,?,?,?,?,?)').run(versionId, id, (current?.version ?? 0) + 1, sequence.id, accountId, JSON.stringify(calendar.spec.policy), digestCanonical(calendar.spec.policy), JSON.stringify({ source: 'content', posts: calendar.spec.posts.length }));
        env.db.prepare('UPDATE campaigns SET name=?,updated_at=? WHERE id=?').run(input.name ?? old.name, now, id);
        audit(env.db, ctx, now, 'campaign', id, 'draft_updated', { versionId });
        return { campaignId: id, versionId };
    });
}
export function deleteContentCampaign(env: DomainEnv, ctx: AuthContext, id: string): {
    campaignId: string;
} {
    requireRole(ctx, 'operator');
    return env.db.transaction(() => {
        const old = getContentCampaign(env, ctx, id);
        if (old.status !== 'draft')
            throw new ConflictError('only draft campaigns can be deleted');
        env.db.prepare("UPDATE approvals SET decision='revoked',decided_at=? WHERE subject_id IN (SELECT id FROM campaign_versions WHERE campaign_id=?) AND decision IN ('approved','pending')").run(env.now(), id);
        env.db.prepare('DELETE FROM audience_members WHERE campaign_version_id IN (SELECT id FROM campaign_versions WHERE campaign_id=?)').run(id);
        env.db.prepare('DELETE FROM campaign_versions WHERE campaign_id=?').run(id);
        env.db.prepare('DELETE FROM campaigns WHERE id=?').run(id);
        audit(env.db, ctx, env.now(), 'campaign', id, 'draft_deleted', {});
        return { campaignId: id };
    });
}
