import { TokenError, type AccessTokenSource, type ProviderContext } from '@splitin/outreach-contracts';
import { ZOHO_REGIONS, type ZohoRegion } from './http';
export interface ZohoGrant{clientId:string;clientSecret:string;refreshToken:string;accountId:string;region:ZohoRegion}
export function parseZohoGrant(raw:string):ZohoGrant{
  let value:Partial<ZohoGrant>;try{value=JSON.parse(raw) as Partial<ZohoGrant>;}catch{throw new TokenError('auth_revoked','Zoho grant must be a private JSON object');}
  if(!value.clientId||!value.clientSecret||!value.refreshToken||!value.accountId||!/^\d+$/.test(value.accountId)||!value.region||!ZOHO_REGIONS[value.region])throw new TokenError('auth_revoked','Zoho grant requires clientId, clientSecret, refreshToken, accountId and region');
  return value as ZohoGrant;
}
export async function zohoGrant(ctx:ProviderContext):Promise<ZohoGrant>{return parseZohoGrant(await ctx.secrets.get(ctx.secretRef));}
export function zohoRefreshTokenSource(options:{fetch?:typeof fetch;region?:ZohoRegion;tokenUrl?:string}={}):AccessTokenSource{
  const cache=new Map<string,{token:string;expires:number}>();const key=(ctx:ProviderContext)=>`${ctx.workspaceId}:${ctx.account.id}:${ctx.secretRef}`;
  return{async get(ctx){const old=cache.get(key(ctx));if(old&&old.expires>ctx.now())return old.token;const grant=await zohoGrant(ctx);
    const url=options.tokenUrl??`${ZOHO_REGIONS[grant.region].accounts}/oauth/v2/token`;const fixture=process.env.NODE_ENV==='test'&&['localhost','127.0.0.1'].includes(new URL(url).hostname);
    if(!fixture&&!Object.values(ZOHO_REGIONS).some(r=>url===`${r.accounts}/oauth/v2/token`))throw new TokenError('auth_revoked','Unapproved Zoho token endpoint');
    const response=await(options.fetch??fetch)(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:grant.clientId,client_secret:grant.clientSecret,refresh_token:grant.refreshToken}),signal:ctx.signal,redirect:'error'});
    const body=await response.json() as {access_token?:string;expires_in?:number;error?:string};if(!response.ok||!body.access_token)throw new TokenError(body.error==='invalid_code'?'auth_revoked':'auth_expired','Zoho grant refresh was refused; reconnect mailbox');
    cache.set(key(ctx),{token:body.access_token,expires:ctx.now()+Math.max(0,(body.expires_in??3600)-60)*1000});return body.access_token;},invalidate(ctx){cache.delete(key(ctx));}};
}
