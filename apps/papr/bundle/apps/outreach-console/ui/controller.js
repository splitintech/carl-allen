import { mountAuthoring } from './authoring.js';
import { mountMailDrafts } from './mail-drafts.js';
/* global setInterval, clearInterval */
import { $ } from './dom.js';
import { call } from './api.js';
import { createActions } from './actions.js';
import { askConfirm } from './dialog.js';
import { renderTimeline } from './timeline.js';
import { renderApprovals } from './approvals.js';
import { renderReview } from './review.js';
import { renderTasks } from './tasks.js';
import { renderCampaigns } from './campaigns.js';
import { renderCalendar } from './calendar.js';
import { renderSocial } from './social.js';

export function mount() {
  const act = createActions(refresh);
  let current = { accounts: [] };
  const renderContent = mountAuthoring(() => current, act);
  const renderDrafts = mountMailDrafts(() => current, act);
  async function refresh() {
    try {
      const data = await call('overview');
      current = data;
      renderTimeline(data.upcoming, act);
      renderApprovals(data.approvals, act);
      renderReview(data.review, act);
      renderTasks(data.tasks, act);
      renderCampaigns(data.campaigns, data.statuses, act);
      renderCalendar(data.calendar || [], act);
      renderContent(data.content || []);
      renderDrafts(data.accounts || []);
      renderSocial(data.social ? { ...data.social, allAccounts: data.accounts || [] } : null, act);
      const waiting = data.approvals.length + data.review.length + data.tasks.length;
      $('summary').textContent = `${data.upcoming.length} going out in 24h · ${waiting} waiting on you`;
    } catch (error) {
      $('summary').textContent = `Cannot reach the outreach engine: ${error.message}. Is outreach serve running, and are OUTREACH_API_URL / OUTREACH_API_TOKEN set?`;
    }
  }
  $('refresh').addEventListener('click', refresh);
  $('stop-all').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (await askConfirm('Stop every send in this workspace now? Resuming needs an approver.')) {
      await act(button, 'kill-switch', { scope: 'workspace', engaged: 'true', reason: 'stopped from Outreach Console' }, 'All sending stopped');
    }
  });
  void refresh();
  const timer = setInterval(refresh, 30_000);
  globalThis.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
