import { z } from 'zod';
const identifier = z.string().trim().min(1).max(120);
const text = z.string().max(100_000);
const https = z.string().url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; }, 'Expected credential-free HTTPS');
export const WorkChannel = z.enum(['linkedin','instagram','x','tiktok','email']);
const media = z.object({ id: identifier, name: z.string().min(1).max(200).refine(n => !n.includes('/') && !n.includes(String.fromCharCode(92)) && [...n].every(c=>c.charCodeAt(0)>=32)), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const contact = z.object({ id: identifier, name: z.string().min(1).max(300), email: z.string().email().optional(), linkedin: https.optional(), instagram: https.optional(), sources: z.array(https).max(50).default([]), notes: z.string().max(10_000).default(''), consentBasis: z.enum(['consent','legitimate_interest','existing_relationship','unknown']).default('unknown'), jurisdiction: z.string().max(20).default('unknown') }).strict();
const post = z.object({ id: identifier, accountRef: identifier, channel: z.enum(['linkedin','x','instagram','tiktok']), text, media: z.array(identifier).max(20).default([]), scheduledFor: z.string().datetime({offset:true}), format: z.enum(['feed','carousel','video','reel']).default('feed'), firstComment: z.string().max(3000).optional(), tags: z.array(identifier).max(20).default([]) }).strict();
const step = z.object({ id: identifier, accountRef: identifier, channel: z.enum(['linkedin','instagram','email']), kind: z.enum(['message','connect','email']), text, subject: z.string().max(1000).optional(), waitHours: z.number().min(0).max(2160).default(0), waitFor: z.enum(['elapsed','connected']).default('elapsed') }).strict();
const sequence = z.object({ id: identifier, name: z.string().max(200), contacts: z.array(identifier).min(1).max(1000), scheduledFor: z.string().datetime({offset:true}), steps: z.array(step).min(1).max(20) }).strict();
const reply = z.object({ id: identifier, accountRef: identifier, channel: z.enum(['linkedin','instagram','email']), contains: z.string().min(2).max(300), text: z.string().min(1).max(10_000), subject: z.string().max(1000).optional(), validUntil: z.string().datetime({offset:true}), maxResponsesPerContact: z.number().int().min(1).max(3).default(1), minGapHours: z.number().min(24).max(2160).default(24) }).strict();
export const WorkPackageManifest = z.object({ schemaVersion: z.literal(1), packageId: identifier, revision: z.number().int().min(1).max(1_000_000), name: z.string().trim().min(1).max(200), timezone: z.string().min(1).max(100).default('America/New_York'), accountRefs: z.array(z.object({ id: identifier, channel: WorkChannel, label: z.string().min(1).max(200) }).strict()).max(100).default([]), contacts: z.array(contact).max(10_000).default([]), media: z.array(media).max(1000).default([]), publishingPlans: z.array(post).max(1000).default([]), outreachSequences: z.array(sequence).max(100).default([]), replyPlaybooks: z.array(reply).max(100).default([]) }).strict().superRefine((v,ctx) => {
  try { new Intl.DateTimeFormat('en',{timeZone:v.timezone}).format(); } catch { ctx.addIssue({code:'custom',message:'Invalid timezone',path:['timezone']}); }
  for(const key of ['accountRefs','contacts','media','publishingPlans','outreachSequences','replyPlaybooks'] as const) {
    const ids=v[key].map(x=>x.id); if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Duplicate identifiers',path:[key]});
  }
});
export type WorkManifest = z.infer<typeof WorkPackageManifest>;
export interface WorkPackageIssue { field: string; message: string }
