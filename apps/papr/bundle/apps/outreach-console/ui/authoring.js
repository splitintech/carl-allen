import { $, el, toast } from './dom.js';
import { editFields } from './editor.js';
const localTime = (value) => { const d = new Date(value ?? Date.now() + 3600000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const options = (accounts) => accounts.map((a) => ({ value: a.id, label: `${a.provider} · ${a.externalAccountId}` }));
export function mountAuthoring(getData, act) {
  async function compose(button, campaign, post) {
    const accounts = getData().accounts.filter((a) => a.capabilities?.socialPublish);
    if (!accounts.length) { toast('Connect a social publishing account first'); return; }
    const input = await editFields(campaign ? 'Edit content draft' : 'Create a post', [
      { name: 'name', label: 'Title', required: true, value: campaign?.name, max: 200 },
      { name: 'providerAccountId', label: 'Publish as', options: options(accounts), required: true, value: post?.providerAccountId ?? campaign?.providerAccountId ?? accounts[0].id },
      { name: 'channel', label: 'Channel', required: true, value: post?.channel ?? 'linkedin' },
      { name: 'text', label: 'Post', multiline: true, required: true, value: post?.text, max: 100000 },
      { name: 'mediaUrls', label: 'Image URLs (one HTTPS URL per line, approved hosts only)', multiline: true, value: (post?.mediaUrls ?? []).join('\n') },
      { name: 'scheduledFor', label: 'Schedule', type: 'datetime-local', required: true, value: localTime(post?.scheduledFor) },
    ], 'Save draft', button);
    if (!input) return;
    input.scheduledFor = new Date(input.scheduledFor).toISOString();
    input.mediaUrls = input.mediaUrls.split(/\s+/).filter(Boolean);
    input.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (campaign) { input.campaignId = campaign.campaignId; input.postId = post.id; }
    await act(button, 'content-compose', { input }, 'Draft saved. Schedule it when ready for approval.');
  }
  $('create-post').addEventListener('click', (e) => compose(e.currentTarget));
  $('create-task').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const accounts = getData().accounts.filter((a) => a.capabilities?.executionPlacement === 'daytona-browser');
    if (!accounts.length) { toast('Connect a browser account first'); return; }
    const actionOptions = (account) => [
      ...(account.capabilities?.socialMessage ? [{ value: 'social.message', label: 'Send a LinkedIn message' }] : []),
      ...(account.capabilities?.socialConnect ? [{ value: 'social.connect', label: 'Send a LinkedIn connection request' }] : []),
      ...(account.capabilities?.browserTasks ? [{ value: 'browser.task', label: 'Run a configured browser task' }] : []),
    ];
    const changeAccount = (id, inputs) => {
      const selected = accounts.find((account) => account.id === id);
      const kind = inputs.get('kind'); const previous = kind.value;
      const choices = selected ? actionOptions(selected) : [];
      kind.replaceChildren(...choices.map((choice) => el('option', { value: choice.value, text: choice.label })));
      kind.value = choices.some((choice) => choice.value === previous) ? previous : choices[0]?.value ?? '';
    };
    const usable = accounts.filter((account) => actionOptions(account).length);
    if (!usable.length) { toast('This account has no supported messaging, connection, or browser task capability'); return; }
    const values = await editFields('Schedule a browser action', [
      { name: 'providerAccountId', label: 'Account', options: options(usable), value: usable[0].id, required: true, onChange: changeAccount },
      { name: 'kind', label: 'Action', options: actionOptions(usable[0]), value: actionOptions(usable[0])[0].value, required: true },
      { name: 'targetUrl', label: 'Recipient profile URL (messages and connections)', max: 2000 },
      { name: 'text', label: 'Message or connection note', multiline: true, max: 100000 },
      { name: 'recipeId', label: 'Configured task name (browser tasks)' },
      { name: 'input', label: 'Task fields as JSON (browser tasks)', multiline: true, value: '{}' },
      { name: 'dueAt', label: 'Schedule', type: 'datetime-local', value: localTime(), required: true },
    ], 'Queue for approval', button);
    if (!values) return;
    try {
      const payload = values.kind === 'browser.task' ? { recipeId: values.recipeId, input: JSON.parse(values.input) } : { channel: 'linkedin', targetUrl: values.targetUrl, text: values.text };
      await act(button, 'action-schedule', { input: { kind: values.kind, providerAccountId: values.providerAccountId, payload, dueAt: new Date(values.dueAt).getTime(), purpose: 'manual_correspondence', approval: 'always', idempotencyKey: globalThis.crypto.randomUUID() } }, 'Action queued for approval');
    } catch (error) { toast(error.message); }
  });
  return (campaigns) => {
    $('content-drafts').replaceChildren(...campaigns.filter((c) => c.status === 'draft').map((campaign) => el('li', { class: 'card' }, el('strong', { text: campaign.name }), ...campaign.posts.map((post) => el('div', {}, el('p', { text: post.text }), el('button', { type: 'button', text: 'Edit draft', onclick: (e) => compose(e.currentTarget, campaign, post) }))), el('div', { class: 'row' }, el('button', { type: 'button', text: 'Schedule for approval', onclick: (e) => act(e.currentTarget, 'content-activate', { campaignId: campaign.campaignId }, 'Posts scheduled for approval') }), el('button', { type: 'button', text: 'Delete draft', onclick: (e) => act(e.currentTarget, 'content-delete', { campaignId: campaign.campaignId }, 'Draft deleted') })))));
  };
}
