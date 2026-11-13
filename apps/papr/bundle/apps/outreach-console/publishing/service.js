import {connectionActions} from './connection-actions.js';
import {createUploader} from './uploads.js';
/* global location, document, fetch, URLSearchParams, FileReader, Blob, URL, atob */
import { call } from '../ui/api.js';
const hosted = () => location.hostname === 'carl-allen.splitin.net' || location.hostname.endsWith('.workers.dev') || document.documentElement.dataset.carlHosted === 'true';
let session;
const id = (value) => { if (typeof value !== 'string' || (value.length < 1 || value.length > 500 || Array.from(value).some((char) => char.charCodeAt(0) < 32) || ['.', '..'].includes(value))) throw new Error('Invalid resource identifier. Refresh the workspace and try again.'); return encodeURIComponent(value); };
const pageQuery = (p) => { const q = new URLSearchParams(); for (const key of ['from', 'to', 'cursor', 'limit', 'accountId', 'channel']) if (p[key] !== undefined && p[key] !== '') q.set(key, String(p[key])); return q.size ? `?${q}` : ''; };
export function restAction(action, p = {}) {
  const map = {
    ...connectionActions(p,id),
    'home-overview':()=>['GET','/v1/home'],
    'outreach-review':()=>['GET',`/v1/outreach/sequences/${id(p.sequenceId)}`],
    'outreach-resume':()=>['POST',`/v1/outreach/sequences/${id(p.sequenceId)}/resume`,{}],
    'team-member-save':()=>['PATCH',`/v1/team/members/${id(p.principalId)}`,{roles:p.roles,reason:p.reason}],
    'team-invite-revoke':()=>['DELETE',`/v1/team/invitations/${id(p.invitationId)}`,{reason:p.reason}],
    'reply-playbooks':()=>['GET','/v1/reply-playbooks'+pageQuery(p)],
    'reply-playbook-review':()=>['GET',`/v1/reply-playbooks/${id(p.playbookId)}`],
    'reply-playbook-decide':()=>['POST',`/v1/reply-playbooks/${id(p.playbookId)}/decide`,{decision:p.decision,operationHash:p.operationHash,reason:p.reason}],
    'reply-playbook-revoke':()=>['POST',`/v1/reply-playbooks/${id(p.playbookId)}/revoke`,{reason:p.reason}],
    'policy-settings':()=>['GET','/v1/settings/policy'],
    'policy-settings-save':()=>['PATCH','/v1/settings/policy',p.input],
    'storage-settings': () => ['GET','/v1/settings/media'],
    'storage-settings-save': () => ['PATCH','/v1/settings/media',{quotaBytes:p.quotaBytes}],
    'storage-cleanup': () => ['POST','/v1/publishing/media-cleanup',{}],
    'publishing-overview': () => ['GET', '/v1/publishing'],
    'publishing-actions-page': () => ['GET', `/v1/publishing/actions${pageQuery(p)}`],
    'publishing-drafts-page': () => ['GET', `/v1/publishing/drafts${pageQuery(p)}`],
    'publishing-draft-save': () => ['POST', '/v1/publishing/drafts', p.input],
    'publishing-draft-delete': () => ['DELETE', `/v1/publishing/drafts/${id(p.draftId)}`],
    'publishing-plan-prepare': () => ['POST', `/v1/publishing/plans/${id(p.draftId)}/prepare`, {}],
    'publishing-upload-status': () => ['GET', `/v1/publishing/uploads/${id(p.uploadId)}`],
    'publishing-upload-start': () => ['POST', '/v1/publishing/uploads', p.input],
    'publishing-upload-chunk': () => ['POST', `/v1/publishing/uploads/${id(p.uploadId)}/chunks`, { index: p.index, data: p.data }],
    'publishing-upload-complete': () => ['POST', `/v1/publishing/uploads/${id(p.uploadId)}/complete`, {}],
    'publishing-upload-cancel': () => ['DELETE', `/v1/publishing/uploads/${id(p.uploadId)}`],
    'publishing-media-read': () => ['GET', `/v1/publishing/media/${id(p.assetId)}?offset=${encodeURIComponent(p.offset ?? 0)}&length=${encodeURIComponent(p.length ?? 65536)}`],
    'publishing-media-delete': () => ['DELETE', `/v1/publishing/media/${id(p.assetId)}`],
    'drafts-list': () => ['GET', `/v1/accounts/${id(p.accountId)}/drafts${p.cursor?'?cursor='+encodeURIComponent(p.cursor):''}`],
    'drafts-get': () => ['GET', `/v1/accounts/${id(p.accountId)}/drafts/${id(p.draftId)}`],
    'drafts-save': () => ['POST', `/v1/accounts/${id(p.accountId)}/drafts`, p.input],
    'drafts-delete': () => ['DELETE', `/v1/accounts/${id(p.accountId)}/drafts/${id(p.draftId)}`],
    'account-register': () => ['POST', '/v1/accounts', p.input],
    'account-check': () => ['POST', `/v1/accounts/${id(p.accountId)}/check`, {}],
    'account-reconnect': () => ['POST', `/v1/accounts/${id(p.accountId)}/reconnect`, {}],
    'approval-decide': () => ['POST', `/v1/approvals/${id(p.approvalId)}/decide`, { decision: p.decision, operationHash: p.operationHash, reason: p.reason }],
    'action-cancel': () => ['POST', `/v1/actions/${id(p.actionId)}/cancel`, { reason: p.reason }],
    'kill-switch': () => ['POST', '/v1/kill-switches', { scope: p.scope, engaged: p.engaged === 'true', reason: p.reason, ...(p.targetId ? { targetId: p.targetId } : {}) }],
    'work-package-import': () => ['POST', '/v1/work-packages', { name: p.name, html: p.html }],
    'work-package-get': () => ['GET', `/v1/work-packages/${id(p.packageId)}`],
    'work-package-document': () => ['GET', `/v1/work-packages/${id(p.packageId)}/document`],
    'document-job-create': () => ['POST', `/v1/work-packages/${id(p.packageId)}/document-jobs`, p.input],
    'document-job-list': () => ['GET', `/v1/work-packages/${id(p.packageId)}/document-jobs`],
    'document-job-get': () => ['GET', `/v1/document-jobs/${id(p.jobId)}`],
    'document-job-update': () => ['PATCH', `/v1/document-jobs/${id(p.jobId)}`, p.input],
    'work-package-repair': () => ['PATCH', `/v1/work-packages/${id(p.packageId)}`, p.input],
    'work-package-prepare': () => ['POST', `/v1/work-packages/${id(p.packageId)}/prepare`, {}],
    'work-package-template': () => ['GET', '/v1/work-packages/template'],
    'work-packages-list': () => ['GET', `/v1/work-packages${pageQuery(p)}`],
    'plan-approve': () => ['POST', `/v1/plan-authorizations/${id(p.authorizationId)}/approve`, { operationHash: p.operationHash }],
    'people-list': () => ['GET', '/v1/people'+pageQuery(p)], 'outreach-list': () => ['GET', '/v1/outreach/sequences'+pageQuery(p)],
    'outreach-pause': () => ['POST', `/v1/outreach/sequences/${id(p.sequenceId)}/pause`, {}],
    'action-details':()=>['GET',`/v1/actions/${id(p.actionId)}`],
    'inbox-monitoring':()=>['GET','/v1/inbox/monitoring'],
    'inbox-list': () => ['GET', '/v1/inbox/threads'+pageQuery(p)],
    'inbox-assign': () => ['PATCH', `/v1/inbox/threads/${id(p.threadId)}`, { assignedTo: p.principalId, notes:p.notes }],
    insights: () => ['GET', '/v1/insights'], 'team-list': () => ['GET', '/v1/team'],
    'team-invite': () => ['POST', '/v1/team/invitations', { email: p.email, roles: p.roles }],
  };
  if (!map[action]) throw new Error('This action is unavailable in the hosted workspace.'); return map[action]();
}
export async function api(action, params = {}) {
  if (location.protocol === 'file:') throw new Error('This file is an offline interface preview. Open Carl-Allen through the trusted server or Papr to save, upload and schedule.');
  if (!hosted()) return call(action, params);
  session ||= fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => { if (!response.ok) throw new Error('Sign in to your workspace to continue.'); const value = await response.json(); if (!value.authenticated || typeof value.csrf !== 'string') throw new Error('Sign in to your workspace to continue.'); return value; }).catch((error) => { session = undefined; throw error; });
  const auth = await session; const [method, path, body] = restAction(action, params);
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-carl-csrf': auth.csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json().catch(() => ({})); if (response.status === 401) session = undefined;
  if (!response.ok) throw new Error(value.message || value.error || 'The request failed. Refresh and try again.'); return value;
}
const previewCache = new Map();
export function rememberPreview(id, file) { const old = previewCache.get(id); if (typeof old === 'string') URL.revokeObjectURL(old); const url = URL.createObjectURL(file); previewCache.set(id, url); return url; }
export async function mediaURL(asset) {
  if (previewCache.has(asset.id)) return previewCache.get(asset.id);
  const promise = (async () => {
    const chunkSize = 65536; const pieces = new Array(Math.ceil(asset.size / chunkSize)); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, pieces.length) }, async () => {
      for (;;) { const index = cursor++; if (index >= pieces.length) return; const offset = index * chunkSize; const part = await api('publishing-media-read', { assetId: asset.id, offset, length: Math.min(chunkSize, asset.size - offset) });
        const raw = atob(part.data); const bytes = new Uint8Array(raw.length); for (let j = 0; j < raw.length; j++) bytes[j] = raw.charCodeAt(j); pieces[index] = bytes;
      }
    }));
    const url = URL.createObjectURL(new Blob(pieces, { type: asset.mime })); previewCache.set(asset.id, url); return url;
  })();
  previewCache.set(asset.id, promise);
  try { return await promise; } catch (error) { previewCache.delete(asset.id); throw error; }
}
export function readBytes(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.onerror = () => reject(new Error('Could not read this file. Try selecting it again.')); reader.readAsArrayBuffer(blob); }); }
export const upload=createUploader({api,readBytes,rememberPreview});
export function revokeMedia() { for (const value of previewCache.values()) if (typeof value === 'string') URL.revokeObjectURL(value); previewCache.clear(); }
globalThis.addEventListener('pagehide', revokeMedia);
