import type { AccessTokenSource, ProviderContext } from '@splitin/outreach-contracts';
export const ZOHO_REGIONS={us:{api:'https://mail.zoho.com',accounts:'https://accounts.zoho.com'},eu:{api:'https://mail.zoho.eu',accounts:'https://accounts.zoho.eu'},in:{api:'https://mail.zoho.in',accounts:'https://accounts.zoho.in'},au:{api:'https://mail.zoho.com.au',accounts:'https://accounts.zoho.com.au'},jp:{api:'https://mail.zoho.jp',accounts:'https://accounts.zoho.jp'},ca:{api:'https://mail.zohocloud.ca',accounts:'https://accounts.zohocloud.ca'}} as const;
export type ZohoRegion=keyof typeof ZOHO_REGIONS;
export interface ZohoHttp{api:string|((ctx:ProviderContext)=>Promise<string>);fetch:typeof fetch;tokens:AccessTokenSource;accountId:(ctx:ProviderContext)=>Promise<string>}
export const numeric=(value:string)=>{if(!/^\d{1,32}$/.test(value))throw new Error('Invalid Zoho object identifier');return value;};
export async function zohoRequest(http:ZohoHttp,ctx:ProviderContext,method:'GET'|'POST'|'DELETE',path:string,body?:unknown):Promise<unknown>{
  const api=typeof http.api==='function'?await http.api(ctx):http.api;
  const fixture=process.env.NODE_ENV==='test'&&['127.0.0.1','localhost'].includes(new URL(api).hostname);
  if(!fixture&&!Object.values(ZOHO_REGIONS).some(r=>r.api===api))throw new Error('Zoho API must be an approved regional endpoint');
  if(!path.startsWith('/api/accounts/'))throw new Error('Zoho operation is outside mailbox scope');
  // POST /messages is permitted only with the explicitly fixed draft mode. There is no send fallback.
  if(method==='POST'&&(!body||typeof body!=='object'||(body as {mode?:string}).mode!=='draft'||!/^\/api\/accounts\/\d+\/messages$/.test(path)))throw new Error('Zoho mutation must save an unsent draft');
  const token=await http.tokens.get(ctx);
  const response=await http.fetch(new URL(path,api),{method,redirect:'manual',headers:{authorization:`Zoho-oauthtoken ${token}`,'content-type':'application/json',accept:'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(30000)])});
  if(response.status===401)http.tokens.invalidate(ctx);
  if(!response.ok)throw new Error(`Zoho mailbox operation refused (HTTP ${response.status})`);
  const value=await response.json() as {status?:{code?:number};data?:unknown};
  if(value.status?.code&&value.status.code!==200)throw new Error(`Zoho mailbox operation refused (${value.status.code})`);
  return value.data;
}
