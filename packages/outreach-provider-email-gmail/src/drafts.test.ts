import { describe,it,expect } from 'vitest';
import type { ProviderContext,EmailContent } from '@splitin/outreach-contracts';
import { gmailAdapter } from './index';
const ctx:ProviderContext={workspaceId:'w',account:{id:'a',provider:'gmail',externalAccountId:'owner@example.org',sender:{name:'Owner',address:'owner@example.org'}},secretRef:'env:T',secrets:{get:async()=>''},traceId:'t',signal:new AbortController().signal,now:()=>Date.now()};
const email:EmailContent={from:{address:'owner@example.org'},to:[{address:'recipient@example.net'}],subject:'Draft',text:'Hello',headers:{}};
describe('Gmail drafts',()=>{
 it('creates, reads, updates and deletes only draft resources; never calls send',async()=>{
  const calls:{method:string,path:string,body?:unknown}[]=[];
  const fetcher=async(input:URL|string|Request,options?:RequestInit)=>{const url=new URL(String(input));calls.push({method:options?.method??'GET',path:url.pathname,...(options?.body?{body:JSON.parse(String(options.body)) as unknown}:{})});const payload={headers:[{name:'From',value:'owner@example.org'},{name:'To',value:'recipient@example.net'},{name:'Subject',value:'Draft'}],mimeType:'text/plain',body:{data:Buffer.from('Hello').toString('base64url')}};return new Response(JSON.stringify(url.pathname.endsWith('/drafts')&&options?.method==='GET'?{drafts:[{id:'d1'}]}:{id:'d1',message:{payload}}),{status:200});};
  const port=gmailAdapter({fetch:fetcher as typeof fetch,tokens:{get:async()=> 'token',invalidate:()=>{}}}).drafts!;
  expect((await port.list(ctx))[0]?.content.text).toBe('Hello');
  expect((await port.save(ctx,email)).id).toBe('d1');
  await port.save(ctx,{...email,id:'d1'});await port.delete(ctx,'d1');
  expect(calls.some((c)=>c.method==='PUT'&&c.path.endsWith('/drafts/d1'))).toBe(true);
  expect(calls.some((c)=>c.method==='DELETE')).toBe(true);
  expect(calls.every((c)=>!c.path.includes('/send'))).toBe(true);
 });
 it('rejects revoked credentials rather than reporting a saved draft',async()=>{
  let invalidated=false;const port=gmailAdapter({fetch:async()=>new Response('{}',{status:401}),tokens:{get:async()=> 'token',invalidate:()=>{invalidated=true;}}}).drafts!;
  await expect(port.save(ctx,email)).rejects.toThrow(/401/);expect(invalidated).toBe(true);
 });
});

describe('Gmail draft preservation',()=>{
 it('refuses raw replacement of an existing draft with attachments or hidden recipients',async()=>{
  for(const payload of [
    {mimeType:'multipart/mixed',parts:[{mimeType:'text/plain',body:{data:Buffer.from('Text').toString('base64url')}},{mimeType:'application/pdf',filename:'lease.pdf',body:{attachmentId:'attachment'}}]},
    {headers:[{name:'Cc',value:'colleague@example.org'}],mimeType:'text/plain',body:{data:Buffer.from('Text').toString('base64url')}},
  ]){
   const methods:string[]=[];
   const port=gmailAdapter({fetch:async(_input,options)=>{methods.push(options?.method??'GET');return new Response(JSON.stringify({id:'d1',message:{payload}}),{status:200});},tokens:{get:async()=> 'token',invalidate:()=>{}}}).drafts!;
   await expect(port.save(ctx,{...email,id:'d1'})).rejects.toThrow(/No update was made/);
   expect(methods).toEqual(['GET']);
  }
 });
 it('preserves reply threading and reply-to when changing a supported existing draft',async()=>{
  let raw='';
  const payload={headers:[{name:'From',value:'owner@example.org'},{name:'To',value:'recipient@example.net'},{name:'Reply-To',value:'reply@example.org'},{name:'In-Reply-To',value:'<parent@example.net>'},{name:'References',value:'<root@example.net> <parent@example.net>'}],mimeType:'text/plain',body:{data:Buffer.from('Text').toString('base64url')}};
  const port=gmailAdapter({fetch:async(_input,options)=>{if(options?.method==='PUT')raw=Buffer.from((JSON.parse(String(options.body)) as {message:{raw:string}}).message.raw,'base64url').toString('utf8');return new Response(JSON.stringify({id:'d1',message:{threadId:'thread-1',payload}}),{status:200});},tokens:{get:async()=> 'token',invalidate:()=>{}}}).drafts!;
  await port.save(ctx,{...email,id:'d1'});
  expect(raw).toContain('In-Reply-To: <parent@example.net>');expect(raw).toContain('References: <root@example.net> <parent@example.net>');expect(raw).toContain('Reply-To: reply@example.org');
 });
});
