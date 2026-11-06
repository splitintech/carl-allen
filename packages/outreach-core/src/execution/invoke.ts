import type {
  ApprovedEmail,
  EmailContent,
  Notification,
  ProviderAdapter,
  ProviderContext,
  SenderIdentity,
  SendResult,
} from '@splitin/outreach-contracts';
import type { AccountRow, ActionRow, ExecutionDeps } from './types';
import { actionProviderTimeout } from './types';

export type EmailPayload = EmailContent;
export type NotifyPayload = Notification;
export interface ManualPayload {
  readonly channel: string;
  readonly targetUrl?: string;
  readonly draft: string;
}
export interface SocialPublishPayload {
  readonly channel: string;
  readonly text: string;
  readonly mediaUrls?: readonly string[];
}
export interface SocialMessagePayload {
  readonly channel: string;
  readonly targetUrl: string;
  readonly text: string;
}

export function providerContext(
  deps: ExecutionDeps,
  account: AccountRow,
  traceId: string,
  signal: AbortSignal,
): ProviderContext {
  return {
    workspaceId: account.workspace_id,
    account: {
      id: account.id,
      provider: account.provider,
      externalAccountId: account.external_account_id,
      sender: JSON.parse(account.sender_identity) as SenderIdentity,
    },
    secretRef: account.secret_ref,
    secrets: deps.secrets,
    traceId,
    signal,
    now: deps.now,
  };
}

export function toApprovedEmail(action: ActionRow): ApprovedEmail {
  const payload = JSON.parse(action.payload) as EmailPayload;
  return {
    ...payload,
    actionId: action.id,
    idempotencyKey: action.idempotency_key,
    rfcMessageId: action.rfc_message_id ?? `<${action.id}@outreach.invalid>`,
    contentHash: action.content_hash,
  };
}

/**
 * Performs the external effect for an `executing` action. Anything thrown by an adapter is treated as
 * `unknown`: we cannot prove the request never left the process, so it must be reconciled, not retried.
 */
export async function invokeProvider(
  deps: ExecutionDeps,
  action: ActionRow,
  account: AccountRow | null,
  adapter: ProviderAdapter | null,
  traceId: string,
): Promise<SendResult> {
  if (action.kind === 'manual.task') {
    return { kind: 'accepted', receipt: { providerMessageId: `manual:${action.id}`, acceptedAt: deps.now() } };
  }
  if (!account || !adapter) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no adapter' };
  const signal = AbortSignal.timeout(actionProviderTimeout(deps, action));
  const ctx = providerContext(deps, account, traceId, signal);
  try {
    if (action.kind === 'notify.publish') {
      if (!adapter.notify) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no notify port' };
      const payload = JSON.parse(action.payload) as NotifyPayload;
      return await adapter.notify.publish(ctx, { ...payload, idempotencyKey: action.idempotency_key });
    }
    if (action.kind === 'social.publish') {
      if (!adapter.social) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no social port' };
      const payload = JSON.parse(action.payload) as SocialPublishPayload;
      return await adapter.social.publish(ctx, {
        actionId: action.id,
        idempotencyKey: action.idempotency_key,
        channel: payload.channel,
        text: payload.text,
        ...(payload.mediaUrls ? { mediaUrls: payload.mediaUrls } : {}),
      });
    }
    if (action.kind === 'social.connect') {
      if (!adapter.social?.connect) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no social connect port' };
      const payload = JSON.parse(action.payload) as SocialMessagePayload;
      return await adapter.social.connect(ctx, { ...payload, actionId: action.id, idempotencyKey: action.idempotency_key });
    }
    if (action.kind === 'browser.task') {
      if (!adapter.browser) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no browser task port' };
      const payload = JSON.parse(action.payload) as {recipeId:string;recipeHash:string;input:Record<string,unknown>};
      return await adapter.browser.run(ctx, { ...payload, actionId: action.id, idempotencyKey: action.idempotency_key });
    }
    if (action.kind === 'social.message') {
      if (!adapter.social) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no social port' };
      const payload = JSON.parse(action.payload) as SocialMessagePayload;
      return await adapter.social.message(ctx, {
        actionId: action.id,
        idempotencyKey: action.idempotency_key,
        channel: payload.channel,
        targetUrl: payload.targetUrl,
        text: payload.text,
      });
    }
    if (!adapter.email) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no email port' };
    return await adapter.email.send(ctx, toApprovedEmail(action));
  } catch (error) {
    return { kind: 'unknown', detail: `adapter threw: ${(error as Error).message}`.slice(0, 300) };
  }
}
