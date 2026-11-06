import type {
  AccountHealth,
  CapabilitySnapshot,
  ErrorClass,
  ProviderAdapter,
  ProviderContext,
  ProviderPurpose,
  SendResult,
  SocialHealth,
  SocialMessageInput,
  SocialPublishInput,
} from '@splitin/outreach-contracts';

export type FakeSocialMode =
  | { kind: 'accept' }
  | { kind: 'reject'; errorClass: ErrorClass; retryAfterMs?: number }
  | { kind: 'unknown' }
  | { kind: 'reconnect' };

export interface FakeSocialDelivery {
  readonly kind: 'publish' | 'message' | 'connect' | 'browser';
  readonly providerMessageId: string;
  readonly actionId: string;
  readonly channel: string;
  readonly text: string;
  readonly targetUrl?: string;
  readonly mediaUrls?: readonly string[];
  readonly at: number;
}

export interface FakeSocialOptions {
  readonly name?: string;
  readonly purposes?: readonly ProviderPurpose[];
  readonly secret?: string;
  readonly channel?: string;
}

export const FAKE_SOCIAL_SECRET = 'fake-social-secret-value';

/** Deterministic social browser provider for tests (ADR 0006). */
export class FakeSocialProvider {
  readonly name: string;
  readonly deliveries: FakeSocialDelivery[] = [];
  publishCalls = 0;
  messageCalls = 0;
  healthStatus: AccountHealth = 'ok';
  reconnectNeeded = false;
  private readonly queue: FakeSocialMode[] = [];
  private defaultMode: FakeSocialMode = { kind: 'accept' };
  private readonly purposes: readonly ProviderPurpose[];
  private readonly secret: string;
  private readonly channel: string;
  private counter = 0;

  constructor(options: FakeSocialOptions = {}) {
    this.name = options.name ?? 'fake-social';
    this.purposes = options.purposes ?? ['social_publishing', 'social_messaging'];
    this.secret = options.secret ?? FAKE_SOCIAL_SECRET;
    this.channel = options.channel ?? 'linkedin';
  }

  script(...modes: FakeSocialMode[]): this {
    this.queue.push(...modes);
    return this;
  }

  setDefault(mode: FakeSocialMode): this {
    this.defaultMode = mode;
    return this;
  }

  adapter(): ProviderAdapter {
    return {
      name: this.name,
      purposes: this.purposes,
      account: {
        discover: async (ctx) => this.capabilities(ctx.now()),
        health: async () => ({ status: this.healthStatus, detail: this.reconnectNeeded ? 'reconnect_needed' : undefined }),
      },
      browser: { run: async (ctx,input) => { const blocked=await this.gate(ctx);return blocked??this.apply(this.nextMode(),{kind:'browser',actionId:input.actionId,channel:'browser',text:JSON.stringify({recipeId:input.recipeId,input:input.input})},ctx.now()); } },
      social: {
        publish: (ctx, input) => this.publish(ctx, input),
        message: (ctx, input) => this.message(ctx, input),
        connect: async (ctx, input) => { const blocked=await this.gate(ctx);return blocked??this.apply(this.nextMode(),{kind:'connect',actionId:input.actionId,channel:input.channel,text:input.text??'',targetUrl:input.targetUrl},ctx.now()); },
        health: async () => this.socialHealth(),
      },
    };
  }

  capabilities(now: number): CapabilitySnapshot {
    return {
      provider: this.name,
      send: false,
      replyInThread: false,
      customHeaders: false,
      externalIdempotency: false,
      inboundWebhook: false,
      mailboxPolling: false,
      reconcileBySentSearch: false,
      maxRecipientsPerMessage: 1,
      discoveredAt: now,
      socialPublish: true,
      socialMessage: true,
      socialConnect: true,
      socialChannels: [this.channel],
      browserTasks: true,
      browserRecipeHashes: {'save-draft':'a'.repeat(64)},
      executionPlacement: 'daytona-browser',
    };
  }

  socialHealth(): SocialHealth {
    return {
      status: this.reconnectNeeded ? 'reauth_required' : this.healthStatus,
      reconnectNeeded: this.reconnectNeeded || this.healthStatus === 'reauth_required',
      detail: this.reconnectNeeded ? 'needs_reauth' : undefined,
    };
  }

  private async gate(ctx: ProviderContext): Promise<SendResult | null> {
    if (ctx.signal.aborted) return { kind: 'unknown', detail: 'aborted before social action' };
    if ((await ctx.secrets.get(ctx.secretRef)) !== this.secret) {
      return { kind: 'rejected', errorClass: 'auth_revoked', detail: 'credential rejected' };
    }
    if (this.reconnectNeeded || this.healthStatus === 'reauth_required') {
      return { kind: 'rejected', errorClass: 'auth_expired', detail: 'needs_reauth' };
    }
    return null;
  }

  private nextMode(): FakeSocialMode {
    return this.queue.shift() ?? this.defaultMode;
  }

  private async apply(mode: FakeSocialMode, delivery: Omit<FakeSocialDelivery, 'providerMessageId' | 'at'>, now: number): Promise<SendResult> {
    if (mode.kind === 'reconnect') {
      this.reconnectNeeded = true;
      this.healthStatus = 'reauth_required';
      return { kind: 'rejected', errorClass: 'auth_expired', detail: 'needs_reauth' };
    }
    if (mode.kind === 'reject') {
      return { kind: 'rejected', errorClass: mode.errorClass, retryAfterMs: mode.retryAfterMs, detail: mode.errorClass };
    }
    if (mode.kind === 'unknown') return { kind: 'unknown', detail: 'social outcome unknown' };
    this.counter += 1;
    const providerMessageId = `fake-social:${this.channel}:${this.counter}`;
    this.deliveries.push({ ...delivery, providerMessageId, at: now });
    return { kind: 'accepted', receipt: { providerMessageId, acceptedAt: now } };
  }

  private async publish(ctx: ProviderContext, input: SocialPublishInput): Promise<SendResult> {
    this.publishCalls += 1;
    const blocked = await this.gate(ctx);
    if (blocked) return blocked;
    return this.apply(this.nextMode(), { kind: 'publish', actionId: input.actionId, channel: input.channel, text: input.text, ...(input.mediaUrls ? {mediaUrls:input.mediaUrls} : {}) }, ctx.now());
  }

  private async message(ctx: ProviderContext, input: SocialMessageInput): Promise<SendResult> {
    this.messageCalls += 1;
    const blocked = await this.gate(ctx);
    if (blocked) return blocked;
    return this.apply(
      this.nextMode(),
      { kind: 'message', actionId: input.actionId, channel: input.channel, text: input.text, targetUrl: input.targetUrl },
      ctx.now(),
    );
  }
}
