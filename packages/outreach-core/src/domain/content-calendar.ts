import { digestCanonical, ulid } from '@splitin/outreach-contracts';
import { ConflictError, NotFoundError, actorOf, audit, requireRole, type AuthContext } from './auth';
import { createApproval, createBatchApproval } from './approvals';
import { compileContentCalendarIssues } from './compile';
import { loadCampaign, type DomainEnv } from './env';
import { durationMs, nextSlot, resolveZone } from './calendar';
import { enqueueAction } from '../execution/enqueue';
import type { SocialPublishPayload } from '../execution/invoke';
import { PlaybookError, parseContentCalendar, type ContentCalendar, type ContentPost, type Policy } from './playbook';
import { findTemplate, render, TemplateRenderError } from './templates';

export interface CreateContentCampaignInput {
  readonly name: string;
  readonly calendar: string | unknown;
  readonly providerAccountId: string;
}

function renderPost(env: DomainEnv, workspaceId: string, post: ContentPost, accountId: string): SocialPublishPayload {
  const template = findTemplate(env.db, workspaceId, post.template);
  if (!template) throw new TemplateRenderError([`template:${post.template}`]);
  const sender = env.db
    .prepare('SELECT sender_identity FROM provider_accounts WHERE id = ?')
    .get<{ sender_identity: string }>(accountId);
  if (!sender) throw new NotFoundError('provider account');
  const identity = JSON.parse(sender.sender_identity) as { name: string; address: string; organization?: string };
  const text = render(
    template.body_text,
    {
      sender_name: identity.name,
      sender_email: identity.address,
      sender_org: identity.organization,
    },
    'text',
  );
  return { channel: post.channel, text, ...(post.mediaUrls ? { mediaUrls: post.mediaUrls } : {}) };
}

/** Creates a draft content campaign (Buffer-style calendar) bound to a Daytona social account. */
export function createContentCampaign(
  env: DomainEnv,
  ctx: AuthContext,
  input: CreateContentCampaignInput,
): { campaignId: string; versionId: string } {
  requireRole(ctx, 'operator');
  const calendar = parseContentCalendar(input.calendar);
  const issues = compileContentCalendarIssues(env, ctx.workspaceId, calendar, input.providerAccountId);
  if (issues.length) throw new PlaybookError(issues);
  const { db } = env;
  return db.transaction(() => {
    const now = env.now();
    const spec = { posts: calendar.spec.posts };
    const specHash = digestCanonical(spec);
    let sequence = db
      .prepare('SELECT id FROM sequence_versions WHERE workspace_id = ? AND spec_hash = ?')
      .get<{ id: string }>(ctx.workspaceId, specHash);
    if (!sequence) {
      const latest = db
        .prepare('SELECT MAX(version) AS v FROM sequence_versions WHERE workspace_id = ? AND name = ?')
        .get<{ v: number | null }>(ctx.workspaceId, calendar.metadata.name);
      sequence = { id: ulid(now) };
      db.prepare(
        'INSERT INTO sequence_versions (id, workspace_id, name, version, spec, spec_hash, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        sequence.id,
        ctx.workspaceId,
        calendar.metadata.name,
        (latest?.v ?? 0) + 1,
        JSON.stringify(spec),
        specHash,
        now,
      );
    }
    const campaignId = ulid(now);
    const versionId = ulid(now);
    db.prepare(
      `INSERT INTO campaigns (id, workspace_id, name, purpose, status, campaign_kind, created_at, updated_at)
       VALUES (?,?,?,?,'draft','content',?,?)`,
    ).run(campaignId, ctx.workspaceId, input.name, calendar.spec.purpose, now, now);
    db.prepare(
      `INSERT INTO campaign_versions (id, campaign_id, version, sequence_version_id, provider_account_id, policy, policy_hash, audience)
       VALUES (?,?,1,?,?,?,?,?)`,
    ).run(
      versionId,
      campaignId,
      sequence.id,
      input.providerAccountId,
      JSON.stringify(calendar.spec.policy),
      digestCanonical(calendar.spec.policy),
      JSON.stringify({ source: 'content', posts: calendar.spec.posts.length }),
    );
    audit(db, ctx, now, 'campaign', campaignId, 'created', {
      name: input.name,
      kind: 'content',
      calendar: calendar.metadata.name,
      posts: calendar.spec.posts.length,
    });
    return { campaignId, versionId };
  });
}

/**
 * Activates a content campaign: materializes each post as `social.publish` on `scheduled_actions`
 * honouring the quiet-hours window and per-channel caps via the shared rate policy.
 */
export function activateContentCampaign(
  env: DomainEnv,
  ctx: AuthContext,
  campaignId: string,
): { scheduled: number } {
  requireRole(ctx, 'operator');
  const { db } = env;
  return db.transaction(() => {
    const now = env.now();
    const campaign = loadCampaign(db, ctx.workspaceId, campaignId);
    if (!campaign) throw new NotFoundError(`campaign ${campaignId}`);
    if (campaign.status !== 'draft') throw new ConflictError(`campaign is ${campaign.status}`);
    if ((campaign.campaign_kind ?? 'outreach') !== 'content') {
      throw new ConflictError('campaign is not a content calendar');
    }
    const version = db
      .prepare('SELECT * FROM campaign_versions WHERE campaign_id = ? AND activated_at IS NULL ORDER BY version DESC LIMIT 1')
      .get<{
        id: string;
        sequence_version_id: string;
        provider_account_id: string;
        policy: string;
        approval_id: string | null;
      }>(campaignId);
    if (!version) throw new ConflictError('campaign has no draft version to activate');
    const sequence = db
      .prepare('SELECT spec FROM sequence_versions WHERE id = ?')
      .get<{ spec: string }>(version.sequence_version_id);
    const posts = (JSON.parse(sequence?.spec ?? '{"posts":[]}') as { posts: ContentPost[] }).posts;
    const policy = JSON.parse(version.policy) as Policy;
    const zone = resolveZone(policy.window, null);
    const actor = actorOf(ctx);
    const versionHash = digestCanonical({ posts, policy, account: version.provider_account_id });
    const campaignApprovalId = policy.approval === 'first_batch_then_campaign' ? createApproval(db, {workspaceId:ctx.workspaceId,scope:'campaign_version',subjectId:version.id,operationHash:versionHash,preview:{posts,policy},requestedBy:ctx.principalId},now) : null;
    db.prepare('UPDATE campaign_versions SET version_hash=?, approval_id=? WHERE id=?').run(versionHash,campaignApprovalId,version.id);
    const batchActions: import('../execution/types').ActionRow[] = [];
    let scheduled = 0;
    for (const post of posts) {
      const payload = renderPost(env, ctx.workspaceId, post, post.providerAccountId ?? version.provider_account_id);
      const requested = Date.parse(post.scheduledFor);
      if (!Number.isFinite(requested)) throw new PlaybookError([`post ${post.id}: invalid scheduledFor`]);
      const dueAt = nextSlot(Math.max(requested, now), policy.window, zone);
      const needsApproval = policy.approval === 'every_action' || post.approval === 'always';
      const batch = !needsApproval && policy.approval === 'first_batch_then_campaign' && batchActions.length < policy.firstBatchSize;
      const { action } = enqueueAction(
        db,
        {
          workspaceId: ctx.workspaceId,
          kind: 'social.publish',
          payload,
          idempotencyKey: `content:${campaignId}:${post.id}`,
          dueAt,
          notAfter: dueAt + durationMs(policy.expireAfter),
          providerAccountId: post.providerAccountId ?? version.provider_account_id,
          purpose: 'social_publishing',
          recipient: null,
          enrollmentId: null,
          campaignId,
          stepId: post.id,
          contactPointId: null,
          senderDomain: 'social.invalid',
          awaitingApproval: needsApproval || batch,
          approvalId: needsApproval || batch ? null : campaignApprovalId,
        },
        actor,
        now,
      );
      if (batch) batchActions.push(action);
      if (needsApproval) {
        const approvalId = createApproval(
          db,
          {
            workspaceId: ctx.workspaceId,
            scope: 'action',
            subjectId: action.id,
            operationHash: action.content_hash,
            preview: { actionId: action.id, channel: post.channel, postId: post.id },
            requestedBy: ctx.principalId,
          },
          now,
        );
        db.prepare('UPDATE scheduled_actions SET approval_id = ? WHERE id = ?').run(approvalId, action.id);
      }
      scheduled += 1;
    }
    if (batchActions.length) createBatchApproval(db, ctx.workspaceId, campaignId, batchActions, ctx.principalId, now);
    db.prepare(`UPDATE campaigns SET status = 'active', active_version_id = ?, updated_at = ? WHERE id = ?`).run(
      version.id,
      now,
      campaignId,
    );
    db.prepare('UPDATE campaign_versions SET activated_at = ?, activated_by = ? WHERE id = ?').run(
      now,
      ctx.principalId,
      version.id,
    );
    audit(db, ctx, now, 'campaign', campaignId, 'activated', { kind: 'content', scheduled });
    return { scheduled };
  });
}

export function listContentCalendar(env: DomainEnv, ctx: AuthContext, hours = 168): {
  posts: Array<{
    id: string;
    campaignId: string | null;
    channel: string;
    text: string;
    state: string;
    dueAt: number;
  }>;
} {
  requireRole(ctx, 'viewer');
  const until = env.now() + hours * 3_600_000;
  const rows = env.db
    .prepare(
      `SELECT sa.id, sa.campaign_id, sa.state, sa.due_at, sa.payload
       FROM scheduled_actions sa
       JOIN campaigns c ON c.id = sa.campaign_id
       WHERE sa.workspace_id = ? AND sa.kind = 'social.publish'
         AND c.campaign_kind = 'content'
         AND sa.state IN ('planned','awaiting_approval','scheduled','claimed','executing','retryable')
         AND sa.due_at <= ?
       ORDER BY sa.due_at, sa.id
       LIMIT 500`,
    )
    .all<{ id: string; campaign_id: string | null; state: string; due_at: number; payload: string }>(
      ctx.workspaceId,
      until,
    );
  return {
    posts: rows.map((row) => {
      const payload = JSON.parse(row.payload) as SocialPublishPayload;
      return {
        id: row.id,
        campaignId: row.campaign_id,
        channel: payload.channel,
        text: payload.text,
        state: row.state,
        dueAt: row.due_at,
      };
    }),
  };
}

/** Re-export for callers that already hold a parsed calendar. */
export type { ContentCalendar };
