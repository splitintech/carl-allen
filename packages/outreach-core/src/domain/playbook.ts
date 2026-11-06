import { OUTREACH_API_VERSION, PROVIDER_PURPOSES } from '@splitin/outreach-contracts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { WEEKDAYS, isValidDuration, isValidZone } from './calendar';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
const isoDuration = z.string().refine(isValidDuration, 'expected an ISO-8601 duration such as P3D or PT4H');
const zone = z.string().refine(isValidZone, 'expected an IANA time zone');
const templateRef = z.string().regex(/^[a-z0-9][a-z0-9_.-]*@\d+$/, 'expected name@version');
const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'expected a lowercase step id');
const when = z.enum(['always', 'no_reply']).default('always');

const emailStep = {
  id: stepId,
  template: templateRef,
  providerAccountId: z.string().min(1).optional(),
  approval: z.enum(['inherit', 'always']).default('inherit'),
  when,
};

const socialChannel = z.string().min(1).max(40);
const mediaUrls = z.array(z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'media must use credential-free HTTPS')).max(4);

export const StepSchema = z.discriminatedUnion('type', [
  z.object({ id: stepId, type: z.literal('social.connect'), channel: socialChannel, template: templateRef, providerAccountId: z.string().min(1).optional(), approval: z.enum(['inherit','always']).default('inherit'), when }).strict(),
  z.object({ id: stepId, type: z.literal('browser.task'), recipeId: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()), providerAccountId: z.string().min(1).optional(), approval: z.literal('always').default('always'), when }).strict(),
  z.object({ ...emailStep, type: z.literal('email.send') }).strict(),
  z.object({ ...emailStep, type: z.literal('email.reply') }).strict(),
  z.object({ id: stepId, type: z.literal('wait'), duration: isoDuration, calendar: z.enum(['business', 'calendar']).default('business') }).strict(),
  z.object({ id: stepId, type: z.literal('manual.task'), channel: socialChannel, template: templateRef, when }).strict(),
  z
    .object({
      id: stepId,
      type: z.literal('social.message'),
      providerAccountId: z.string().min(1).optional(),
      channel: socialChannel,
      template: templateRef,
      approval: z.enum(['inherit', 'always']).default('inherit'),
      when,
    })
    .strict(),
  z
    .object({
      id: stepId,
      type: z.literal('social.publish'),
      mediaUrls: mediaUrls.optional(),
      providerAccountId: z.string().min(1).optional(),
      channel: socialChannel,
      template: templateRef,
      approval: z.enum(['inherit', 'always']).default('inherit'),
      when: z.literal('always').default('always'),
    })
    .strict(),
]);

const contentPost = z
  .object({
    id: stepId,
    channel: socialChannel,
    template: templateRef,
    /** ISO-8601 instant; materializer snaps into the policy window when needed. */
    scheduledFor: z.string().datetime({ offset: true }),
    mediaUrls: mediaUrls.optional(),
    providerAccountId: z.string().min(1).optional(),
    approval: z.enum(['inherit', 'always']).default('inherit'),
  })
  .strict();

export const PolicySchema = z
  .object({
    approval: z.enum(['none', 'every_action', 'first_batch_then_campaign']).default('first_batch_then_campaign'),
    firstBatchSize: z.number().int().min(1).max(500).default(20),
    window: z
      .object({
        timezone: z.union([z.literal('recipient'), zone]).default('recipient'),
        fallback: zone.default('America/New_York'),
        days: z.array(z.enum(WEEKDAYS)).min(1).default(['Mon', 'Tue', 'Wed', 'Thu']),
        start: hhmm.default('09:30'),
        end: hhmm.default('16:30'),
        holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
      })
      .strict()
      .refine((w) => w.start < w.end, 'window start must be before end')
      .default({ timezone: 'recipient', fallback: 'America/New_York', days: ['Mon', 'Tue', 'Wed', 'Thu'], start: '09:30', end: '16:30', holidays: [] }),
    limits: z
      .object({
        accountPerDay: z.number().int().min(1).max(10_000).default(40),
        domainPerDay: z.number().int().min(1).max(1_000).default(3),
        campaignPerDay: z.number().int().min(1).max(10_000).optional(),
        /** Per social channel daily cap (ADR 0006 content calendar / social.message). */
        channelPerDay: z.number().int().min(1).max(500).default(10),
        recipientMinGap: isoDuration.default('P3D'),
      })
      .strict()
      .default({ accountPerDay: 40, domainPerDay: 3, channelPerDay: 10, recipientMinGap: 'P3D' }),
    requirePostalAddress: z.boolean().default(true),
    unsubscribe: z.enum(['link', 'reply']).default('link'),
    expireAfter: isoDuration.default('P14D'),
  })
  .strict();

export const ContentCalendarSchema = z
  .object({
    apiVersion: z.literal(OUTREACH_API_VERSION),
    kind: z.literal('ContentCalendar'),
    metadata: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
    spec: z
      .object({
        purpose: z.literal('social_publishing'),
        policy: PolicySchema.default(PolicySchema.parse({})),
        posts: z.array(contentPost).min(1).max(500),
      })
      .strict(),
  })
  .strict();

export const AudienceSchema = z
  .object({
    source: z
      .union([
        z.literal('all'),
        z.object({ importBatch: z.string().min(1) }).strict(),
        z.object({ contactIds: z.array(z.string().min(1)).min(1).max(100_000) }).strict(),
      ])
      .default('all'),
    require: z.array(z.enum(['email','social_profile'])).default(['email']),
    eligibility: z.array(z.enum(['consent_or_legitimate_interest', 'any'])).default(['consent_or_legitimate_interest']),
  })
  .strict();

export const PlaybookSchema = z
  .object({
    apiVersion: z.literal(OUTREACH_API_VERSION),
    kind: z.literal('Playbook'),
    metadata: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict(),
    spec: z
      .object({
        purpose: z.enum(PROVIDER_PURPOSES),
        audience: AudienceSchema.default({ source: 'all', require: ['email'], eligibility: ['consent_or_legitimate_interest'] }),
        policy: PolicySchema.default(PolicySchema.parse({})),
        steps: z.array(StepSchema).min(1).max(50),
      })
      .strict(),
  })
  .strict();

export type Playbook = z.infer<typeof PlaybookSchema>;
export type ContentCalendar = z.infer<typeof ContentCalendarSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type Audience = z.infer<typeof AudienceSchema>;
export type ContentPost = z.infer<typeof contentPost>;

export class PlaybookError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid playbook:\n- ${issues.join('\n- ')}`);
    this.name = 'PlaybookError';
  }
}

function formatZod(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** Parses YAML or an object into a validated playbook. Structural checks only; see compile for semantic ones. */
export function parsePlaybook(input: string | unknown): Playbook {
  const raw = typeof input === 'string' ? (parseYaml(input) as unknown) : input;
  const result = PlaybookSchema.safeParse(raw);
  if (!result.success) throw new PlaybookError(formatZod(result.error.issues));
  return result.data;
}

/** Parses a Buffer-style content calendar (ADR 0006). */
export function parseContentCalendar(input: string | unknown): ContentCalendar {
  const raw = typeof input === 'string' ? (parseYaml(input) as unknown) : input;
  const result = ContentCalendarSchema.safeParse(raw);
  if (!result.success) throw new PlaybookError(formatZod(result.error.issues));
  return result.data;
}
