import { it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve('apps/papr/bundle/apps/outreach-console/publishing');
interface Model {
  draftStatus(draft: { actionIds: string[]; status: string }, actions: { id: string; state: string }[]): string;
  zonedISO(value: string, zone: string): string;
  validatePost(post: { channel: string; text: string; mediaIds: string[] }, media: { id: string; mime: string }[], accounts: unknown[]): string[];
}
const model = await import(pathToFileURL(resolve(root, 'model.js')).href) as Model;
const identity = await import(pathToFileURL(resolve(root, 'identity.js')).href) as { canonicalProfile(channel: string, value: string): string };
it('shows actual delivery state for saved plans and distinguishes incomplete mixed deliveries', () => {
  const plan = { actionIds: ['a', 'b'], status: 'queued' };
  expect(model.draftStatus(plan, [{ id: 'a', state: 'scheduled' }, { id: 'b', state: 'scheduled' }])).toBe('scheduled');
  expect(model.draftStatus(plan, [{ id: 'a', state: 'succeeded' }, { id: 'b', state: 'succeeded' }])).toBe('succeeded');
  expect(model.draftStatus(plan, [{ id: 'a', state: 'succeeded' }, { id: 'b', state: 'uncertain' }])).toBe('review');
  expect(model.draftStatus(plan, [{ id: 'a', state: 'cancelled' }, { id: 'b', state: 'cancelled' }])).toBe('cancelled');
});
it('keeps selected time-zone intent and refuses a nonexistent daylight-saving time', () => {
  expect(model.zonedISO('2026-11-10T09:30', 'America/New_York')).toBe('2026-11-10T14:30:00.000Z');
  expect(model.zonedISO('2026-11-10T09:30', 'Asia/Kolkata')).toBe('2026-11-10T04:00:00.000Z');
  expect(() => model.zonedISO('2026-03-08T02:30', 'America/New_York')).toThrow('does not exist');
  expect(() => model.zonedISO('2026-02-31T10:00', 'UTC')).toThrow();
});
it('canonicalizes only the provider selected by the user and blocks endpoint/profile ambiguity', () => {
  expect(identity.canonicalProfile('x', 'https://www.x.com/Owner')).toBe('https://x.com/owner/');
  expect(identity.canonicalProfile('instagram', 'https://instagram.com/Owner.Name')).toBe('https://www.instagram.com/owner.name/');
  expect(() => identity.canonicalProfile('x', 'https://www.linkedin.com/in/owner/')).toThrow('own X profile');
  expect(() => identity.canonicalProfile('x', 'https://x.com/messages')).toThrow();
  expect(() => identity.canonicalProfile('instagram', 'https://instagram.com/owner/?login=1')).toThrow();
});
it('rejects media formats that the current browser publishing workflow cannot submit', () => {
  expect(model.validatePost({ channel: 'instagram', text: 'Caption', mediaIds: ['image'] }, [{ id: 'image', mime: 'image/webp' }], [])).toContain('Convert Instagram images to JPEG or PNG before publishing.');
  expect(model.validatePost({ channel: 'tiktok', text: '', mediaIds: ['video'] }, [{ id: 'video', mime: 'video/webm' }], [])).toContain('Convert videos to MP4 before publishing.');
});
