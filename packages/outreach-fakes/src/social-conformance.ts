/**
 * Social browser port conformance (ADR 0006). Framework-agnostic: each case throws on failure.
 */
import { ulid, type ProviderContext, type SocialBrowserPort } from '@splitin/outreach-contracts';
import type { FakeSocialMode } from './fake-social';

export interface SocialConformanceHarness {
  readonly social: SocialBrowserPort;
  readonly ctx: ProviderContext;
  readonly secretValue: string;
  readonly channel: string;
  readonly targetUrl: string;
  readonly force?: (mode: FakeSocialMode) => void;
}

export interface SocialConformanceCase {
  readonly name: string;
  readonly needsForce: boolean;
  run(harness: SocialConformanceHarness): Promise<void>;
}

export class SocialConformanceFailure extends Error {
  constructor(caseName: string, message: string) {
    super(`[${caseName}] ${message}`);
    this.name = 'SocialConformanceFailure';
  }
}

function assert(condition: unknown, caseName: string, message: string): asserts condition {
  if (!condition) throw new SocialConformanceFailure(caseName, message);
}

function assertNoSecret(value: unknown, harness: SocialConformanceHarness, caseName: string): void {
  const serialized = JSON.stringify(value) ?? '';
  assert(!serialized.includes(harness.secretValue), caseName, 'result leaks the credential');
}

export const SOCIAL_BROWSER_CONFORMANCE: readonly SocialConformanceCase[] = [
  {
    name: 'publish returns stable provider ids and no secrets',
    needsForce: false,
    async run(h) {
      const id = ulid();
      const result = await h.social.publish(h.ctx, {
        actionId: `conf-${id}`,
        idempotencyKey: `conf:pub:${id}`,
        channel: h.channel,
        text: `Conformance publish ${id}`,
      });
      assert(result.kind === 'accepted', this.name, `expected accepted, got ${result.kind}`);
      if (result.kind === 'accepted') {
        assert(result.receipt.providerMessageId.length > 0, this.name, 'empty providerMessageId');
      }
      assertNoSecret(result, h, this.name);
    },
  },
  {
    name: 'message returns stable provider ids and no secrets',
    needsForce: false,
    async run(h) {
      const id = ulid();
      const result = await h.social.message(h.ctx, {
        actionId: `conf-${id}`,
        idempotencyKey: `conf:msg:${id}`,
        channel: h.channel,
        targetUrl: h.targetUrl,
        text: `Conformance message ${id}`,
      });
      assert(result.kind === 'accepted', this.name, `expected accepted, got ${result.kind}`);
      assertNoSecret(result, h, this.name);
    },
  },
  {
    name: 'health reports reconnectNeeded when forced',
    needsForce: true,
    async run(h) {
      h.force!({ kind: 'reconnect' });
      const id = ulid();
      const result = await h.social.publish(h.ctx, {
        actionId: `conf-${id}`,
        idempotencyKey: `conf:reauth:${id}`,
        channel: h.channel,
        text: 'should fail',
      });
      assert(result.kind === 'rejected', this.name, `expected rejected, got ${result.kind}`);
      const health = await h.social.health(h.ctx);
      assert(health.reconnectNeeded, this.name, 'expected reconnectNeeded');
      assertNoSecret(result, h, this.name);
    },
  },
];

export async function runSocialBrowserConformance(
  harness: () => SocialConformanceHarness,
): Promise<string[]> {
  const skipped: string[] = [];
  for (const testCase of SOCIAL_BROWSER_CONFORMANCE) {
    const h = harness();
    if (testCase.needsForce && !h.force) {
      skipped.push(testCase.name);
      continue;
    }
    await testCase.run(h);
  }
  return skipped;
}
