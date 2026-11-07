import type { ProviderContext } from '@splitin/outreach-contracts';
import type { AccountBinding, RuntimePlacement } from './runtime';
const queues = new Map<string, Promise<void>>();

/** Serializes both browser effects and inbox/health reads across shared login targets. */
export async function withLoginConnection<T>(runtime: RuntimePlacement, ctx: ProviderContext, binding: AccountBinding, fn: () => Promise<T>): Promise<T> {
  const key = binding.connectionId ?? ctx.account.externalAccountId;
  const previous = queues.get(key) ?? Promise.resolve(); let release!: () => void;
  const current = new Promise<void>(r => { release = r; }); queues.set(key, current); await previous;
  let lease: string | undefined; let timer: ReturnType<typeof setInterval> | undefined;
  const origin = process.env.OUTREACH_BROWSER_POOL_URL;
  const request = async (path: string, data: unknown, releaseAfterAbort = false) => {
    if (origin !== 'http://127.0.0.1:8788') throw new Error('Browser pool must be the supervised loopback endpoint');
    const response = await fetch(`${origin}${path}`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:releaseAfterAbort?AbortSignal.timeout(5000):AbortSignal.any([ctx.signal,AbortSignal.timeout(35000)]) });
    const value = await response.json() as {leaseId?:string;error?:string};
    if (!response.ok) throw new Error(value.error ?? 'Browser connection unavailable'); return value;
  };
  try {
    ctx.signal.throwIfAborted();
    if (runtime.kind === 'daytona' && origin) {
      const acquired = await request('/browser/acquire',{connectionId:key});lease=acquired.leaseId;
      if (!lease) throw new Error('Supervisor returned no browser lease');
      timer=setInterval(()=>{void request('/browser/renew',{leaseId:lease}).catch(()=>undefined);},30000);
    }
    return await fn();
  } finally {
    if(timer)clearInterval(timer);
    if(lease)await request('/browser/release',{leaseId:lease},true).catch(()=>undefined);
    release();if(queues.get(key)===current)queues.delete(key);
  }
}
