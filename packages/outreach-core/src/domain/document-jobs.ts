import { digestCanonical, HtmlImportAction, ulid, type DocumentJob, type DocumentJobStatus } from '@splitin/outreach-contracts';
import { audit, ConflictError, NotFoundError, requireRole, type AuthContext } from './auth';
import type { DomainEnv } from './env';
import { getWorkPackage } from './work-packages';

export interface DocumentJobRow {
  id: string; workspace_id: string; package_id: string; source_hash: string; name: string; selected_action_ids: string;
  actions: string; action_hash: string; scheduled_for: number | null; timezone: string; status: DocumentJobStatus;
  revision: number; results: string; detail: string | null; lease_token: string | null; lease_expires_at: number | null;
  idempotency_key: string; request_hash: string; created_by: string; created_at: number; updated_at: number;
}
export interface CreateDocumentJobInput {
  name?: string; sourceHash: string; selectedActionIds: string[]; actions: HtmlImportAction[];
  scheduledFor: string | null; timezone: string; paused?: boolean; idempotencyKey: string;
}
export interface UpdateDocumentJobInput { expectedRevision: number; scheduledFor?: string | null; paused?: boolean; cancel?: boolean }

export function documentJobValue(row: DocumentJobRow): DocumentJob {
  return {
    id: row.id, packageId: row.package_id, sourceHash: row.source_hash, name: row.name,
    selectedActionIds: JSON.parse(row.selected_action_ids) as string[], actions: JSON.parse(row.actions) as HtmlImportAction[],
    scheduledFor: row.scheduled_for === null ? null : new Date(row.scheduled_for).toISOString(), timezone: row.timezone,
    status: row.status, revision: row.revision, results: JSON.parse(row.results) as DocumentJob['results'], detail: row.detail,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function owned(env: DomainEnv, ctx: AuthContext, id: string): DocumentJobRow {
  const row = env.db.prepare('SELECT * FROM document_jobs WHERE workspace_id=? AND id=?').get<DocumentJobRow>(ctx.workspaceId, id);
  if (!row) throw new NotFoundError('document job');
  return row;
}
export function getDocumentJob(env: DomainEnv, ctx: AuthContext, id: string): DocumentJob {
  requireRole(ctx, 'viewer'); return documentJobValue(owned(env, ctx, id));
}
export function listDocumentJobs(env: DomainEnv, ctx: AuthContext, packageId: string): DocumentJob[] {
  getWorkPackage(env, ctx, packageId);
  return env.db.prepare('SELECT * FROM document_jobs WHERE workspace_id=? AND package_id=? ORDER BY created_at DESC,id DESC LIMIT 100')
    .all<DocumentJobRow>(ctx.workspaceId, packageId).map(documentJobValue);
}
function futureTime(value: string | null, now: number): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= now || time > now + 90 * 86400000) throw new ConflictError('Choose a future document-job time within 90 days');
  return time;
}
function scheduledState(env: DomainEnv, time: number | null, paused: boolean): { status: DocumentJobStatus; detail: string | null } {
  if (paused) return { status: 'paused', detail: 'Job paused. No selected trigger will activate until it is resumed.' };
  if (time === null) return { status: 'draft', detail: 'Choose a future time to schedule the selected triggers.' };
  return env.documentJobRunner ? { status: 'scheduled', detail: null } : { status: 'needs_attention', detail: 'Automatic document runner is not configured. Configure the server, then reschedule this job.' };
}
/** Actions are resolved from the stored original by the application surface, never from request-provided hrefs. */
export function createDocumentJob(env: DomainEnv, ctx: AuthContext, packageId: string, input: CreateDocumentJobInput): DocumentJob {
  requireRole(ctx, 'operator');
  const pack = getWorkPackage(env, ctx, packageId);
  if (input.sourceHash !== pack.cloudReceipt.sourceHash || !/^[a-f0-9]{64}$/.test(input.sourceHash)) throw new ConflictError('The stored document changed. Reopen it before scheduling triggers.');
  const actions = HtmlImportAction.array().max(20).parse(input.actions);
  if (actions.some((action) => action.kind === 'unsupported') || actions.length !== input.selectedActionIds.length || new Set(input.selectedActionIds).size !== input.selectedActionIds.length || actions.some((action, index) => action.id !== input.selectedActionIds[index])) throw new ConflictError('Choose up to 20 supported triggers from this document');
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new ConflictError('A valid document-job idempotency key is required');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); } catch { throw new ConflictError('Choose a valid document-job time zone'); }
  const name = (input.name ?? pack.name).trim(); if (!name || name.length > 200) throw new ConflictError('Choose a document-job name with at most 200 characters');
  const time = input.scheduledFor === null ? null : Date.parse(input.scheduledFor);
  if (time !== null && !Number.isFinite(time)) throw new ConflictError('Choose a valid document-job time');
  if (time !== null && !actions.length) throw new ConflictError('Select at least one supported trigger before scheduling a job');
  const actionHash = digestCanonical(actions);
  const requestHash = digestCanonical({ packageId, sourceHash: input.sourceHash, name, selectedActionIds: input.selectedActionIds, actionHash, scheduledFor: time, timezone: input.timezone, paused: input.paused ?? false });
  return env.db.transaction(() => {
    const prior = env.db.prepare('SELECT * FROM document_jobs WHERE workspace_id=? AND idempotency_key=?').get<DocumentJobRow>(ctx.workspaceId, input.idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new ConflictError('This document-job request key already belongs to different settings'); return documentJobValue(prior); }
    futureTime(input.scheduledFor, env.now());
    const state = scheduledState(env, time, input.paused ?? false); const id = ulid(env.now());
    env.db.prepare('INSERT INTO document_jobs(id,workspace_id,package_id,source_hash,name,selected_action_ids,actions,action_hash,scheduled_for,timezone,status,detail,idempotency_key,request_hash,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, ctx.workspaceId, packageId, input.sourceHash, name, JSON.stringify(input.selectedActionIds), JSON.stringify(actions), actionHash, time, input.timezone, state.status, state.detail, input.idempotencyKey, requestHash, ctx.principalId, env.now(), env.now());
    audit(env.db, ctx, env.now(), 'document_job', id, 'created', { packageId, sourceHash: input.sourceHash, selectedActionIds: input.selectedActionIds, scheduledFor: time, status: state.status, executionIntent: 'automatic' });
    return getDocumentJob(env, ctx, id);
  });
}
export function updateDocumentJob(env: DomainEnv, ctx: AuthContext, id: string, input: UpdateDocumentJobInput): DocumentJob {
  requireRole(ctx, 'operator');
  return env.db.transaction(() => {
    const row = owned(env, ctx, id);
    if (row.revision !== input.expectedRevision) throw new ConflictError('This document job changed. Reload it before saving.');
    if (row.status === 'cancelled') throw new ConflictError('A cancelled document job cannot restart. Create a new job.');
    if (input.cancel && (input.paused !== undefined || input.scheduledFor !== undefined)) throw new ConflictError('Cancel the job separately from schedule changes');
    if (input.cancel !== true && input.paused === undefined && input.scheduledFor === undefined) return documentJobValue(row);
    const time = input.scheduledFor === undefined ? row.scheduled_for : futureTime(input.scheduledFor, env.now());
    const paused = input.paused ?? row.status === 'paused';
    if (!input.cancel && !paused && time !== null && time <= env.now()) throw new ConflictError('Choose a new future time before resuming this document job');
    if (!input.cancel && time !== null && !(JSON.parse(row.selected_action_ids) as string[]).length) throw new ConflictError('Select supported triggers in a new job before scheduling');
    const state = input.cancel ? { status: 'cancelled' as const, detail: 'Job cancelled. No further trigger results will be accepted.' } : scheduledState(env, time, paused);
    env.db.prepare('UPDATE document_jobs SET scheduled_for=?,status=?,detail=?,revision=revision+1,results=CASE WHEN ? THEN results ELSE ? END,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND revision=?')
      .run(time, state.status, state.detail, input.cancel || paused ? 1 : 0, '[]', env.now(), ctx.workspaceId, id, input.expectedRevision);
    if (row.lease_token) env.db.prepare('UPDATE document_job_runs SET status=?,detail=?,finished_at=? WHERE id=? AND status=?')
      .run(state.status, state.detail, env.now(), row.lease_token, 'running');
    audit(env.db, ctx, env.now(), 'document_job', id, input.cancel ? 'cancelled' : paused ? 'paused' : 'updated', { scheduledFor: time, status: state.status, previousRevision: row.revision });
    return getDocumentJob(env, ctx, id);
  });
}
