/** Formats implemented by the native browser drivers. Feed keeps the platform's native default. */
export const PUBLISHING_FORMATS = {
 linkedin:['feed','carousel','video'], x:['feed','carousel','video'],
 instagram:['feed','carousel','video','reel'], tiktok:['feed','video'],
} as const;
export type PublishingFormat = 'feed'|'carousel'|'video'|'reel';
export type PublishingPlatform = keyof typeof PUBLISHING_FORMATS;
/** Shared preparation/execution validation; account and native UI qualification remain separate. */
export function publishingFormatIssues(channel:string,format:PublishingFormat|undefined,mediaMimeTypes:readonly string[]):string[]{
 if(!(channel in PUBLISHING_FORMATS))return['Unknown publishing platform'];
 const chosen=format??'feed';const supported:readonly string[]=PUBLISHING_FORMATS[channel as PublishingPlatform];
 if(!supported.includes(chosen))return[`${chosen} publishing is not supported on ${channel}`];
 const videos=mediaMimeTypes.filter(t=>t.startsWith('video/'));const images=mediaMimeTypes.filter(t=>t.startsWith('image/'));
 if(chosen==='carousel'&&(images.length<2||images.length!==mediaMimeTypes.length))return['A carousel requires at least two images and cannot contain video'];
 if((chosen==='video'||chosen==='reel')&&(videos.length!==1||mediaMimeTypes.length!==1||videos[0]!=='video/mp4'))return[`${chosen} publishing requires exactly one MP4 video`];
 return[];
}

export const PUBLISHING_CAPABILITIES = {
 linkedin:{text:3000,images:20,videos:1,mediaRequired:false,formats:PUBLISHING_FORMATS.linkedin},
 x:{text:280,images:4,videos:1,mediaRequired:false,formats:PUBLISHING_FORMATS.x},
 instagram:{text:2200,images:10,videos:1,mediaRequired:true,formats:PUBLISHING_FORMATS.instagram},
 tiktok:{text:2200,images:0,videos:1,mediaRequired:true,formats:PUBLISHING_FORMATS.tiktok},
} as const;
