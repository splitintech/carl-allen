import {mailboxAccounts} from './mailbox-accounts.js';
import {manualReplyPanel} from './inbox-replies.js';
import {renderHome} from './home.js';
import {renderOutreach} from './outreach.js';
import {renderInsights,storageSummary} from './insights.js';
import {renderTeam} from './team.js';
export {renderHome,renderOutreach,renderInsights};
import {renderReplyPlaybooks} from './reply-playbooks.js';
import {renderInboxMonitoring} from './delivery.js';
import {executionPolicyForm} from './policy.js';
/* global URL */
import { el, button, badge, field, modal, busy, notify, dateText } from './utils.js';
import { api } from './service.js';
import { openImport } from './work-packages.js';
import { renderAccounts } from './accounts.js';
import { renderMailbox } from './mailbox.js';
const authorized = (data, roles) => data.roles?.some((role) => roles.includes(role));
function table(heads, rows) { return el('div', { class: 'table-scroll' }, el('table', { class: 'report-table' }, el('thead', {}, el('tr', {}, ...heads.map((text) => el('th', { scope: 'col', text })))), el('tbody', {}, ...rows))); }
function source(url) { try { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) return null; return el('a', { href: u.href, class: 'source-link', target: '_blank', rel: 'noopener noreferrer', text: u.hostname }); } catch { return null; } }
function openPerson(person){const m=modal(person.name||'Sourced person','Retained research and channel identities. Changes need repaired HTML and fresh review.');const body=el('div',{class:'review-content'},badge(person.status),el('p',{text:person.notes||'No research notes recorded.'}));for(const point of person.points||[])body.append(el('article',{class:'review-tile'},el('h3',{text:point.channels.join(' · ')||point.kind}),el('p',{text:point.value}),el('small',{class:'field-help',text:`${point.consentBasis.replaceAll('_',' ')} · ${point.jurisdiction||'Jurisdiction not supplied'} · ${point.source}`})));body.append(el('div',{class:'toolbar-group'},...(person.sources||[]).map(source)));m.content.append(body);m.bottom.append(button('Close',m.close));}
export function renderPeople(data, refresh) {
  const people = data.people || []; const search = el('input', { class: 'field-control', type: 'search', name: 'peopleSearch', 'aria-label': 'Find a person', placeholder: 'Find by name, email or profile…', autocomplete: 'off' }); const panel = el('section', { class: 'content-panel' }); const body = el('div');
  const draw = () => { const query = search.value.trim().toLowerCase(); const rows = people.filter((person) => [person.name, person.full_name, person.email, person.linkedin, person.instagram].some((v) => v?.toLowerCase().includes(query))).map((person) => el('tr', {}, el('td', {}, el('strong', { text: person.name || person.full_name || 'Unnamed contact' }), el('small', { text: person.notes || '' })), el('td', { text: person.email || 'No email supplied' }), el('td', {}, source(person.linkedin), source(person.instagram)), el('td', {}, ...(person.sources || []).map(source)), el('td', {}, badge(person.status || person.consentBasis || 'Needs review')),el('td',{},button('View person',()=>openPerson(person),'small')))); body.replaceChildren(rows.length ? table(['Person', 'Email', 'Profiles', 'Research sources', 'Status','Details'], rows) : el('div', { class: 'empty-state' }, el('h3', { text: people.length ? 'No people match your search' : 'Bring people from your research' }), el('p', { text: 'Import real contacts with their source links. Carl-Allen does not invent email addresses or run a separate paid research agent.' }), button('Import research HTML', () => openImport(data, refresh), 'primary'))); };
  search.addEventListener('input', draw); panel.append(el('div', { class: 'panel-toolbar' }, el('h2', { text: `${people.length.toLocaleString()} people` }), search), body); draw(); return panel;
}
export function renderInbox(data, refresh, tab = 'conversations', onTab = () => {}) {
  const root = el('div', { class: 'stack' }, el('div', { class: 'view-tabs' }, button('Conversations', () => onTab('conversations'), tab === 'conversations' ? 'active' : ''), button('Mailbox drafts', () => onTab('drafts'), tab === 'drafts' ? 'active' : ''),button('Reply playbooks',()=>onTab('replies'),tab==='replies'?'active':'')));
  if(tab==='replies'){root.append(renderReplyPlaybooks(data,refresh));return root;}
  if (tab === 'drafts') { root.append(renderMailbox(data,refresh)); return root; }
  root.append(renderInboxMonitoring(data));
  const threads = data.threads || []; const panel = el('section', { class: 'content-panel' }, el('div', { class: 'panel-toolbar' }, el('h2', { text: 'Conversations & follow-ups' }), el('small', { class: 'muted', text: 'Synced conversation data' })));
  if (!threads.length) panel.append(el('div', { class: 'empty-state' }, el('h3', { text: 'A place for your conversations' }), el('p', { text: 'Connected accounts appear here after inbox synchronization. Check the account and monitoring status before relying on automated follow-ups.' })));
  for (const thread of threads) panel.append(el('article', { class: 'queue-card' }, badge(thread.channel || 'email'), el('div', {}, el('h3', { text: thread.subject || thread.name || 'Conversation' }), el('p', { text: thread.snippet || thread.lastText || '' }), el('div', { class: 'queue-meta' }, el('span', { text: thread.updatedAt ? 'Latest conversation activity '+dateText(thread.updatedAt) : 'Conversation activity time unavailable' }), el('span', { text: thread.assignedTo ? 'Assigned' : 'Unassigned' }))), button('Open conversation', () => openThread(thread, data, refresh), 'small'))); root.append(panel); return root;
}
function openThread(thread, data, refresh) {
  const m = modal(thread.subject || 'Conversation', 'Incoming content is shown as text. It does not authorize new work.'); const body = el('div', { class: 'review-content' });
  for (const message of thread.messages || []) body.append(el('article', { class: 'review-tile' }, el('div',{class:'message-meta'},el('strong',{text:message.inbound?'Incoming reply':'Sent message'}),message.at?el('time',{text:dateText(message.at),datetime:new Date(message.at).toISOString()}):null), el('p', { text: message.text || message.snippet || '' }), message.receivedAt ? el('small', { text: dateText(message.receivedAt) }) : null));
  if (!thread.messages?.length) body.append(el('p', { class: 'flow-note', text: thread.snippet || thread.lastText || 'No message body is available in this snapshot.' }));
  const assignee = el('select', { class: 'field-control', 'aria-label': 'Assign conversation' }, el('option', { value: '', text: 'Unassigned' }), ...(data.members || []).map((member) => el('option', { value: member.id || member.principalId, text: member.email || member.name || member.id }))); assignee.value = thread.assignedTo || '';
  const notes=el('textarea',{class:'field-control',name:'notes',rows:4,maxlength:10000});notes.value=thread.notes||'';
  if(!authorized(data,['admin','operator','approver'])){notes.readOnly=true;assignee.disabled=true;}
  body.append(field('Team notes',notes),field('Assigned teammate', assignee), el('p', { class: 'flow-note', text: 'Replies stop the original outreach sequence. Separately approved reply playbooks can respond automatically. Manual social responses require exact review below.' }),manualReplyPanel(thread,data,refresh)); m.content.append(body); m.bottom.append(button('Close', m.close));
  if (authorized(data, ['admin', 'operator', 'approver'])) { const save = button('Save assignment', () => busy(save, async () => { await api('inbox-assign', { threadId: thread.id, principalId: assignee.value || null,notes:notes.value }); m.close(); await refresh(); notify('Conversation assignment updated.'); }), 'primary'); m.bottom.append(save); }
}
export function renderSettings(data, refresh, tab = 'accounts', onTab = () => {}) {
  const root = el('div', { class: 'stack' }, el('div', { class: 'view-tabs' }, button('Accounts', () => onTab('accounts'), tab === 'accounts' ? 'active' : ''), button('Team & roles', () => onTab('team'), tab === 'team' ? 'active' : ''), button('Storage', () => onTab('storage'), tab === 'storage' ? 'active' : ''), button('Connections & policy', () => onTab('connections'), tab === 'connections' ? 'active' : '')));
  if(tab==='storage') {
    const storage=data.storage; const gib=1024*1024*1024; const quota=el('input',{class:'field-control',type:'number','data-retain-input':'true',min:1,max:1024,step:1,'aria-label':'Workspace storage quota in GB'});quota.value=String(Math.round((storage?.quotaBytes??50*gib)/gib));quota.disabled=!authorized(data,['admin']);
    const panel=el('section',{class:'info-card'},el('h3',{text:'Private media storage'}),el('p',{text:storage?.storageMode==='r2'?'Immutable media is persisted in private R2 object storage.':'Local sandbox storage is active. Configure private R2 before relying on the full cloud library capacity.'}),field('Workspace quota (GB)',quota),el('p',{class:'flow-note',text:'Per-file upload limits and native platform processing limits are separate. Referenced assets remain protected from deletion.'}));
    if(authorized(data,['admin'])){const save=button('Save storage quota',()=>busy(save,async()=>{if(!quota.validity.valid){quota.reportValidity();return;}await api('storage-settings-save',{quotaBytes:Number(quota.value)*gib});await refresh();notify('Storage quota updated.');}),'primary');panel.append(save);}
    if(authorized(data,['operator','admin'])){const clean=button('Retry pending cleanup',()=>busy(clean,async()=>{const result=await api('storage-cleanup');notify(String(result.cleaned??0)+' objects cleaned; '+String(result.pending??0)+' pending.');}),'small');panel.append(clean);}
    panel.append(storageSummary(storage));root.append(panel);return root;
  }
  if (tab === 'accounts') { root.append(renderAccounts(data, refresh),mailboxAccounts(data,refresh)); return root; }
  if (tab === 'connections') { root.append(executionPolicyForm(data,refresh),el('section', { class: 'info-card' }, el('h3', { text: 'One queue. Independent cloud execution.' }), el('p', { text: 'Papr and ChatGPT connect to Carl-Allen’s authenticated MCP endpoint. They can prepare work and read results; final approval stays in this workspace. Credentials remain on the server.' }), el('ul', { class: 'compact-list' }, el('li', {}, 'MCP connection', el('small', { text: 'https://carl-allen.splitin.net/mcp' })), el('li', {}, 'Initial workspace capacity', el('small', { text: '10 social targets · 1,000 publications per month · 50 GB private media. Account and platform limits still apply.' })), el('li', {}, 'Zoho Mail', el('small', { text: 'Inbox and drafts only. Complete sending manually in Zoho.' })), el('li', {}, 'Approvals', el('small', { text: 'Monthly plans cover exact account/content/media/schedules. Edits require new approval.' }))))); return root; }
  root.append(renderTeam(data,refresh));return root;
}
