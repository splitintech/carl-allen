import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startPublishingUpload,appendPublishingChunk,completePublishingUpload} from '../domain/publishing-media';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProviderAccount } from '../domain/operations';
import { makeDomainEnv, type DomainTestEnv } from '../domain/domain.test-util';
import { PolicySchema } from '../domain/playbook';
import { scheduleAction } from '../domain/scheduled-management';
import { actionExecuteLease, actionProviderTimeout, resolveConfig, type ActionRow, type ExecutionDeps } from './types';
import { executeDue } from './executor';
import { sweepExpiredLeases } from './recovery';
import { workerActor } from './actions-repo';
describe('bounded media publishing execution', () => {
  let env: DomainTestEnv; let accountId: string;let mediaRef:string;let mediaDir:string;
  const video=execFileSync(process.env.OUTREACH_FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=320x320:r=25:d=3','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-an','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{timeout:30000});
  beforeEach(async () => {
    mediaDir=mkdtempSync(join(tmpdir(),'media-timeout-'));vi.stubEnv('OUTREACH_MEDIA_DIR',mediaDir);
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Provider budget expired', 'TimeoutError')), ms); return controller.signal; });
    env = await makeDomainEnv();
    accountId = await registerProviderAccount(env.engine, env.admin, { provider: 'fake-social', externalAccountId: 'owner', sender: { name: 'Owner', address: 'owner@example.org' }, purposes: ['social_publishing'], secretRef: 'env:FAKE_SOCIAL', executionPlacement: 'daytona-browser' });
    const upload=startPublishingUpload(env.engine,env.admin,{name:'actual.mp4',mime:'video/mp4',size:video.length});appendPublishingChunk(env.engine,env.admin,upload.uploadId,0,video.toString('base64'));mediaRef=completePublishingUpload(env.engine,env.admin,upload.uploadId).mediaUrl;
  });
  afterEach(() => { env.engine.db.close(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();vi.unstubAllEnvs();rmSync(mediaDir,{recursive:true,force:true}); });
  function queue(key: string, accountPerDay = 10): string {
    return scheduleAction(env.engine, env.admin, { kind: 'social.publish', providerAccountId: accountId, payload: { channel: 'linkedin', text: 'Video', mediaUrls: [mediaRef] }, dueAt: env.now(), approval: 'none', idempotencyKey: key, policy: PolicySchema.parse({ approval: 'none', unsubscribe: 'reply', requirePostalAddress: false, window: { timezone: 'UTC', fallback: 'UTC', days: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], start: '00:00', end: '23:59' }, limits: { accountPerDay, channelPerDay: accountPerDay } }) }).actionId;
  }
  const action = (id: string) => env.engine.db.prepare('SELECT * FROM scheduled_actions WHERE id=?').get<ActionRow>(id)!;
  it('reserves the longer budget only for publishing attachments and constrains custom leases/config', () => {
    const media = action(queue('budget')); const deps = { ...env.engine.exec, config: { executeLeaseMs: 100 } };
    expect(actionProviderTimeout(deps, media)).toBe(180000); expect(actionExecuteLease(deps, media)).toBe(185000);
    expect(actionProviderTimeout(deps, { ...media, payload: '{"text":"Only text"}' })).toBe(30000);
    expect(actionProviderTimeout(deps, { ...media, kind: 'email.send' })).toBe(30000);
    expect(actionExecuteLease(deps, { ...media, kind: 'email.send' })).toBe(100);
    expect(actionProviderTimeout({ ...deps, config: { publishingMediaTimeoutMs: 240000 } }, media)).toBe(240000);
    expect(() => resolveConfig({ ...deps, config: { publishingMediaTimeoutMs: 300001 } })).toThrow(/300000/);
    expect(() => resolveConfig({ ...deps, config: { publishingMediaTimeoutMs: 0 } })).toThrow();
  });
  it('keeps a 45-second media operation owned while a second worker sweeps and claims', async () => {
    const id = queue('long-media'); const calls: string[] = []; let signal: AbortSignal | undefined;
    const adapter = env.engine.adapters.get('fake-social')!;
    adapter.social!.publish = async (ctx) => { calls.push('effect'); signal = ctx.signal; await new Promise((resolve) => setTimeout(resolve, 45000)); ctx.signal.throwIfAborted(); return { kind: 'accepted', receipt: { providerMessageId: 'native-long-video', acceptedAt: ctx.now() } }; };
    const deps: ExecutionDeps = { ...env.engine.exec, config: { executeLeaseMs: 1 } };
    const running = executeDue(deps); await vi.advanceTimersByTimeAsync(0);
    env.advance(31000); await vi.advanceTimersByTimeAsync(31000);
    const second = { ...deps, workerId: 'other-worker' };
    expect(signal?.aborted).toBe(false); expect(action(id).state).toBe('executing');
    expect(sweepExpiredLeases(second, workerActor('other-worker', 'sweep')).madeUncertain).toBe(0);
    expect((await executeDue(second)).executed).toBe(0);
    env.advance(14000); await vi.advanceTimersByTimeAsync(14000); await running;
    expect(action(id)).toMatchObject({ state: 'succeeded', attempt_count: 1 }); expect(calls).toEqual(['effect']);
  });
  it('keeps timeout-after-effect uncertain, holds its budget and prevents another worker resending', async () => {
    const first = queue('timeout', 1); const second = queue('caps-held', 1); let effects = 0;
    const adapter = env.engine.adapters.get('fake-social')!;
    adapter.social!.publish = async (ctx) => { effects++; await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })); throw new Error('unreachable'); };
    const deps = { ...env.engine.exec, config: { publishingMediaTimeoutMs: 1000, executeLeaseMs: 1 } };
    const running = executeDue(deps); await vi.advanceTimersByTimeAsync(0); env.advance(1001); await vi.advanceTimersByTimeAsync(1001); await running;
    expect(action(first)).toMatchObject({ state: 'uncertain', attempt_count: 1 });
    expect(action(second)).toMatchObject({ state: 'scheduled', attempt_count: 0 });
    expect(env.engine.db.prepare('SELECT SUM(used) n FROM rate_buckets').get<{ n: number }>()!.n).toBeGreaterThan(0);
    expect((await executeDue({ ...deps, workerId: 'second-worker' })).executed).toBe(0); expect(effects).toBe(1);
    expect(env.engine.db.prepare('SELECT COUNT(*) n FROM action_attempts').get<{ n: number }>()!.n).toBe(1);
  });
});
