import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
const { handle } = await import(new URL('../bundle/apps/outreach-console/backend/outreach.mjs', import.meta.url).href) as { handle(action:string,params?:unknown):Promise<{ok:boolean;error?:string;data?:unknown}> };
const saved = { ...process.env };
let directory: string | undefined;
afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); if(directory)rmSync(directory,{recursive:true,force:true}); directory=undefined; });
describe('private remote connection', () => {
  it('rejects remote plaintext and embedded URL credentials without forwarding secrets', async () => {
    delete process.env.OUTREACH_CONNECTION_FILE; process.env.OUTREACH_API_TOKEN='engine-private';
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    process.env.OUTREACH_API_URL='http://remote.example.test';
    expect((await handle('drafts-list',{accountId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'})).error).toMatch(/HTTPS/);
    process.env.OUTREACH_API_URL='https://person:private-value@remote.example.test';
    const result=await handle('drafts-list',{accountId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'});
    expect(result.error).toMatch(/embedded credentials/);expect(result.error).not.toContain('private-value');expect(fetch).not.toHaveBeenCalled();
  });
  it('separates proxy/app credentials, preserves signed query and reloads rotated private connection file', async () => {
    directory=mkdtempSync(join(tmpdir(),'outreach-connection-'));const file=join(directory,'connection.json');
    process.env.OUTREACH_CONNECTION_FILE=file;
    const write=(previewToken:string,apiToken:string)=>writeFileSync(file,JSON.stringify({apiUrl:'https://preview.example.test/?signature=opaque',previewToken,apiToken}),{mode:0o600});
    write('preview-old','engine-old');
    const seen: {url:string;options:RequestInit}[]=[];
    vi.stubGlobal('fetch',async(url:URL,options:RequestInit)=>{seen.push({url:String(url),options});return {ok:true,json:async()=>({drafts:[]})};});
    expect((await handle('drafts-list',{accountId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'})).ok).toBe(true);
    write('preview-new','engine-new');
    await handle('drafts-list',{accountId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'});
    expect(seen[0]?.options.headers).toEqual({authorization:'Bearer engine-old','x-daytona-preview-token':'preview-old'});
    expect(seen[1]?.options.headers).toEqual({authorization:'Bearer engine-new','x-daytona-preview-token':'preview-new'});
    expect(seen[0]?.url).toContain('signature=opaque');expect(seen[0]?.options.redirect).toBe('error');
  });
  it('refuses public-readable credentials and expired connections before network I/O', async () => {
    directory=mkdtempSync(join(tmpdir(),'outreach-connection-'));const file=join(directory,'connection.json');process.env.OUTREACH_CONNECTION_FILE=file;
    writeFileSync(file,JSON.stringify({apiUrl:'https://preview.example.test',apiToken:'secret',apiTokenExpiresAt:Date.now()-1}),{mode:0o600});
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    expect((await handle('drafts-list',{accountId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'})).error).toMatch(/expired/);
    chmodSync(file,0o644);expect((await handle('drafts-list',{accountId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'})).error).toMatch(/owner-only/);expect(fetch).not.toHaveBeenCalled();
  });
});
