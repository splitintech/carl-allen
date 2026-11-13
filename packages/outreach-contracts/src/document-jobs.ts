import { z } from 'zod';
import { HtmlImportAction } from './work-package';

const draft = z.object({
  to: z.array(z.string().email()).max(100), cc: z.array(z.string().email()).max(100), bcc: z.array(z.string().email()).max(100),
  subject: z.string().max(1000).optional(), body: z.string().max(20_000).optional(),
}).strict();
const resultBase = { actionId: z.string().min(1).max(120), status: z.enum(['completed', 'failed']), detail: z.string().max(2000).optional() };
export const DocumentTriggerResult = z.discriminatedUnion('kind', [
  z.object({ ...resultBase, kind: z.literal('open_url'), requestedUrl: z.string().url().max(10_000), finalUrl: z.string().url().max(10_000).optional(), title: z.string().max(1000).optional(), httpStatus: z.number().int().min(100).max(599).optional() }).strict(),
  z.object({ ...resultBase, kind: z.literal('compose_email'), draft }).strict(),
]);
export type DocumentTriggerResult = z.infer<typeof DocumentTriggerResult>;
export const DocumentTriggerResultSchema = DocumentTriggerResult;
export interface DocumentJobRunner {
  run(input: { jobId: string; sourceHash: string; html: string; actions: HtmlImportAction[]; signal: AbortSignal }): Promise<{ results: DocumentTriggerResult[] }>;
}
export const DocumentJobStatus = z.enum(['draft', 'paused', 'scheduled', 'running', 'completed', 'needs_attention', 'cancelled']);
export type DocumentJobStatus = z.infer<typeof DocumentJobStatus>;
export const DocumentJobSchema = z.object({
  id: z.string(), packageId: z.string(), sourceHash: z.string(), name: z.string(),
  selectedActionIds: z.array(z.string()), actions: z.array(HtmlImportAction), scheduledFor: z.string().datetime({ offset: true }).nullable(),
  timezone: z.string(), status: DocumentJobStatus, revision: z.number().int().min(1), results: z.array(DocumentTriggerResult),
  detail: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
});
export type DocumentJob = z.infer<typeof DocumentJobSchema>;
