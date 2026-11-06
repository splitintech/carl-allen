import { describe,it,expect } from 'vitest';
import type { ProviderContext,EmailContent } from '@splitin/outreach-contracts';
import { outlookAdapter } from './index';
const ctx:ProviderContext={workspaceId:'w',account:{id:'a',provider:'outlook',externalAccountId:'owner@example.org',sender:{name:'Owner',address:'owner@example.org'}},secretRef:'env:T',secrets:{get:async()=>''},traceId:'t',signal:new AbortController().signal,now:()=>Date.now()};
const email:EmailContent={from:{address:'owner@example.org'},to:[{address:'recipient@example.net'}],subject:'Draft',text:'Hello',headers:{}};
describe('Outlook drafts',()=>{
 it('edits/deletes only affirmed drafts and never uses send',async()=>{
  const calls:{method:string,path:string}[]=[];const message={id:'d1',isDraft:true,subject:'Draft',body:{contentType:'Text',content:'Hello'},toRecipients:[{emailAddress:{address:'recipient@example.net'}}]};
  const fetcher=async(input:URL|string|Request,options?:RequestInit)=>{const url=new URL(String(input));calls.push({method:options?.method??'GET',path:url.pathname});return new Response(JSON.stringify(url.pathname.endsWith('/drafts/messages')?{value:[message]}:message),{status:200});};
  const port=outlookAdapter({fetch:fetcher as typeof fetch,tokens:{get:async()=> 'token',invalidate:()=>{}}}).drafts!;
  expect((await port.list(ctx))[0]?.content.text).toBe('Hello');await port.save(ctx,email);await port.save(ctx,{...email,id:'d1'});await port.delete(ctx,'d1');
  expect(calls.some((c)=>c.method==='PATCH')).toBe(true);expect(calls.some((c)=>c.method==='DELETE')).toBe(true);expect(calls.every((c)=>!c.path.endsWith('/send'))).toBe(true);
 });
 it('refuses updating/deleting an existing sent message',async()=>{
  const calls:string[]=[];const port=outlookAdapter({fetch:async(_input,options)=>{calls.push(options?.method??'GET');return new Response(JSON.stringify({id:'sent',isDraft:false}),{status:200});},tokens:{get:async()=> 'token',invalidate:()=>{}}}).drafts!;
  await expect(port.save(ctx,{...email,id:'sent'})).rejects.toThrow(/not a draft/);await expect(port.delete(ctx,'sent')).rejects.toThrow(/not a draft/);expect(calls).toEqual(['GET','GET']);
 });
});
