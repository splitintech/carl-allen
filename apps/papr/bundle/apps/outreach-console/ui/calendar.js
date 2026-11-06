import { editFields } from './editor.js';
import { $, el, empty } from './dom.js';

function when(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return String(ms);
  }
}

export function renderCalendar(posts, act) {
  if (!posts?.length) return empty('calendar', 'No content posts queued. Create a post above.');
  $('calendar').replaceChildren(
    ...posts.map((post) =>
      el(
        'li',
        { class: 'card' },
        el('strong', { text: post.channel }),
        el('div', { class: 'meta', text: `${post.state} · ${when(post.dueAt)}` }),
        el('p', { text: post.text.slice(0, 280) }),
        ...(!['succeeded','failed','cancelled','executing','claimed'].includes(post.state) ? [el('div', { class: 'row' },
          el('button', { type: 'button', text: 'Edit post', onclick: async (e) => {
            const button = e.currentTarget;
            const input = await editFields('Edit scheduled post', [{ name: 'text', label: 'Post', multiline: true, required: true, value: post.text }, { name: 'mediaUrls', label: 'Image URLs (one HTTPS URL per line)', multiline: true, value: (post.mediaUrls ?? []).join('\n') }, { name: 'scheduledFor', label: 'Schedule (ISO date and time)', required: true, value: new Date(post.dueAt).toISOString() }], 'Save and request fresh approval', button);
            if (input) { input.mediaUrls = input.mediaUrls.split(/\s+/).filter(Boolean); await act(button, 'action-update', { actionId: post.actionId ?? post.id, input }, 'Post changed. Fresh approval required.'); }
          } }),
          el('button', { type: 'button', text: 'Cancel post', onclick: (e) => act(e.currentTarget, 'action-cancel', { actionId: post.actionId ?? post.id, reason: 'Cancelled in Outreach Console' }, 'Post cancelled') }),
          el('button', { type: 'button', text: 'Do manually', onclick: (e) => act(e.currentTarget, 'action-manual', { actionId: post.actionId ?? post.id, reason: 'Operator chose manual posting' }, 'Manual task created') }),
        )] : []),
      ),
    ),
  );
}
