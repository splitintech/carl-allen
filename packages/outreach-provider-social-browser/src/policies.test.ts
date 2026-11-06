import { describe, expect, it } from 'vitest';
import { digestCanonical, type BrowserTaskInput, type ProviderContext } from '@splitin/outreach-contracts';
import { runBrowserRecipe, type BrowserRecipe } from './recipes';
import { assertPlacement, accountBinding } from './runtime';
import type { SocialSession } from './session';
import { loadImages } from './media';
import { preEffectFailure, invitationReceiptId } from './linkedin';
const ctx: ProviderContext = { workspaceId: 'ws', account: { id: 'a', provider: 'social-browser', externalAccountId: 'operator', sender: { name: 'Ops', address: 'ops@example.com' } }, secretRef: 'env:X', secrets: { get: async () => '' }, traceId: 't', signal: new AbortController().signal, now: () => 123 };
const session: SocialSession = { withPage: async () => { throw new Error('Browser must not open for invalid requests'); }, close: async () => undefined };
const binding = { expectedProfileUrl: 'https://www.linkedin.com/in/operator', recipeIdentities: { safe: { selector: '#identity', expected: 'operator' } } };
const recipe: BrowserRecipe = { id: 'safe', allowedOrigins: ['https://example.com'], parameters: { text: { maxLength: 100 } }, steps: [{ type: 'goto', url: 'https://example.com/compose' }, { type: 'fill', selector: '#text', parameter: 'text' }, { type: 'click', selector: '#send', effect: true }], confirmation: { selector: '#receipt', attribute: 'data-id' } };
const input = (definition: BrowserRecipe, overrides: Partial<BrowserTaskInput> = {}): BrowserTaskInput => ({ actionId: 'a', idempotencyKey: 'k', recipeId: definition.id, recipeHash: digestCanonical(definition), input: { text: 'approved' }, ...overrides });

describe('runtime and trusted recipe boundaries', () => {
  it('requires an invitation identifier rather than accepting a profile identifier as send evidence', () => {
    expect(invitationReceiptId({ entityUrn: 'urn:li:fsd_profile:recipient' })).toBeUndefined();
    expect(invitationReceiptId({ profile: { entityUrn: 'urn:li:fsd_profile:recipient' }, value: { entityUrn: 'urn:li:invitation:confirmed' } })).toBe('urn:li:invitation:confirmed');
  });
  it('allows recipe-only account identity without requiring an unrelated LinkedIn session', () => {
    expect(accountBinding({ operator: { kind: 'browser', recipeIdentities: { safe: { selector: '#identity', expected: 'operator' } } } }, ctx).kind).toBe('browser');
    expect(() => accountBinding({ operator: { kind: 'browser' } }, ctx)).toThrow(/recipe identities/);
  });
  it('routes a non-messageable target to review instead of repeatedly requesting login', () => {
    expect(preEffectFailure(new Error('locator.click: Timeout 15000ms waiting for Message'), true, false, 'https://www.linkedin.com/in/recipient'))
      .toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    expect(preEffectFailure(new Error('An invitation is already pending; no new invitation attempted'), true, false))
      .toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
  });
  it('keeps authentication loss and disconnection resumable before any effect', () => {
    for (const [error, url] of [
      [new Error('Target page, context or browser has been closed'), 'https://www.linkedin.com/in/recipient'],
      [new Error('locator timeout'), 'https://www.linkedin.com/checkpoint/challenge'],
    ] as const) expect(preEffectFailure(error, true, false, url)).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
    expect(preEffectFailure(new Error('cancelled'), true, true)).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
    expect(preEffectFailure(new Error('identity missing'), false, false)).toMatchObject({ kind: 'rejected', errorClass: 'auth_expired' });
  });
  it('rejects an unverified runtime before capability discovery can claim Daytona', () => {
    expect(() => assertPlacement({ kind: 'daytona', sandboxId: 'unattested' }, 'https://www.linkedin.com')).toThrow(/DAYTONA|Linux/);
    expect(() => assertPlacement({ kind: 'fixture', sandboxId: 'fixture' }, 'https://www.linkedin.com')).toThrow(/loopback/);
  });
  it('requires an exact configured account and canonical expected sender', () => {
    expect(() => accountBinding({}, ctx)).toThrow(/binding/);
    expect(() => accountBinding({ operator: { expectedProfileUrl: 'https://evil.example/in/operator' } }, ctx)).toThrow(/canonical/);
  });
  it('invalidates an approved task when the trusted recipe definition changes', async () => {
    expect(await runBrowserRecipe(session, ctx, binding, recipe, input(recipe, { recipeHash: 'old-approved-hash' }))).toMatchObject({ kind: 'rejected', errorClass: 'unsupported', detail: expect.stringMatching(/new approval/) });
  });
  it('rejects task-supplied URLs, selectors and code as undeclared parameters', async () => {
    expect(await runBrowserRecipe(session, ctx, binding, recipe, input(recipe, { input: { text: 'ok', url: 'https://evil.example', script: 'sendAll()' } }))).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
  });
  it('rejects cross-origin navigation in a configured step', async () => {
    const changed: BrowserRecipe = { ...recipe, steps: [{ type: 'goto', url: 'https://evil.example' }, ...recipe.steps.slice(1)] };
    expect(await runBrowserRecipe(session, ctx, binding, changed, input(changed))).toMatchObject({ kind: 'rejected', errorClass: 'unsupported', detail: expect.stringMatching(/origin/) });
  });
  it('rejects any step after the declared effect and multiple effects', async () => {
    const changed: BrowserRecipe = { ...recipe, steps: [...recipe.steps, { type: 'click', selector: '#another-effect', effect: true }] };
    expect(await runBrowserRecipe(session, ctx, binding, changed, input(changed))).toMatchObject({ kind: 'rejected', errorClass: 'unsupported' });
    const after: BrowserRecipe = { ...recipe, steps: [...recipe.steps, { type: 'goto', url: 'https://example.com/other' }] };
    expect(await runBrowserRecipe(session, ctx, binding, after, input(after))).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/final/) });
  });
  it('requires a configured signed-in identity for every recipe/account', async () => {
    expect(await runBrowserRecipe(session, ctx, { expectedProfileUrl: binding.expectedProfileUrl }, recipe, input(recipe))).toMatchObject({ kind: 'rejected', detail: expect.stringMatching(/identity binding/) });
  });
  it('rejects media URLs outside configured HTTPS origins before fetching', async () => {
    await expect(loadImages(ctx, ['http://127.0.0.1/private'], { allowedOrigins: ['https://images.example'] })).rejects.toThrow(/origin/);
    await expect(loadImages(ctx, ['https://user:pass@images.example/file.png'], { allowedOrigins: ['https://images.example'] })).rejects.toThrow(/origin/);
    await expect(loadImages(ctx, ['https://images.example/file.png'])).rejects.toThrow(/configured/);
  });
});
