import { expect,it,vi } from 'vitest';
import { socialComment } from './comments';
import type { SocialSession } from './session';
import type { ProviderContext } from '@splitin/outreach-contracts';
it.each([['linkedin','https://www.linkedin.com/feed/update/urn:li:activity:123456789/','a'.repeat(1001)],['instagram','https://www.instagram.com/p/abc/','a'.repeat(2201)],['linkedin','https://www.linkedin.com/feed/update/urn:li:activity:123456789/','   ']])('rejects invalid %s first comments before opening a browser or crossing an effect boundary',async(channel,targetUrl,text)=>{
 const withPage=vi.fn();const session={withPage} as unknown as SocialSession;const ctx={signal:AbortSignal.timeout(1000)} as ProviderContext;
 const result=await socialComment(session,ctx,{kind:channel as 'linkedin',expectedProfileUrl:'https://www.linkedin.com/in/owner/',cdpUrl:'http://127.0.0.1:9222'}, {origin:channel==='instagram'?'https://www.instagram.com':'https://www.linkedin.com',confirmationTimeoutMs:1000},{actionId:'comment',idempotencyKey:'comment',channel,targetUrl,text});expect(result).toMatchObject({kind:'rejected',errorClass:'unsupported'});expect(withPage).not.toHaveBeenCalled();
});
