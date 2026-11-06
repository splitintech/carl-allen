import { ulid, type CapabilitySnapshot } from '@splitin/outreach-contracts';
import { ConflictError, NotFoundError, audit, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { PolicySchema } from './playbook';
import { scheduleAction, cancelScheduledAction } from './scheduled-management';
import { mediaAsset } from './publishing-media';
import { PUBLISHING_LIMITS, PublishingDraftInput, type PublishingDraft } from './publishing-types';
interface DraftRow { revision: number; id: string; workspace_id: string; name: string; timezone: string; scheduled_for: string; posts: string; status: string; action_ids: string; blocked: string; created_at: number; updated_at: number }
function draftView(row: DraftRow): PublishingDraft { return { id: row.id, revision: row.revision, name: row.name, timezone: row.timezone, scheduledFor: row.scheduled_for, posts: JSON.parse(row.posts) as PublishingDraft['posts'], status: row.status, actionIds: JSON.parse(row.action_ids) as string[], blocked: JSON.parse(row.blocked) as PublishingDraft['blocked'], createdAt: row.created_at, updatedAt: row.updated_at }; }
export function getPublishingDraft(env: DomainEnv, ctx: AuthContext, id: string): PublishingDraft {
  requireRole(ctx, 'viewer'); const row = env.db.prepare('SELECT * FROM publishing_drafts WHERE workspace_id=? AND id=?').get<DraftRow>(ctx.workspaceId, id);
  if (!row) throw new NotFoundError('publishing draft'); return draftView(row);
}
export function listPublishingDrafts(env: DomainEnv, ctx: AuthContext): PublishingDraft[] {
  requireRole(ctx, 'viewer'); return env.db.prepare('SELECT * FROM publishing_drafts WHERE workspace_id=? ORDER BY updated_at DESC,id').all<DraftRow>(ctx.workspaceId).map(draftView);
}
function validateDraft(env: DomainEnv, ctx: AuthContext, input: PublishingDraftInput): void {
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); } catch { throw new ConflictError('Invalid time zone'); }
  if (new Set(input.posts.map((p) => p.channel)).size !== input.posts.length) throw new ConflictError('Choose each platform once');
  for (const post of input.posts) {
    if (new Set(post.mediaIds).size !== post.mediaIds.length) throw new ConflictError('A media asset can appear only once per post');
    for (const id of post.mediaIds) mediaAsset(env, ctx, id);
    if (post.accountId && !env.db.prepare('SELECT id FROM provider_accounts WHERE workspace_id=? AND id=?').get(ctx.workspaceId, post.accountId)) throw new NotFoundError('provider account');
  }
}
function clearDraftActions(env: DomainEnv, ctx: AuthContext, draft: PublishingDraft): void {
  for (const id of draft.actionIds) {
    const action = env.db.prepare('SELECT state FROM scheduled_actions WHERE workspace_id=? AND id=?').get<{ state: string }>(ctx.workspaceId, id);
    if (!action) throw new ConflictError('A draft action is missing; inspect the queue before editing');
    if (action.state === 'cancelled') continue;
    cancelScheduledAction(env, ctx, id, 'Publishing draft changed; fresh approval required');
  }
}
export function savePublishingDraft(env: DomainEnv, ctx: AuthContext, value: PublishingDraftInput): PublishingDraft {
  requireRole(ctx, 'operator'); const input = PublishingDraftInput.parse(value); validateDraft(env, ctx, input);
  return env.db.transaction(() => {
    const old = input.id ? getPublishingDraft(env, ctx, input.id) : null; const now = Math.max(env.now(), old ? old.updatedAt + 1 : 0);
    if (old) clearDraftActions(env, ctx, old);
    if (!old && env.db.prepare('SELECT COUNT(*) n FROM publishing_drafts WHERE workspace_id=?').get<{ n: number }>(ctx.workspaceId)!.n >= 1000) throw new ConflictError('Publishing draft limit reached');
    const id = old?.id ?? ulid(now);
    if (old) env.db.prepare("UPDATE publishing_drafts SET name=?,timezone=?,scheduled_for=?,posts=?,status='draft',action_ids='[]',blocked='[]',revision=revision+1,updated_at=? WHERE workspace_id=? AND id=?").run(input.name, input.timezone, input.scheduledFor, JSON.stringify(input.posts), now, ctx.workspaceId, id);
    else env.db.prepare('INSERT INTO publishing_drafts(id,workspace_id,name,timezone,scheduled_for,posts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id, ctx.workspaceId, input.name, input.timezone, input.scheduledFor, JSON.stringify(input.posts), now, now);
    audit(env.db, ctx, now, 'publishing_draft', id, old ? 'updated' : 'created', { channels: input.posts.map((p) => p.channel) });
    return getPublishingDraft(env, ctx, id);
  });
}
export function deletePublishingDraft(env: DomainEnv, ctx: AuthContext, id: string): void {
  requireRole(ctx, 'operator'); env.db.transaction(() => { const draft = getPublishingDraft(env, ctx, id); clearDraftActions(env, ctx, draft); env.db.prepare('DELETE FROM publishing_drafts WHERE workspace_id=? AND id=?').run(ctx.workspaceId, id); audit(env.db, ctx, env.now(), 'publishing_draft', id, 'deleted', {}); });
}
function postIssues(env: DomainEnv, ctx: AuthContext, draft: PublishingDraft): { channel: string; reason: string }[] {
  const issues: { channel: string; reason: string }[] = [];
  for (const post of draft.posts) {
    const add = (reason: string) => issues.push({ channel: post.channel, reason });
    const limits = PUBLISHING_LIMITS.platforms[post.channel];
    if (Array.from(post.text).length > limits.text) add(`Caption exceeds${limits.text} characters`);
    if (!post.text.trim() && !post.mediaIds.length) add('Add a caption or media');
    const media = post.mediaIds.map((id) => mediaAsset(env, ctx, id)); const images = media.filter((m) => m.mime.startsWith('image/')).length; const videos = media.length - images;
    if (media.some((m) => m.mime.startsWith('video/') && m.mime !== 'video/mp4')) add('Convert videos to MP4 before publishing');
    if (post.channel === 'instagram' && media.some((m) => m.mime === 'image/webp')) add('Convert Instagram images to JPEG or PNG before publishing');
    if (images > limits.images || videos > limits.videos || (images > 0 && videos > 0)) add('This post exceeds the supported media combination for this platform');
    if (limits.mediaRequired && !media.length) add(post.channel === 'tiktok' ? 'TikTok requires one video' : 'Instagram requires an image or video');
    if (post.channel === 'tiktok' && (videos !== 1 || images)) add('TikTok publishing supports one video');
    if (!post.accountId) { add('Connect and select an account'); continue; }
    const account = env.db.prepare('SELECT provider,capabilities,health,purposes FROM provider_accounts WHERE workspace_id=? AND id=?').get<{ provider: string; capabilities: string; health: string; purposes: string }>(ctx.workspaceId, post.accountId);
    if (!account) { add('Account is unavailable in this workspace'); continue; }
    const caps = JSON.parse(account.capabilities) as CapabilitySnapshot;
    if (!caps.socialPublish || caps.executionPlacement !== 'daytona-browser' || !caps.socialChannels?.includes(post.channel) || !env.adapters.get(account.provider)?.social?.publish) add('The account has no publishing executor for this platform');
    if (!(JSON.parse(account.purposes) as string[]).includes('social_publishing')) add('The account has not enabled social publishing');
    if (account.health !== 'ok') add('Sign into the account and check its connection');
    if (media.length && (!caps.socialMediaTypes || (images && !caps.socialMediaTypes.includes('image')) || (videos && !caps.socialMediaTypes.includes('video')))) add('The account has not enabled this media type');
  }
  if (Date.parse(draft.scheduledFor) < env.now()) issues.push({ channel: 'all', reason: 'Choose a future date and time' });
  return issues;
}
export function submitPublishingDraft(env: DomainEnv, ctx: AuthContext, id: string): { draft: PublishingDraft; actions: ReturnType<typeof publishingActions>; blocked: PublishingDraft['blocked'] } {
  requireRole(ctx, 'operator'); return env.db.transaction(() => {
    const draft = getPublishingDraft(env, ctx, id);
    if (draft.actionIds.length) return { draft, actions: publishingActions(env, ctx).filter((a) => draft.actionIds.includes(a.id)), blocked: draft.blocked };
    const blocked = postIssues(env, ctx, draft);
    if (blocked.length) { env.db.prepare("UPDATE publishing_drafts SET status='blocked',blocked=?,updated_at=? WHERE id=?").run(JSON.stringify(blocked), env.now(), id); return { draft: getPublishingDraft(env, ctx, id), actions: [], blocked }; }
    const actionIds = draft.posts.map((post) => scheduleAction(env, ctx, { kind: 'social.publish', providerAccountId: post.accountId!, payload: { channel: post.channel, text: post.text, mediaUrls: post.mediaIds.map((assetId) => `outreach-media://${mediaAsset(env, ctx, assetId).sha256}`), publishingDraftId: draft.id, mediaIds: post.mediaIds }, dueAt: Date.parse(draft.scheduledFor), approval: 'always', idempotencyKey: `publishing:${draft.id}:${draft.revision}:${post.channel}`, policy: PolicySchema.parse({ approval: 'every_action', unsubscribe: 'reply', requirePostalAddress: false, window: { timezone: draft.timezone, fallback: draft.timezone, days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], start: '00:00', end: '23:59' }, limits: { accountPerDay: 10, channelPerDay: 10 } }) }).actionId);
    env.db.prepare("UPDATE publishing_drafts SET status='queued',action_ids=?,blocked='[]',updated_at=? WHERE id=?").run(JSON.stringify(actionIds), env.now(), id);
    audit(env.db, ctx, env.now(), 'publishing_draft', id, 'queued_for_approval', { actionIds });
    return { draft: getPublishingDraft(env, ctx, id), actions: publishingActions(env, ctx).filter((a) => actionIds.includes(a.id)), blocked: [] };
  });
}
export function publishingActions(env: DomainEnv, ctx: AuthContext): { id: string; kind: string; state: string; channel: string; text: string; dueAt: number; providerAccountId: string | null; approvalId: string | null; operationHash: string; mediaIds: string[]; draftId: string | null; reason: string | null }[] {
  requireRole(ctx, 'viewer');
  const rows = env.db.prepare("SELECT id,kind,state,payload,due_at,provider_account_id,approval_id,content_hash,state_reason FROM scheduled_actions WHERE workspace_id=? AND kind='social.publish' ORDER BY due_at DESC LIMIT 1000").all<{ id: string; kind: string; state: string; payload: string; due_at: number; provider_account_id: string | null; approval_id: string | null; content_hash: string; state_reason: string | null }>(ctx.workspaceId);
  return rows.map((r) => { const payload = JSON.parse(r.payload) as { channel: string; text: string; mediaIds?: string[]; publishingDraftId?: string }; return { id: r.id, kind: r.kind, state: r.state, channel: payload.channel, text: payload.text, dueAt: r.due_at, providerAccountId: r.provider_account_id, approvalId: r.approval_id, operationHash: r.content_hash, mediaIds: payload.mediaIds ?? [], draftId: payload.publishingDraftId ?? null, reason: r.state_reason }; });
}
