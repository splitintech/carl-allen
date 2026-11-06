export const PLATFORMS = [
  { id: 'linkedin', name: 'LinkedIn', icon: 'in', cap: 3000, maxImages: 4, host: 'linkedin.com', hint: 'Text, images or one video' },
  { id: 'x', name: 'X', icon: '𝕏', cap: 280, maxImages: 4, host: 'x.com', hint: 'Text, images or one video' },
  { id: 'instagram', name: 'Instagram', icon: '◎', cap: 2200, maxImages: 10, host: 'instagram.com', hint: 'Images or one video · caption optional' },
  { id: 'tiktok', name: 'TikTok', icon: '♪', cap: 2200, maxImages: 0, host: 'tiktok.com', hint: 'One video · caption optional' },
];
export const platform = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];
export const channels = (a) => a.capabilities?.socialChannels || [];
export function accountsFor(data, channel) { return (data.accounts || []).filter((a) => channels(a).includes(channel)); }
export const accountName = (a) => a?.sender?.name || a?.externalAccountId || 'Connect an account';
export const keyOf = (post) => post.channel;
export function validatePost(post, media, accounts) {
  const p = platform(post.channel); const assets = post.mediaIds.map((id) => media.find((asset) => asset.id === id)); const errors = [];
  if (!post.text.trim() && !post.mediaIds.length) errors.push('Add a caption or media.');
  if ([...post.text].length > p.cap) errors.push(`${p.name}: caption exceeds the ${p.cap}-character composer limit.`);
  if (assets.some((a) => !a)) errors.push(`${p.name}: an attachment is no longer available.`);
  const videos = assets.filter((a) => a?.mime.startsWith('video/')); const images = assets.filter((a) => a?.mime.startsWith('image/'));
  if (videos.some((a) => a.mime !== 'video/mp4')) errors.push('Convert videos to MP4 before publishing.');
  if (p.id === 'instagram' && images.some((a) => a.mime === 'image/webp')) errors.push('Convert Instagram images to JPEG or PNG before publishing.');
  if (videos.length > 1 || (videos.length && images.length)) errors.push(`${p.name}: use one video or images, without mixing them.`);
  if (images.length > p.maxImages) errors.push(`${p.name}: this composer accepts up to ${p.maxImages} images.`);
  if (p.id === 'instagram' && !post.mediaIds.length) errors.push('Instagram requires an image or video.');
  if (p.id === 'tiktok' && (videos.length !== 1 || images.length)) errors.push('TikTok requires exactly one video. Photo posts are not supported by this browser workflow.');
  const account = accounts.find((a) => a.id === post.accountId);
  if (account && assets.some((a) => a && account.capabilities?.socialMediaTypes && !account.capabilities.socialMediaTypes.includes(a.mime.startsWith('video/') ? 'video' : 'image'))) errors.push(`${p.name}: connected account cannot publish this media type.`);
  return errors;
}
export function localSchedule(value = new Date(Date.now() + 3600000)) {
  const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function zonedISO(value, zone) {
  const parts = value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/);
  if (!parts) throw new Error('Choose a complete date and time.');
  const target = parts.slice(1).map(Number); const utc = Date.UTC(target[0], target[1] - 1, target[2], target[3], target[4]); let guess = utc;
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let n = 0; n < 4; n++) { const p = Object.fromEntries(format.formatToParts(new Date(guess)).filter((v) => v.type !== 'literal').map((v) => [v.type, Number(v.value)])); const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess; guess = utc - offset; }
  const check = Object.fromEntries(format.formatToParts(new Date(guess)).filter((v) => v.type !== 'literal').map((v) => [v.type, Number(v.value)]));
  if ([check.year, check.month, check.day, check.hour, check.minute].some((v, i) => v !== target[i])) throw new Error('This time does not exist in the selected time zone. Choose another time.');
  return new Date(guess).toISOString();
}
export function scheduleInZone(value, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function draftStatus(draft, actions) {
  const rows = actions.filter((action) => draft.actionIds?.includes(action.id)); if (!rows.length) return draft.status;
  if (rows.some((a) => ['uncertain', 'review', 'reconciling'].includes(a.state))) return 'review';
  if (rows.some((a) => a.state === 'executing')) return 'executing';
  if (rows.some((a) => a.state === 'awaiting_approval')) return 'awaiting_approval';
  if (rows.some((a) => ['scheduled', 'claimed', 'retryable'].includes(a.state))) return 'scheduled';
  if (rows.every((a) => a.state === 'succeeded')) return 'succeeded';
  if (rows.every((a) => a.state === 'cancelled')) return 'cancelled';
  if (rows.some((a) => a.state === 'failed')) return 'failed'; return 'completed';
}
