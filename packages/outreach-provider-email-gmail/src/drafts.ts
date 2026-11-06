import { randomUUID } from 'node:crypto';
import { buildMime, DraftMutationRefusedError, type AccessTokenSource, type EmailAddress, type EmailContent, type EmailDraftPort, type MailDraft, type ProviderContext } from '@splitin/outreach-contracts';
import { gmailRequest, type HttpDeps } from './http';

interface Part { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }
interface Draft { id: string; message?: { internalDate?: string; threadId?: string; payload?: Part } }
function addresses(value: string): EmailAddress[] {
  return [...value.matchAll(/(?:"?([^"<>]*?)"?\s*)?<([^<>]+@[^<>]+)>|([^\s,<>]+@[^\s,<>]+)/g)].map((m) => ({ address: (m[2] ?? m[3] ?? '').trim(), ...(m[1]?.trim() ? { name: m[1].trim() } : {}) }));
}
function content(draft: Draft, ctx: ProviderContext): MailDraft {
  const part = draft.message?.payload ?? {};
  const header = (name: string) => part.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const body = (node: Part, kind: string): string => node.mimeType === kind && node.body?.data ? Buffer.from(node.body.data, 'base64url').toString('utf8') : (node.parts ?? []).map((p) => body(p, kind)).filter(Boolean).join('\n');
  const html = body(part, 'text/html');
  return { id: draft.id, content: { from: addresses(header('from'))[0] ?? { address: ctx.account.sender.address }, to: addresses(header('to')), subject: header('subject'), text: body(part, 'text/plain'), headers: {}, ...(addresses(header('reply-to'))[0] ? { replyTo: addresses(header('reply-to'))[0] } : {}), ...(header('in-reply-to') ? { inReplyTo: header('in-reply-to') } : {}), ...(header('references') ? { references: header('references').match(/<[^<>\s]+>/g) ?? [] } : {}), ...(html ? { html } : {}), ...(draft.message?.threadId ? { providerThreadId: draft.message.threadId } : {}) }, ...(draft.message?.internalDate ? { updatedAt: Number(draft.message.internalDate) } : {}) };
}

/** Draft endpoints only. No operation in this port sends a message. Existing grants need gmail.compose. */
export function gmailDrafts(http: HttpDeps, tokens: AccessTokenSource): EmailDraftPort {
  const request = async (ctx: ProviderContext, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, json?: unknown) => {
    const result = await gmailRequest(http, ctx, await tokens.get(ctx), method, path, { ...(json === undefined ? {} : { json }) });
    if (result.status === 401) tokens.invalidate(ctx);
    if (result.status < 200 || result.status >= 300) throw new Error(`Gmail draft operation failed (HTTP ${result.status}); check grant scopes and reconnect if needed`);
    return result.body;
  };
  const read = async (ctx: ProviderContext, id: string) => await request(ctx, 'GET', `/gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=full`) as unknown as Draft;
  const get = async (ctx: ProviderContext, id: string) => content(await read(ctx, id), ctx);
  return {
    async list(ctx) {
      const result: MailDraft[] = [];
      let next: string | undefined;
      do {
        const page = await request(ctx, 'GET', `/gmail/v1/users/me/drafts?maxResults=100${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`);
        for (const item of (page.drafts ?? []) as { id: string }[]) result.push(await get(ctx, item.id));
        next = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
      } while (next && result.length < 1000);
      return result;
    },
    get,
    async save(ctx, input: EmailContent & { id?: string }) {
      if (input.id) {
        const existing = await read(ctx, input.id);
        const attachment = (part: Part): boolean => Boolean(part.filename || part.body?.attachmentId || part.parts?.some(attachment));
        const extraRecipients = existing.message?.payload?.headers?.some((h) => /^(cc|bcc)$/i.test(h.name) && h.value.trim());
        if (attachment(existing.message?.payload ?? {}) || extraRecipients) throw new DraftMutationRefusedError('This draft has attachments or CC/BCC recipients; edit it in Gmail to preserve them. No update was made.');
        const prior = content(existing, ctx).content;
        input = { ...prior, ...input };
      }
      const key = randomUUID();
      const raw = Buffer.from(buildMime({ ...input, actionId: key, idempotencyKey: `draft:${key}`, contentHash: '', rfcMessageId: `<${key}@outreach.draft>` }, new Date(ctx.now())), 'utf8').toString('base64url');
      const message = { raw, ...(input.providerThreadId ? { threadId: input.providerThreadId } : {}) };
      const saved = await request(ctx, input.id ? 'PUT' : 'POST', `/gmail/v1/users/me/drafts${input.id ? `/${encodeURIComponent(input.id)}` : ''}`, { message });
      return get(ctx, String(saved.id));
    },
    async delete(ctx, id) { await request(ctx, 'DELETE', `/gmail/v1/users/me/drafts/${encodeURIComponent(id)}`); },
  };
}
