import type { AccessTokenSource, EmailAddress, MailDraftContent, EmailDraftPort, MailDraft, ProviderContext } from '@splitin/outreach-contracts';
import { jsonRequest,plainMailText } from '@splitin/outreach-provider-kit';
import type { HttpDeps } from './graph';
interface Message { id: string; isDraft?: boolean; from?: { emailAddress: EmailAddress }; toRecipients?: { emailAddress: EmailAddress }[]; ccRecipients?:{emailAddress:EmailAddress}[];bccRecipients?:{emailAddress:EmailAddress}[]; replyTo?: { emailAddress: EmailAddress }[]; subject?: string; body?: { contentType?: string; content?: string }; lastModifiedDateTime?: string }
function draft(message: Message, ctx: ProviderContext): MailDraft {
  return { id: message.id, content: { from: message.from?.emailAddress ?? { address: ctx.account.sender.address }, to: (message.toRecipients ?? []).map((r) => r.emailAddress), cc:(message.ccRecipients??[]).map(r=>r.emailAddress),bcc:(message.bccRecipients??[]).map(r=>r.emailAddress),bodyFormat:message.body?.contentType?.toLowerCase()==='html'?'html':'plaintext',subject: message.subject ?? '', text: message.body?.contentType?.toLowerCase() === 'text' ? message.body.content ?? '' : plainMailText(message.body?.content??''), ...(message.body?.contentType?.toLowerCase() === 'html' ? { html: message.body.content ?? '' } : {}), headers: {}, ...(message.replyTo?.[0] ? { replyTo: message.replyTo[0].emailAddress } : {}) }, ...(message.lastModifiedDateTime ? { updatedAt: Date.parse(message.lastModifiedDateTime) } : {}) };
}
/** No send endpoint: explicit draft CRUD, with isDraft checked before any existing-message mutation. */
export function outlookDrafts(http: HttpDeps, tokens: AccessTokenSource): EmailDraftPort {
  const request = async (ctx: ProviderContext, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, json?: unknown) => {
    const url = path.startsWith('https:') ? new URL(path) : new URL(`/v1.0${path}`, http.api);
    if (url.origin !== new URL(http.api).origin) throw new Error('refusing foreign draft pagination URL');
    const result = await jsonRequest(http, { url, method, token: await tokens.get(ctx), signal: ctx.signal, ...(json === undefined ? {} : { json }) });
    if (result.status === 401) tokens.invalidate(ctx);
    if (result.status < 200 || result.status >= 300) throw new Error(`Outlook draft operation failed (HTTP ${result.status}); check grant permissions`);
    return result.body;
  };
  const read = async (ctx: ProviderContext, id: string) => {
    const message = await request(ctx, 'GET', `/me/messages/${encodeURIComponent(id)}`) as unknown as Message;
    if (message.isDraft !== true) throw new Error('message is not a draft');
    return message;
  };
  const listPage=async(ctx:ProviderContext,input:{cursor?:string;limit?:number})=>{const page=await request(ctx,'GET',input.cursor??`/me/mailFolders/drafts/messages?$top=${Math.min(100,input.limit??50)}`);return{drafts:((page.value??[]) as Message[]).filter(m=>m.isDraft===true).map(m=>draft(m,ctx)),...(typeof page['@odata.nextLink']==='string'?{nextCursor:page['@odata.nextLink']}:{})};};
  return {
    listPage,
    async mailboxInfo(){return{webUrl:'https://outlook.office.com/mail/',attachmentUpload:false};},
    async list(ctx) {
      const result: MailDraft[] = [];
      let next: string | undefined = '/me/mailFolders/drafts/messages?$top=100';
      do {
        const page = await request(ctx, 'GET', next);
        result.push(...((page.value ?? []) as Message[]).filter((m) => m.isDraft === true).map((m) => draft(m, ctx)));
        next = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : undefined;
      } while (next && result.length < 1000);
      return result;
    },
    async get(ctx, id) { return draft(await read(ctx, id), ctx); },
    async save(ctx, input: MailDraftContent & { id?: string }) {
      if (input.id) await read(ctx, input.id);
      if(input.bodyFormat==='plaintext'){const{html:_,...plain}=input;input=plain;}
      const data = { ...(input.cc?{ccRecipients:input.cc.map(emailAddress=>({emailAddress}))}:{}),...(input.bcc?{bccRecipients:input.bcc.map(emailAddress=>({emailAddress}))}:{}),subject: input.subject, body: { contentType: input.html ? 'HTML' : 'Text', content: input.html ?? input.text }, toRecipients: input.to.map((emailAddress) => ({ emailAddress })), ...(input.replyTo ? { replyTo: [{ emailAddress: input.replyTo }] } : {}) };
      const message = await request(ctx, input.id ? 'PATCH' : 'POST', input.id ? `/me/messages/${encodeURIComponent(input.id)}` : '/me/messages', data) as unknown as Message;
      return draft(message, ctx);
    },
    async delete(ctx, id) { await read(ctx, id); await request(ctx, 'DELETE', `/me/messages/${encodeURIComponent(id)}`); },
  };
}
