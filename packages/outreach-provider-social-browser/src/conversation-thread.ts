import type { Page } from 'playwright';
import { canonicalSocialProfile } from './platforms';
export async function verifyNativeThread(page:Page,expected:string,participants?:{selector:string;peerUrl:string;ownerUrl:string}):Promise<void> {
 if(!expected||expected.length>500||/[/?#\\\s]/.test(expected)||[...expected].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new Error('Invalid approved native thread identifier');
 const row=page.locator('[data-conversation-id], [data-conversation-urn], [data-thread-id]').first();
 const dom=await row.getAttribute('data-conversation-id',{timeout:500}).catch(()=>null)??await row.getAttribute('data-conversation-urn',{timeout:500}).catch(()=>null)??await row.getAttribute('data-thread-id',{timeout:500}).catch(()=>null);
 const path=new URL(page.url()).pathname.match(/\/(?:t|thread)\/([^/]+)/)?.[1];
 if(dom&&dom!==expected||path&&decodeURIComponent(path)!==expected||!dom&&!path)throw new Error('Opened native thread does not match the approved conversation');
 if(participants){const peer=canonicalSocialProfile(participants.peerUrl).url;const owner=canonicalSocialProfile(participants.ownerUrl).url;const hrefs=await page.locator(participants.selector).evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')).filter((v):v is string=>Boolean(v)));const peers=new Set(hrefs.map(href=>canonicalSocialProfile(new URL(href,peer).href).url).filter(url=>url!==owner));if(peers.size!==1||!peers.has(peer))throw new Error('Native conversation participants do not match the single approved recipient');}
}
