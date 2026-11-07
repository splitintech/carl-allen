import type { AccessTokenSource, ProviderAdapter } from '@splitin/outreach-contracts';
import { ZOHO_REGIONS, zohoRequest, type ZohoRegion, type ZohoHttp } from './http';
import { zohoGrant, zohoRefreshTokenSource } from './token';
import { zohoInbox } from './mailbox';
import { zohoDrafts } from './drafts';
export { authorizeZoho,ZOHO_SCOPES } from './oauth';
export { zohoRefreshTokenSource,parseZohoGrant,type ZohoGrant } from './token';
export { ZOHO_REGIONS,type ZohoRegion } from './http';
export interface ZohoAdapterOptions{region?:ZohoRegion;api?:string;fetch?:typeof fetch;tokens?:AccessTokenSource;accountId?:string}
/** Human mailbox tools only: intentionally no EmailSender or automated sending capability. */
export function zohoAdapter(options:ZohoAdapterOptions={}):ProviderAdapter{
  const http:ZohoHttp={api:options.api??(async ctx=>ZOHO_REGIONS[options.region??(await zohoGrant(ctx)).region].api),fetch:options.fetch??fetch,tokens:options.tokens??zohoRefreshTokenSource({fetch:options.fetch}),accountId:async ctx=>options.accountId??(await zohoGrant(ctx)).accountId};
  return{name:'zoho',purposes:['manual_correspondence'],account:{async discover(ctx){return{provider:'zoho',send:false,replyInThread:false,customHeaders:false,externalIdempotency:false,inboundWebhook:false,mailboxPolling:false,reconcileBySentSearch:false,maxRecipientsPerMessage:0,discoveredAt:ctx.now()};},async health(ctx){try{const value=await zohoRequest(http,ctx,'GET',`/api/accounts/${await http.accountId(ctx)}`) as {primaryEmailAddress?:string;mailboxAddress?:string};const email=value.primaryEmailAddress??value.mailboxAddress;return email?.toLowerCase()===ctx.account.sender.address.toLowerCase()?{status:'ok'}:{status:'unhealthy',detail:'Zoho mailbox identity does not match account sender'};}catch{return{status:'reauth_required',detail:'Reconnect Zoho mailbox; identity/grant check failed'};}}},inbox:zohoInbox(http),drafts:zohoDrafts(http)};
}
