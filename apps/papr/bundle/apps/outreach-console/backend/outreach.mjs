/* global URLSearchParams */
// Papr backend handler for the Outreach Console (ADR 0004). Node 18+, no dependencies.
// Maps a FIXED set of action names to FIXED engine API routes. It never forwards arbitrary paths or
// methods, and the API token stays server-side (declared as a manifest key, never sent to the browser).

import { readFileSync, lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;

class BadInput extends Error {}

function need(params, name, pattern) {
  const value = params[name];
  if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) throw new BadInput(`invalid or missing ${name}`);
  return value;
}

function optional(params, name, max = 500) {
  const value = params[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BadInput(`invalid ${name}`);
  return value;
}

// Re-read a rotated connection file for each request; credentials never enter frontend responses.
function connection() {
  let saved = {};
  if (process.env.OUTREACH_CONNECTION_FILE) {
    const stat = lstatSync(process.env.OUTREACH_CONNECTION_FILE);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new BadInput('Connection file must be a regular owner-only file (chmod 600)');
    try { saved = JSON.parse(readFileSync(process.env.OUTREACH_CONNECTION_FILE, 'utf8')); } catch { throw new BadInput('Cannot parse the private connection file; refresh it with the runtime connection command'); }
    if (saved.apiTokenExpiresAt && Date.now() >= (typeof saved.apiTokenExpiresAt === 'number' ? saved.apiTokenExpiresAt : Date.parse(saved.apiTokenExpiresAt))) throw new BadInput('Daytona connection expired; renew it with the runtime connection command');
  }
  return { apiUrl: saved.apiUrl || process.env.OUTREACH_API_URL, apiToken: saved.apiToken || process.env.OUTREACH_API_TOKEN, previewToken: saved.previewToken || process.env.OUTREACH_PREVIEW_TOKEN, liveViewUrl: saved.liveViewUrl || process.env.OUTREACH_DAYTONA_LIVE_VIEW_URL };
}

async function api(method, path, body) {
  const settings = connection();
  if (!settings.apiUrl || !settings.apiToken) throw new BadInput('OUTREACH_API_URL and OUTREACH_API_TOKEN must be set, or set OUTREACH_CONNECTION_FILE');
  const base = new URL(settings.apiUrl);
  if (base.username || base.password) throw new BadInput('Engine base URLs cannot contain embedded credentials');
  if (!['http:', 'https:'].includes(base.protocol) || (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new BadInput('Remote engine connections require HTTPS');
  const url = new URL(path, `${base.origin}${base.pathname.replace(/\/+$/, '')}/`);
  // Preserve signed-preview query credentials as well as route query parameters.
  for (const [key, value] of base.searchParams) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${settings.apiToken}`, ...(settings.previewToken ? { 'x-daytona-preview-token': settings.previewToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
    redirect: 'error',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message ?? `engine answered ${res.status}`);
    error.status = res.status;
    error.issues = data.issues;
    throw error;
  }
  return data;
}

function object(params, key) {
  const value = params[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadInput(`invalid ${key}`);
  return value;
}

const ACTIONS = {
  'storage-cleanup': () => api('POST','v1/publishing/media-cleanup',{}),
  'publishing-plan-prepare': (p) => api('POST','v1/publishing/plans/'+need(p,'draftId',ID)+'/prepare',{}),
  'reply-playbooks':(p)=>api('GET','v1/reply-playbooks?cursor='+encodeURIComponent(p.cursor??'')+'&limit='+String(Math.min(200,p.limit??100))),
  'reply-playbook-review':(p)=>api('GET',`v1/reply-playbooks/${need(p,'playbookId',ID)}`),
  'reply-playbook-decide':(p)=>api('POST',`v1/reply-playbooks/${need(p,'playbookId',ID)}/decide`,{decision:need(p,'decision',/^(approved|rejected)$/),operationHash:need(p,'operationHash',HASH),reason:need(p,'reason')}),
  'reply-playbook-revoke':(p)=>api('POST',`v1/reply-playbooks/${need(p,'playbookId',ID)}/revoke`,{reason:need(p,'reason')}),
  'policy-settings':()=>api('GET','v1/settings/policy'),
  'policy-settings-save':(p)=>api('PATCH','v1/settings/policy',object(p,'input')),
  'storage-settings': () => api('GET','v1/settings/media'),
  'storage-settings-save': (p) => api('PATCH','v1/settings/media',{quotaBytes:p.quotaBytes}),
  'publishing-actions-page': (p) => api('GET','v1/publishing/actions?'+new URLSearchParams(Object.entries(p).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]))),
  'publishing-drafts-page': (p) => api('GET','v1/publishing/drafts?'+new URLSearchParams(Object.entries(p).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]))),

  'work-package-import': (p) => api('POST','v1/work-packages',{name:need(p,'name'),html:need(p,'html')}),
  'work-packages-list': (p) => api('GET','v1/work-packages?cursor='+encodeURIComponent(p.cursor??'')),
  'work-package-get': (p) => api('GET','v1/work-packages/'+need(p,'packageId',ID)),
  'work-package-repair': (p) => api('PATCH','v1/work-packages/'+need(p,'packageId',ID),object(p,'input')),
  'work-package-prepare': (p) => api('POST','v1/work-packages/'+need(p,'packageId',ID)+'/prepare',{}),
  'work-package-template': () => api('GET','v1/work-packages/template'),
  'plan-approve': (p) => api('POST','v1/plan-authorizations/'+need(p,'authorizationId',ID)+'/approve',{operationHash:need(p,'operationHash',HASH)}),
  'people-list': (p) => api('GET','v1/people?cursor='+encodeURIComponent(p.cursor??'')+'&limit='+String(Math.min(200,p.limit??100))),
  'home-overview':()=>api('GET','v1/home'),
  'outreach-review':p=>api('GET','v1/outreach/sequences/'+need(p,'sequenceId',ID)),
  'outreach-resume':p=>api('POST','v1/outreach/sequences/'+need(p,'sequenceId',ID)+'/resume',{}),
  'team-member-save':p=>api('PATCH','v1/team/members/'+need(p,'principalId',ID),{roles:p.roles,reason:need(p,'reason')}),
  'team-invite-revoke':p=>api('DELETE','v1/team/invitations/'+need(p,'invitationId',ID),{reason:need(p,'reason')}),
  'outreach-list': (p) => api('GET','v1/outreach/sequences?cursor='+encodeURIComponent(p.cursor??'')+'&limit='+String(Math.min(200,p.limit??100))),
  'outreach-pause': (p) => api('POST','v1/outreach/sequences/'+need(p,'sequenceId',ID)+'/pause',{}),
  'action-details':(p)=>api('GET',`v1/actions/${need(p,'actionId',ID)}`),
  'inbox-monitoring':()=>api('GET','v1/inbox/monitoring'),
  'inbox-list': (p) => api('GET','v1/inbox/threads?cursor='+encodeURIComponent(p.cursor??'')+'&limit='+String(Math.min(200,p.limit??100))),
  'inbox-assign': (p) => api('PATCH','v1/inbox/threads/'+need(p,'threadId',ID),{...(p.principalId!==undefined?{assignedTo:p.principalId===null?null:need(p,'principalId',ID)}:{}),...(p.notes!==undefined?{notes:p.notes}:{})}),
  'insights': () => api('GET','v1/insights'),
  'team-list': () => api('GET','v1/team'),
  'team-invite': (p) => api('POST','v1/team/invitations',{email:need(p,'email'),roles:p.roles}),

  'publishing-overview': async () => { const data=await api('GET','v1/publishing'); return {...data,liveViewUrl:data.roles?.includes('admin')?(connection().liveViewUrl||null):null}; },
  'publishing-draft-save': (p) => api('POST', 'v1/publishing/drafts', object(p, 'input')),
  'publishing-draft-delete': (p) => api('DELETE', `v1/publishing/drafts/${need(p, 'draftId', ID)}`),
  'publishing-submit': (p) => api('POST', `v1/publishing/drafts/${need(p, 'draftId', ID)}/submit`),
  'publishing-upload-status': (p) => api('GET', `v1/publishing/uploads/${need(p,'uploadId',ID)}`),
  'publishing-upload-start': (p) => api('POST', 'v1/publishing/uploads', object(p, 'input')),
  'publishing-upload-chunk': (p) => api('POST', `v1/publishing/uploads/${need(p, 'uploadId', ID)}/chunks`, { index: p.index, data: p.data }),
  'publishing-upload-complete': (p) => api('POST', `v1/publishing/uploads/${need(p, 'uploadId', ID)}/complete`),
  'publishing-upload-cancel': (p) => api('DELETE', `v1/publishing/uploads/${need(p, 'uploadId', ID)}`),
  'publishing-media-read': (p) => api('GET', `v1/publishing/media/${need(p, 'assetId', ID)}?offset=${encodeURIComponent(p.offset ?? 0)}&length=${encodeURIComponent(p.length ?? 65536)}`),
  'publishing-media-delete': (p) => api('DELETE', `v1/publishing/media/${need(p, 'assetId', ID)}`),
  async overview() {
    const [campaigns, approvals, review, tasks, upcoming, calendar, social, content, accounts] = await Promise.all([
      api('GET', 'v1/campaigns'),
      api('GET', 'v1/approvals'),
      api('GET', 'v1/review'),
      api('GET', 'v1/tasks'),
      api('GET', 'v1/actions/upcoming?hours=24'),
      api('GET', 'v1/content-calendar?hours=168'),
      api('GET', 'v1/social/status'),
      api('GET', 'v1/content-campaigns'),
      api('GET', 'v1/accounts'),
    ]);
    const live = campaigns.campaigns.filter((c) => c.status === 'active' || c.status === 'paused').slice(0, 20);
    const statuses = await Promise.all(live.map((c) => api('GET', `v1/campaigns/${encodeURIComponent(c.id)}`)));
    return {
      campaigns: campaigns.campaigns,
      statuses,
      approvals: approvals.approvals,
      review: review.actions,
      tasks: tasks.tasks,
      upcoming: upcoming.actions,
      calendar: calendar.posts,
      content: content.campaigns,
      accounts: accounts.accounts,
      // Prefer the Mac-side live-view key when set; else the Daytona engine's env.
      social: {
        ...social,
        liveViewUrl: connection().liveViewUrl || social.liveViewUrl || null,
      },
    };
  },
  'content-compose': (p) => api('POST', 'v1/content-compose', object(p, 'input')),
  'content-create': (p) => api('POST', 'v1/content-campaigns', object(p, 'input')),
  'content-update': (p) => api('PATCH', `v1/content-campaigns/${need(p, 'campaignId', ID)}`, object(p, 'input')),
  'content-delete': (p) => api('DELETE', `v1/content-campaigns/${need(p, 'campaignId', ID)}`),
  'content-activate': (p) => api('POST', `v1/content-campaigns/${need(p, 'campaignId', ID)}/activate`),
  'action-update': (p) => api('PATCH', `v1/actions/${need(p, 'actionId', ID)}`, object(p, 'input')),
  'action-cancel': (p) => api('POST', `v1/actions/${need(p, 'actionId', ID)}/cancel`, { reason: need(p, 'reason') }),
  'action-manual': (p) => api('POST', `v1/actions/${need(p, 'actionId', ID)}/manual`, { reason: need(p, 'reason') }),
  'action-schedule': (p) => api('POST', 'v1/actions', object(p, 'input')),
  'account-register': (p) => api('POST', 'v1/accounts', object(p, 'input')),
  'account-check': (p) => api('POST', `v1/accounts/${need(p, 'accountId', ID)}/check`),
  'account-reconnect': (p) => api('POST', `v1/accounts/${need(p, 'accountId', ID)}/reconnect`),
  'drafts-list': (p) => api('GET', `v1/accounts/${need(p, 'accountId', ID)}/drafts`),
  'drafts-get': (p) => api('GET', `v1/accounts/${need(p, 'accountId', ID)}/drafts/${encodeURIComponent(need(p, 'draftId'))}`),
  'drafts-save': (p) => api('POST', `v1/accounts/${need(p, 'accountId', ID)}/drafts`, object(p, 'input')),
  'drafts-delete': (p) => api('DELETE', `v1/accounts/${need(p, 'accountId', ID)}/drafts/${encodeURIComponent(need(p, 'draftId'))}`),
  'approval-decide': (p) =>
    api('POST', `v1/approvals/${need(p, 'approvalId', ID)}/decide`, {
      decision: need(p, 'decision', /^(approved|rejected)$/),
      operationHash: need(p, 'operationHash', HASH),
      ...(optional(p, 'reason') ? { reason: optional(p, 'reason') } : {}),
    }),
  'task-outcome': (p) =>
    api('POST', `v1/tasks/${need(p, 'taskId', ID)}/outcome`, {
      outcome: need(p, 'outcome', /^(done|skipped)$/),
      ...(optional(p, 'note', 1000) ? { note: optional(p, 'note', 1000) } : {}),
    }),
  'review-resolve': (p) => {
    const kind = need(p, 'kind', /^(sent|not_sent_retry|drop)$/);
    const body = kind === 'sent' ? { kind, providerMessageId: need(p, 'providerMessageId') } : kind === 'drop' ? { kind, reason: need(p, 'reason') } : { kind };
    return api('POST', `v1/review/${need(p, 'actionId', ID)}/resolve`, body);
  },
  'campaign-pause': (p) => api('POST', `v1/campaigns/${need(p, 'campaignId', ID)}/pause`, { reason: need(p, 'reason') }),
  'campaign-resume': (p) => api('POST', `v1/campaigns/${need(p, 'campaignId', ID)}/resume`, { reason: need(p, 'reason') }),
  'kill-switch': (p) =>
    api('POST', 'v1/kill-switches', {
      scope: need(p, 'scope', /^(workspace|provider_account|campaign)$/),
      engaged: need(p, 'engaged', /^(true|false)$/) === 'true',
      reason: need(p, 'reason'),
      ...(optional(p, 'targetId') ? { targetId: need(p, 'targetId', ID) } : {}),
    }),
};

export async function handle(action, params) {
  const run = ACTIONS[action];
  if (!run) return { ok: false, error: `unknown action ${action}` };
  try {
    return { ok: true, data: await run(params ?? {}) };
  } catch (error) {
    return { ok: false, error: error.message, ...(error.status ? { status: error.status } : {}), ...(error.issues ? { issues: error.issues } : {}) };
  }
}

// Run as a Papr backend action: PAPR_ACTION + PAPR_ACTION_PARAMS in, one JSON line on stdout.
if (process.env.PAPR_ACTION && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let params = {};
  try {
    params = JSON.parse(process.env.PAPR_ACTION_PARAMS ?? '{}');
  } catch {
    params = {};
  }
  const result = await handle(process.env.PAPR_ACTION, params);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
