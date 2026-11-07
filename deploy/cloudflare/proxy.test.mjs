/* global Response */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserLogin} from './proxy.mjs';
test('browser login mints only a15min port6080 URL, never a standard preview token',async()=>{
 const env={DAYTONA_API_KEY:'private-api-key',DAYTONA_SANDBOX_ID:'sandbox'};
 const calls=[];const value=await browserLogin(env,async(url,options)=>{calls.push([url.href,options]);return Response.json({url:'https://6080-signed.proxy.daytona.work',token:'never-return-this'});});
 assert.match(calls[0][0],/ports\/6080\/signed-preview-url\?expiresInSeconds=900/);assert.match(value.url,/vnc.html\?autoconnect=true&resize=scale/);assert.ok(!JSON.stringify(value).includes('never-return-this'));assert.equal(calls[0][1].redirect,'manual');
});
