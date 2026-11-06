import { digestCanonical } from '@splitin/outreach-contracts';
import type { BrowserTaskInput, ProviderContext, SendResult, SocialHealth } from '@splitin/outreach-contracts';
import type { AccountBinding } from './runtime';
import type { SocialSession } from './session';

export type RecipeStep =
  | { readonly type: 'goto'; readonly url: string }
  | { readonly type: 'fill'; readonly selector: string; readonly parameter: string }
  | { readonly type: 'click'; readonly selector: string; readonly effect?: boolean };
export interface BrowserRecipe {
  readonly id: string;
  readonly allowedOrigins: readonly string[];
  readonly parameters: Readonly<Record<string, { readonly maxLength: number; readonly pattern?: string }>>;
  readonly steps: readonly RecipeStep[];
  readonly confirmation: { readonly selector: string; readonly attribute: string };
}
function validateDefinition(recipe: BrowserRecipe): void {
  if (!recipe.allowedOrigins.length || recipe.steps[0]?.type !== 'goto') throw new Error('Recipe must start with trusted navigation');
  if (recipe.steps.filter((step) => step.type === 'click' && step.effect).length !== 1) throw new Error('Recipe must declare exactly one effect boundary');
  for (const origin of recipe.allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Recipe origins require HTTPS');
  }
  const boundaryIndex = recipe.steps.findIndex((step) => step.type === 'click' && step.effect);
  if (boundaryIndex !== recipe.steps.length - 1) throw new Error('Effect click must be the final recipe step');
  for (const step of recipe.steps) {
    if (step.type === 'goto' && !recipe.allowedOrigins.includes(new URL(step.url).origin)) throw new Error('Recipe navigation origin is not allowed');
    if (step.type === 'fill' && !recipe.parameters[step.parameter]) throw new Error('Recipe references an undeclared parameter');
  }
}
function validated(recipe: BrowserRecipe, input: BrowserTaskInput): Record<string, string> {
  if (input.recipeHash !== digestCanonical(recipe)) throw new Error('Trusted recipe definition changed; new approval is required');
  validateDefinition(recipe);
  const values: Record<string, string> = {};
  for (const key of Object.keys(input.input)) if (!recipe.parameters[key]) throw new Error(`Unknown recipe parameter ${key}`);
  for (const [key, rule] of Object.entries(recipe.parameters)) {
    const value = input.input[key];
    if (typeof value !== 'string' || value.length > rule.maxLength || (rule.pattern && !new RegExp(rule.pattern).test(value))) throw new Error(`Invalid recipe parameter ${key}`);
    values[key] = value;
  }
  return values;
}
/** Read-only account check: navigation and identity verification only, never recipe clicks/fills. */
export async function browserRecipeHealth(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, recipes: readonly BrowserRecipe[]): Promise<SocialHealth> {
  try {
    if (!recipes.length) throw new Error('Browser account has no configured usable recipe');
    for (const recipe of recipes) {
      validateDefinition(recipe);
      const identity = binding.recipeIdentities?.[recipe.id];
      const first = recipe.steps[0];
      if (!identity || !first || first.type !== 'goto') throw new Error('Browser recipe identity is not configured');
      await session.withPage(ctx.signal, async (page) => {
        let blocked = false;
        await page.route('**/*', async (route) => {
          if (!recipe.allowedOrigins.includes(new URL(route.request().url()).origin)) { blocked = true; await route.abort('blockedbyclient'); }
          else await route.continue();
        });
        await page.goto(first.url, { waitUntil: 'domcontentloaded' });
        if (blocked || !recipe.allowedOrigins.includes(new URL(page.url()).origin)) throw new Error('Browser recipe left its trusted origins');
        const marker = page.locator(identity.selector).first();
        const actual = identity.attribute ? await marker.getAttribute(identity.attribute) : await marker.textContent();
        if (actual?.trim() !== identity.expected) throw new Error('Signed-in browser account identity mismatch');
      });
    }
    return { status: 'ok', reconnectNeeded: false };
  } catch (error) {
    return { status: 'reauth_required', reconnectNeeded: true, detail: `needs_reauth: ${(error as Error).message}`.slice(0, 300) };
  }
}
/** Trusted configuration supplies all selectors, URLs and confirmation rules. Task input supplies text only. */
export async function runBrowserRecipe(session: SocialSession, ctx: ProviderContext, binding: AccountBinding, recipe: BrowserRecipe, input: BrowserTaskInput): Promise<SendResult> {
  let values: Record<string, string>;
  const identity = binding.recipeIdentities?.[recipe.id];
  try {
    values = validated(recipe, input);
    if (!identity) throw new Error('Recipe has no signed-in account identity binding');
  } catch (error) { return { kind: 'rejected', errorClass: 'unsupported', detail: (error as Error).message }; }
  let crossed = false;
  let blockedNavigation = false;
  try {
    return await session.withPage(ctx.signal, async (page) => {
      await page.route('**/*', async (route) => {
        if (!recipe.allowedOrigins.includes(new URL(route.request().url()).origin)) {
          blockedNavigation = true;
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      const first = recipe.steps[0];
      if (!first || first.type !== 'goto') throw new Error('Missing initial navigation');
      await page.goto(first.url, { waitUntil: 'domcontentloaded' });
      const marker = page.locator(identity.selector).first();
      const actual = identity.attribute ? await marker.getAttribute(identity.attribute) : await marker.textContent();
      if (actual?.trim() !== identity.expected) throw new Error('Signed-in recipe account identity mismatch');
      const confirmation = page.locator(recipe.confirmation.selector).first();
      const before = await confirmation.count() ? await confirmation.getAttribute(recipe.confirmation.attribute) : null;
      for (const step of recipe.steps.slice(1)) {
        ctx.signal.throwIfAborted();
        if (blockedNavigation) throw new Error('Recipe navigation left its trusted origins');
        if (step.type === 'goto') await page.goto(step.url, { waitUntil: 'domcontentloaded' });
        if (step.type === 'fill') await page.locator(step.selector).fill(values[step.parameter]!);
        if (step.type === 'click') {
          if (step.effect) crossed = true;
          await page.locator(step.selector).click();
        }
      }
      if (blockedNavigation || !recipe.allowedOrigins.includes(new URL(page.url()).origin)) throw new Error('Recipe left its trusted origins');
      await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
      const id = await confirmation.getAttribute(recipe.confirmation.attribute);
      if (!id || id === before) throw new Error('Recipe did not produce a new platform receipt');
      return { kind: 'accepted', receipt: { providerMessageId: id, acceptedAt: ctx.now() } };
    });
  } catch (error) {
    const detail = (error as Error).message.slice(0, 300);
    return crossed ? { kind: 'unknown', detail } : { kind: 'rejected', errorClass: 'auth_expired', detail };
  }
}
