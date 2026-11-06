import type { ProviderContext } from '@splitin/outreach-contracts';
import type { SessionOptions } from './session';
import { accountChannel, PLATFORM_ORIGINS } from './platforms';

export interface AccountBinding extends SessionOptions {
  readonly kind?: 'linkedin' | 'x' | 'instagram' | 'tiktok' | 'browser';
  readonly expectedProfileUrl?: string;
  /** Trusted selector identifying the signed-in profile, never a task-supplied selector. */
  readonly identitySelector?: string;
  /** Trusted conversation-header profile link used to verify the approved DM recipient. */
  readonly messageRecipientSelector?: string;
  readonly recipeIdentities?: Readonly<Record<string, { readonly selector: string; readonly attribute?: string; readonly expected: string }>>;
}
export interface RuntimePlacement {
  readonly kind: 'daytona' | 'fixture';
  readonly sandboxId: string;
}
export function assertPlacement(runtime: RuntimePlacement, origin: string): void {
  if (runtime.kind === 'fixture') {
    if (process.env.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) {
      throw new Error('Fixture runtime requires NODE_ENV=test and a loopback origin');
    }
    return;
  }
  if (process.platform !== 'linux' || !runtime.sandboxId || process.env.DAYTONA_SANDBOX_ID !== runtime.sandboxId) {
    throw new Error('Social execution requires Linux and a matching DAYTONA_SANDBOX_ID attestation');
  }
  if (!Object.values(PLATFORM_ORIGINS).includes(origin)) throw new Error('Production social origin must be a supported platform');
}
export function accountBinding(bindings: Readonly<Record<string, AccountBinding>>, ctx: ProviderContext): AccountBinding {
  const binding = bindings[ctx.account.externalAccountId];
  if (!binding) throw new Error('No browser profile binding for this external account');
  if (binding.kind === 'browser') {
    if (!binding.recipeIdentities || !Object.keys(binding.recipeIdentities).length) throw new Error('Browser account requires configured recipe identities');
    return binding;
  }
  try { accountChannel(binding); } catch { throw new Error('Expected sender must be a canonical supported social profile URL'); }
  return binding;
}
export function canonicalProfile(url: string): string {
  const parsed = new URL(url, 'https://www.linkedin.com');
  return `${parsed.origin}${parsed.pathname.toLowerCase().replace(/\/+$/, '')}`;
}
