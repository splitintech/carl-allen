import { loopbackAuthorize } from '@splitin/outreach-provider-kit';
import { ZOHO_REGIONS, type ZohoRegion } from './http';
import type { ZohoGrant } from './token';
export const ZOHO_SCOPES=['ZohoMail.accounts.READ','ZohoMail.folders.READ','ZohoMail.messages.READ','ZohoMail.messages.CREATE','ZohoMail.messages.DELETE'] as const;
export async function authorizeZoho(options:{clientId:string;clientSecret:string;region?:ZohoRegion;onUrl:(url:string)=>void;fetch?:typeof fetch;timeoutMs?:number}):Promise<{grant:ZohoGrant;emailAddress:string;scopes:readonly string[]}>{
  const region=options.region??'us';const endpoints=ZOHO_REGIONS[region];const doFetch=options.fetch??fetch;
  return loopbackAuthorize({authUrl:`${endpoints.accounts}/oauth/v2/auth`,params:{client_id:options.clientId,scope:ZOHO_SCOPES.join(','),access_type:'offline',prompt:'consent'},redirectHost:'127.0.0.1',onUrl:options.onUrl,timeoutMs:options.timeoutMs,exchange:async({code,verifier,redirectUri})=>{
    const response=await doFetch(`${endpoints.accounts}/oauth/v2/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:options.clientId,client_secret:options.clientSecret,code,code_verifier:verifier,redirect_uri:redirectUri,grant_type:'authorization_code'}),redirect:'error'});
    const tokens=await response.json() as {access_token?:string;refresh_token?:string};if(!response.ok||!tokens.access_token||!tokens.refresh_token)throw new Error('Zoho authorization did not return a refresh grant');
    const profile=await doFetch(`${endpoints.api}/api/accounts`,{headers:{authorization:`Zoho-oauthtoken ${tokens.access_token}`},redirect:'error'});const body=await profile.json() as {data?:{accountId?:string;primaryEmailAddress?:string;mailboxAddress?:string}[]};const account=body.data?.[0];const email=account?.primaryEmailAddress??account?.mailboxAddress;
    if(!profile.ok||!account?.accountId||!email)throw new Error('Cannot verify authorized Zoho mailbox identity');
    return{grant:{clientId:options.clientId,clientSecret:options.clientSecret,refreshToken:tokens.refresh_token,accountId:String(account.accountId),region},emailAddress:email.toLowerCase(),scopes:ZOHO_SCOPES};
  }});
}
