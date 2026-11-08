import { randomUUID } from 'node:crypto';
import { DraftMutationRefusedError,type ProviderContext,type MailDraftAttachment } from '@splitin/outreach-contracts';
import { numeric,zohoRequest,ZOHO_REGIONS,type ZohoHttp } from './http';
export const MAX_DRAFT_ATTACHMENT=20*1024*1024;
async function base(http:ZohoHttp,ctx:ProviderContext){const api=typeof http.api==='function'?await http.api(ctx):http.api;if(!Object.values(ZOHO_REGIONS).some(v=>v.api===api)&&!(process.env.NODE_ENV==='test'&&['localhost','127.0.0.1'].includes(new URL(api).hostname)))throw new Error('Unapproved Zoho regional endpoint');return api;}
export async function uploadZohoAttachment(http:ZohoHttp,ctx:ProviderContext,input:{name:string;mimeType:string;bytes:Uint8Array}):Promise<MailDraftAttachment>{
 if(!input.name||input.name.includes('/')||/[\\\r\n\0]/.test(input.name)||input.name.length>200||input.bytes.length>MAX_DRAFT_ATTACHMENT)throw new DraftMutationRefusedError('Attachment name or size is invalid (maximum 20 MB per file).');
 const path=`/api/accounts/${numeric(await http.accountId(ctx))}/messages/attachments?fileName=${encodeURIComponent(input.name)}&isInline=false`;
 const response=await http.fetch(new URL(path,await base(http,ctx)),{method:'POST',redirect:'error',headers:{authorization:`Zoho-oauthtoken ${await http.tokens.get(ctx)}`,'content-type':input.mimeType,accept:'application/json'},body:Buffer.from(input.bytes),signal:ctx.signal});
 if(response.status===401)http.tokens.invalidate(ctx);const body=await response.json() as {status?:{code?:number};data?:Record<string,unknown>|Record<string,unknown>[]};const value=Array.isArray(body.data)?body.data[0]:body.data;
 if(!response.ok||body.status?.code!==200||!value||!['storeName','attachmentName','attachmentPath'].every(k=>typeof value[k]==='string'))throw new DraftMutationRefusedError('Zoho did not acknowledge the attachment upload; no draft was changed.');
 return{id:`upload-${randomUUID()}`,name:input.name,size:input.bytes.length,mimeType:input.mimeType,native:{storeName:String(value.storeName),attachmentName:String(value.attachmentName),attachmentPath:String(value.attachmentPath)}};
}
export async function listZohoAttachments(http:ZohoHttp,ctx:ProviderContext,folderId:string,id:string):Promise<MailDraftAttachment[]>{
 const data=await zohoRequest(http,ctx,'GET',`/api/accounts/${numeric(await http.accountId(ctx))}/folders/${numeric(folderId)}/messages/${numeric(id)}/attachmentinfo?includeInline=true`) as {attachments?:Record<string,unknown>[];inline?:Record<string,unknown>[]};
 return [...(data.attachments??[]).map(row=>({...row,inline:false})),...(data.inline??[]).map(row=>({...row,inline:true}))].map((row:Record<string,unknown>&{inline:boolean})=>({id:numeric(String(row.attachmentId)),name:String(row.attachmentName??'attachment'),size:Number(row.attachmentSize??0),inline:row.inline,...(row.cid?{contentId:String(row.cid)}:{})}));
}
export async function preserveZohoAttachment(http:ZohoHttp,ctx:ProviderContext,folderId:string,messageId:string,attachment:MailDraftAttachment){
 // Inline composition URLs are session-specific; never silently break an inline CID body on replacement.
 if(attachment.inline)throw new DraftMutationRefusedError('This draft has inline images. Edit it in Zoho to preserve their placement. No draft was changed.');
 if(!Number.isSafeInteger(attachment.size)||attachment.size>MAX_DRAFT_ATTACHMENT)throw new DraftMutationRefusedError('Existing attachment exceeds the safe draft-edit limit; edit this draft in Zoho.');
 const path=`/api/accounts/${numeric(await http.accountId(ctx))}/folders/${numeric(folderId)}/messages/${numeric(messageId)}/attachments/${numeric(attachment.id)}`;
 const response=await http.fetch(new URL(path,await base(http,ctx)),{headers:{authorization:`Zoho-oauthtoken ${await http.tokens.get(ctx)}`},redirect:'error',signal:ctx.signal});if(!response.ok||Number(response.headers.get('content-length')??0)>MAX_DRAFT_ATTACHMENT)throw new DraftMutationRefusedError('Existing attachment could not be preserved; no draft was changed.');
 const reader=response.body?.getReader();if(!reader)throw new DraftMutationRefusedError('Existing attachment response is empty');const chunks:Uint8Array[]=[];let size=0;try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>MAX_DRAFT_ATTACHMENT)throw new DraftMutationRefusedError('Existing attachment exceeded the preservation limit');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
 if(size!==attachment.size)throw new DraftMutationRefusedError('Existing attachment size changed; reload the draft before editing.');
 return uploadZohoAttachment(http,ctx,{name:attachment.name,mimeType:response.headers.get('content-type')??'application/octet-stream',bytes:Buffer.concat(chunks)});
}
