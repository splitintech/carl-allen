/**
 * Provider purposes and capabilities (BUILD_PLAN.md §5.1).
 * A campaign may run only if its purpose is permitted by BOTH the adapter (the provider's terms)
 * and the account (what the operator attests their contract allows).
 */
export const PROVIDER_PURPOSES = [
  'manual_correspondence',
  'transactional',
  'automated_outreach',
  'marketing',
  'bulk',
  /** Calendar posts via a capability-gated social browser (ADR 0006). */
  'social_publishing',
  /** Outreach DMs / connection notes via a capability-gated social browser (ADR 0006). */
  'social_messaging',
] as const;

export type ProviderPurpose = (typeof PROVIDER_PURPOSES)[number];

/** Where social browser actions may run. Only `daytona-browser` is allowed for automation. */
export const EXECUTION_PLACEMENTS = ['daytona-browser'] as const;
export type ExecutionPlacement = (typeof EXECUTION_PLACEMENTS)[number];

export interface CapabilitySnapshot {
  /** Native composer observations for this exact publishing target, not generic platform support. */
  readonly requiresPublishingQualification?: boolean;
  readonly publishingQualification?: PublishingQualification;
  readonly provider: string;
  readonly send: boolean;
  readonly replyInThread: boolean;
  /** Whether we can set Message-ID and List-Unsubscribe headers. */
  readonly customHeaders: boolean;
  /** Whether the provider deduplicates on our idempotency key. */
  readonly externalIdempotency: boolean;
  readonly inboundWebhook: boolean;
  readonly mailboxPolling: boolean;
  readonly reconcileBySentSearch: boolean;
  readonly maxRecipientsPerMessage: number;
  readonly discoveredAt: number;
  /** Social calendar posts (ADR 0006). Absent means unsupported. */
  readonly socialPublish?: boolean;
  /** Social DMs / connection notes (ADR 0006). Absent means unsupported. */
  readonly socialMessage?: boolean;
  readonly socialConnect?: boolean;
  readonly socialMediaTypes?: readonly ('image' | 'video')[];
  readonly socialChannels?: readonly string[];
  readonly browserTasks?: boolean;
  readonly browserRecipeHashes?: Readonly<Record<string, string>>;
  /** Required `daytona-browser` when any social capability is true (ADR 0006). */
  readonly executionPlacement?: ExecutionPlacement;
}

export interface PublishingQualification {
 readonly identity:string;
 readonly accountType:'personal'|'organization'|'business'|'creator'|'unknown';
 readonly formats:readonly ('feed'|'carousel'|'video'|'reel')[];
 readonly checkedAt:number;
 readonly detail?:string;
}

export function isProviderPurpose(value: unknown): value is ProviderPurpose {
  return typeof value === 'string' && (PROVIDER_PURPOSES as readonly string[]).includes(value);
}

export function purposePermitted(
  purpose: ProviderPurpose,
  adapterPurposes: readonly ProviderPurpose[],
  accountPurposes: readonly ProviderPurpose[],
): boolean {
  return adapterPurposes.includes(purpose) && accountPurposes.includes(purpose);
}
