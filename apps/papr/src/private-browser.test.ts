import {afterEach,describe,expect,it} from 'vitest';
// @ts-expect-error dependency-free trusted backend module.
import {renewLocalBrowserView} from '../bundle/apps/outreach-console/backend/private-browser.mjs';
const previous={...process.env};afterEach(()=>{process.env={...previous};});
describe('trusted private browser renewal',()=>{
 it('mints account-view credentials on the server and returns only the signed desktop URL',async()=>{process.env.OUTREACH_DAYTONA_API_KEY='fixture-key';let seen:RequestInit|undefined;const url=await renewLocalBrowserView({sandboxId:'fixture-sandbox'},{fetchImpl:async(value:string,init:RequestInit)=>{expect(value).toBe('https://app.daytona.io/api/sandbox/fixture-sandbox/ports/6080/signed-preview-url?expiresInSeconds=900');seen=init;return Response.json({url:'https://private-view.example.invalid/?signature=fixture'});}});expect(seen?.headers).toEqual({authorization:'Bearer fixture-key'});expect(url).toBe('https://private-view.example.invalid/vnc.html?signature=fixture&autoconnect=true&resize=scale');expect(url).not.toContain('fixture-key');});
 it('never reuses an expired local link or an embedded-credential view',async()=>{delete process.env.OUTREACH_DAYTONA_API_KEY;delete process.env.DAYTONA_API_KEY;delete process.env.OUTREACH_DAYTONA_REFRESH_PYTHON;await expect(renewLocalBrowserView({expiresAt:Date.now()-1,liveViewUrl:'https://private.example.invalid/'})).rejects.toThrow('expired');await expect(renewLocalBrowserView({expiresAt:Date.now()+100000,liveViewUrl:'https://user:password@private.example.invalid/'})).rejects.toThrow('Invalid');});
 it('renews an expired trusted local view through the existing CLI without exposing its login',async()=>{
  delete process.env.OUTREACH_DAYTONA_API_KEY;delete process.env.DAYTONA_API_KEY;delete process.env.OUTREACH_DAYTONA_REFRESH_PYTHON;process.env.OUTREACH_CONNECTION_FILE='/private/connection.json';
  const sandboxId='1cfb0ef9-bf7f-42c7-9a03-c02f6c270f82';let invoked=false;
  const url=await renewLocalBrowserView({sandboxId,expiresAt:0},{refresh:async(command:string,args:string[],options:{timeout:number;maxBuffer:number})=>{invoked=true;expect(command).toBe('daytona');expect(args).toEqual(['preview-url',sandboxId,'--port','6080','--expires','900']);expect(options.timeout).toBe(20000);return{stdout:'https://private.example.invalid/?signature=fixture\n'};}});
  expect(invoked).toBe(true);expect(url).toBe('https://private.example.invalid/vnc.html?signature=fixture&autoconnect=true&resize=scale');
 });
 it('does not pass untrusted sandbox text to a shell and sanitizes CLI errors',async()=>{
  delete process.env.OUTREACH_DAYTONA_API_KEY;delete process.env.DAYTONA_API_KEY;delete process.env.OUTREACH_DAYTONA_REFRESH_PYTHON;process.env.OUTREACH_CONNECTION_FILE='/private/connection.json';
  let invoked=false;const refresh=async()=>{invoked=true;throw new Error('private-token-do-not-expose');};
  await expect(renewLocalBrowserView({sandboxId:'anything; echo secret'},{refresh})).rejects.toThrow('expired');expect(invoked).toBe(false);
  const failed=renewLocalBrowserView({sandboxId:'1cfb0ef9-bf7f-42c7-9a03-c02f6c270f82'},{refresh});await expect(failed).rejects.toThrow('Sign in to the Daytona CLI');await expect(failed).rejects.not.toThrow('private-token');
 });
});
