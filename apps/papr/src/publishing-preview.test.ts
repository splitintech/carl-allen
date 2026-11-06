import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
// @ts-expect-error local dependency-free Node preview host has no TypeScript declaration.
import { createPublishingPreview } from '../preview.mjs';
const calls: unknown[] = [];
const server = createPublishingPreview({ handler: async (action: string, params: unknown) => { calls.push({action,params}); return {ok:true,data:{saved:true}}; } });
let base: string;
beforeAll(async () => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it('forwards same-origin allowlisted backend requests without any browser credential', async () => {
  const r = await fetch(base+'/api/app/backend/publishing-overview', {method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({appId:'outreach-console',params:{}})});
  expect(r.status).toBe(200); expect(await r.json()).toEqual({stdout:JSON.stringify({ok:true,data:{saved:true}})}); expect(calls).toHaveLength(1);
});
it('rejects cross-origin and missing-origin mutations before backend dispatch', async () => {
  for (const origin of ['https://untrusted.invalid','null','']) {
    const r = await fetch(base+'/api/app/backend/publishing-overview', {method:'POST',headers:{...(origin?{origin}:{}),'content-type':'application/json'},body:JSON.stringify({appId:'outreach-console',params:{}})});
    expect(r.status).toBe(403);
  }
  expect(calls).toHaveLength(1);
});
it('never serves backend source or traversed assets and refuses malformed requests', async () => {
  for(const path of ['/backend/outreach.mjs','/%62ackend/manifest.json','/../package.json']) expect((await fetch(base+path)).status).toBe(404);
  const headers={origin:base,'content-type':'application/json'};
  expect((await fetch(base+'/api/app/backend/publishing-overview',{method:'POST',headers,body:'{'})).status).toBe(400);
  expect((await fetch(base+'/api/app/backend/publishing-overview',{method:'POST',headers,body:JSON.stringify({appId:'other',params:{}})})).status).toBe(400);
  expect((await fetch(base+'/api/app/backend/publishing-overview',{method:'POST',headers,body:JSON.stringify({appId:'outreach-console',params:{text:'x'.repeat(270000)}})})).status).toBe(413);
  expect(calls).toHaveLength(1);
});
