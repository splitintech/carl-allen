import { z } from 'zod';
export const PUBLISHING_CHANNELS = ['linkedin', 'x', 'instagram', 'tiktok'] as const;
export const PUBLISHING_LIMITS = {
  chunkBytes: 65_536, imageBytes: 5 * 1024 * 1024, videoBytes: 100 * 1024 * 1024,
  workspaceBytes: 500 * 1024 * 1024, supportedVideoMimes: ['video/mp4'],
  platforms: {
    linkedin: { text: 3000, images: 4, videos: 1, mediaRequired: false },
    x: { text: 280, images: 4, videos: 1, mediaRequired: false },
    instagram: { text: 2200, images: 10, videos: 1, mediaRequired: true },
    tiktok: { text: 2200, images: 0, videos: 1, mediaRequired: true },
  },
} as const;
export const PublishingDraftInput = z.object({
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  name: z.string().trim().min(1).max(200), timezone: z.string().min(1).max(100),
  scheduledFor: z.string().datetime({ offset: true }),
  posts: z.array(z.object({ channel: z.enum(PUBLISHING_CHANNELS), accountId: z.string().min(1).optional(), text: z.string().max(100_000), mediaIds: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).max(10) }).strict()).min(1).max(4),
}).strict();
export type PublishingDraftInput = z.infer<typeof PublishingDraftInput>;
export interface PublishingAsset { id: string; name: string; mime: string; size: number; sha256: string; mediaUrl: string; createdAt: number }
export interface PublishingDraft extends Omit<PublishingDraftInput, 'id'> { id: string; revision: number; status: string; actionIds: string[]; blocked: { channel: string; reason: string }[]; createdAt: number; updatedAt: number }
export interface MediaRow { id: string; workspace_id: string; name: string; mime: string; size: number; sha256: string; created_at: number }
export function assetView(row: MediaRow): PublishingAsset { return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, mediaUrl: `outreach-media://${row.sha256}`, createdAt: row.created_at }; }
