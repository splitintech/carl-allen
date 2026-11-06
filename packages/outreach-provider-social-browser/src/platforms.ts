export const SOCIAL_CHANNELS = ['linkedin', 'x', 'instagram', 'tiktok'] as const;
export type SocialChannel = typeof SOCIAL_CHANNELS[number];
export const PLATFORM_ORIGINS: Record<SocialChannel, string> = { linkedin: 'https://www.linkedin.com', x: 'https://x.com', instagram: 'https://www.instagram.com', tiktok: 'https://www.tiktok.com' };
export function canonicalSocialProfile(value: string): { channel: SocialChannel; url: string } {
  const p = new URL(value);
  if (p.protocol !== 'https:' || p.username || p.password || p.search || p.hash || p.port) throw new Error('Use a canonical HTTPS social profile URL');
  const host = p.hostname.toLowerCase();
  let channel: SocialChannel;
  if (['linkedin.com', 'www.linkedin.com'].includes(host) && /^\/in\/[a-z0-9_-]+\/?$/i.test(p.pathname)) channel = 'linkedin';
  else if (['x.com', 'www.x.com'].includes(host) && /^\/[a-z0-9_]{1,15}\/?$/i.test(p.pathname) && !/^\/(home|compose|settings|messages|explore|notifications|i)\/?$/i.test(p.pathname)) channel = 'x';
  else if (['instagram.com', 'www.instagram.com'].includes(host) && /^\/[a-z0-9_.]{1,30}\/?$/i.test(p.pathname) && !/^\/(accounts|direct|explore|reels|stories|p)\/?$/i.test(p.pathname)) channel = 'instagram';
  else if (['tiktok.com', 'www.tiktok.com'].includes(host) && /^\/@[a-z0-9_.]{2,24}\/?$/i.test(p.pathname)) channel = 'tiktok';
  else throw new Error('Use a canonical LinkedIn, X, Instagram or TikTok profile URL');
  return { channel, url: `${PLATFORM_ORIGINS[channel]}${p.pathname.toLowerCase().replace(/\/?$/, '/')}` };
}
export function accountChannel(binding: { kind?: string; expectedProfileUrl?: string }): SocialChannel {
  const channel = canonicalSocialProfile(binding.expectedProfileUrl ?? '').channel;
  if (binding.kind && binding.kind !== channel) throw new Error('Browser channel does not match its canonical profile identity');
  return channel;
}
