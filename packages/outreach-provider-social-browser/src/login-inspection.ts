import type { Page } from 'playwright';
import { canonicalSocialProfile, PLATFORM_ORIGINS, type SocialChannel } from './platforms';

const IDENTITY: Record<SocialChannel, string> = {
 linkedin: '.profile-card a[href*="/in/"], a[data-control-name="identity_welcome_message"], a[data-view-name="identity-module"]',
 x: 'a[data-testid="AppTabBar_Profile_Link"]',
 instagram: 'nav a:has(img[alt*="profile picture"]), [role="navigation"] a:has(img[alt*="profile picture"]), a[aria-label="Profile"]',
 tiktok: 'a[data-e2e="profile-icon"], a[data-e2e="nav-profile"], a[data-tt="profile-link"]',
};
export interface BrowserLoginIdentity {profileUrl: string; name: string; channel: SocialChannel}
/** Read the native signed-in navigation identity, never arbitrary profile/body links. */
export async function inspectSignedInPage(page: Page, channel: SocialChannel, fixtureOrigin?: string): Promise<BrowserLoginIdentity | null> {
 const origin = fixtureOrigin ?? PLATFORM_ORIGINS[channel];
 if(new URL(page.url()).origin !== origin || /\/(?:login|accounts\/login|checkpoint|challenge|authwall)(?:\/|$)/i.test(new URL(page.url()).pathname)) return null;
 const node = page.locator(IDENTITY[channel]).first();
 if(!await node.count())return null;
 const href = await node.getAttribute('href', {timeout: 3000});if(!href)return null;
 const profile = canonicalSocialProfile(new URL(href, PLATFORM_ORIGINS[channel]).href);
 if(profile.channel !== channel)throw new Error('The signed-in identity belongs to another platform');
 const text = (await node.innerText().catch(()=>''))?.trim();
 return {profileUrl:profile.url,channel,name:(text || new URL(profile.url).pathname.replace(/\//g,'').replace(/^@/,'')).slice(0,200)};
}
export { IDENTITY as LOGIN_IDENTITY_SELECTORS };
