import { el, button, modal, busy, notify } from './utils.js';
import { api } from './service.js';
export function sendingControl(refresh, resume = false) {
  const m = modal(resume ? 'Resume workspace sending?' : 'Stop all sending?', resume ? 'Existing approved posts and outreach may run again.' : 'Pause pending posts and messages across this entire workspace.', true);
  m.content.append(el('div', { class: 'review-content' }, el('p', { class: 'field-help', text: resume ? 'Review your queue and connected accounts first. Resuming does not approve new content or resolve uncertain actions.' : 'This affects scheduled social posts and other outreach sends. It cannot recall a post or message already being sent. Content stays saved, and resuming requires an approver.' })));
  const control = button(resume ? 'Resume sending' : 'Stop all sending', () => busy(control, async () => {
    await api('kill-switch', { scope: 'workspace', engaged: resume ? 'false' : 'true', reason: resume ? 'Resumed in Publishing Studio' : 'Stopped in Publishing Studio' }); m.close(); await refresh(); notify(resume ? 'Workspace sending resumed. Existing approvals and policies still apply.' : 'Workspace sending stopped. Existing content is kept.');
  }), resume ? 'primary' : 'danger');
  m.bottom.append(button(resume ? 'Keep paused' : 'Keep sending', m.close), control);
}
