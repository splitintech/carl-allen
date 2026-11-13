import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
export async function renewLocalBrowserView(settings,{fetchImpl=fetch,refresh=promisify(execFile)}={}){
 const key=process.env.OUTREACH_DAYTONA_API_KEY??process.env.DAYTONA_API_KEY;
 if(key&&settings.sandboxId){
  const response=await fetchImpl(`https://app.daytona.io/api/sandbox/${encodeURIComponent(settings.sandboxId)}/ports/6080/signed-preview-url?expiresInSeconds=900`,{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Cannot renew private browser access. Check the server’s Daytona connection.');const value=await response.json();return browserUrl(value.url);
 }
 if(process.env.OUTREACH_DAYTONA_REFRESH_PYTHON&&process.env.OUTREACH_CONNECTION_FILE){
  try{await refresh(process.env.OUTREACH_DAYTONA_REFRESH_PYTHON,[fileURLToPath(new URL('../../../../../../deploy/daytona/manage.py',import.meta.url)),'refresh','--state',process.env.OUTREACH_CONNECTION_FILE,...(process.env.OUTREACH_DAYTONA_CLI_AUTH==='1'?['--cli-auth']:[])],{timeout:55000,maxBuffer:1024*1024});return null;}catch{throw new Error('Private browser renewal failed. Reconnect the server’s Daytona login.');}
 }
 if(settings.liveViewUrl&&settings.expiresAt>Date.now()+30000)return browserUrl(settings.liveViewUrl);
 // A trusted local connection can reuse the operator's existing CLI login. Keep
 // the signed URL server-side until the account-specific view is opened.
 if(process.env.OUTREACH_CONNECTION_FILE&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(settings.sandboxId??'')){
  try{
   const result=await refresh('daytona',['preview-url',settings.sandboxId,'--port','6080','--expires','900'],{timeout:20000,maxBuffer:65536});
   const value=result.stdout.trim();if(!/^https:\/\/\S+$/.test(value))throw new Error('Unexpected preview response');
   return browserUrl(value);
  }catch{throw new Error('Private browser renewal failed. Sign in to the Daytona CLI on this computer, then try Reconnect again.');}
 }
 throw new Error('Private browser access expired. Configure OUTREACH_DAYTONA_API_KEY or OUTREACH_DAYTONA_REFRESH_PYTHON on the local server to renew access automatically.');
}
export function browserUrl(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('Invalid private browser URL');if(!url.pathname.endsWith('/vnc.html'))url.pathname=url.pathname.replace(/\/$/,'')+'/vnc.html';url.searchParams.set('autoconnect','true');url.searchParams.set('resize','scale');return url.href;}
