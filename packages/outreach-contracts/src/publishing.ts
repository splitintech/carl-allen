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

/** Conservative supported workflow caps; native account qualification is still required. */
export const FIRST_COMMENT_LIMITS = {linkedin:1000,instagram:2200} as const;
export function firstCommentIssues(channel:string,text:string|undefined):string[]{
 if(text===undefined||text==='')return[];
 if(!(channel in FIRST_COMMENT_LIMITS))return['First comments are supported only on LinkedIn and Instagram'];
 const maximum=FIRST_COMMENT_LIMITS[channel as keyof typeof FIRST_COMMENT_LIMITS];
 return !text.trim()?[`First comment must contain text`]:text.length>maximum?[`First comment exceeds the ${channel} workflow limit of ${maximum} characters`]:[];
}
export const VIDEO_WORKFLOW_LIMITS = {
 linkedin:{minSeconds:3,maxSeconds:900,minDimension:256,maxWidth:4096,maxHeight:4096,minFps:1,maxFps:60},
 x:{minSeconds:0.5,maxSeconds:140,minDimension:32,maxWidth:1920,maxHeight:1920,minFps:1,maxFps:60},
 instagram:{minSeconds:3,maxSeconds:900,minDimension:320,maxWidth:1920,maxHeight:4096,minFps:23,maxFps:60},
 tiktok:{minSeconds:3,maxSeconds:180,minDimension:720,maxWidth:4096,maxHeight:4096,minFps:23,maxFps:60},
} as const;
export function publishingVideoIssues(channel:string,video:import('./media-probe').VideoMetadata):string[]{
 if(!(channel in VIDEO_WORKFLOW_LIMITS))return['Unknown video publishing platform'];
 const limit=VIDEO_WORKFLOW_LIMITS[channel as PublishingPlatform];const issues:string[]=[];
 if(video.videoCodec!=='h264'||video.pixelFormat!=='yuv420p')issues.push('Re-export video as MP4 / H.264 with 8-bit yuv420p pixels. No automatic conversion has been applied.');
 if(video.audioCodecs.length>1||video.audioCodecs.some(codec=>codec!=='aac'))issues.push('Re-export with at most one AAC audio track, or no audio.');
 if(!Number.isFinite(video.durationSeconds)||video.durationSeconds<limit.minSeconds||video.durationSeconds>limit.maxSeconds)issues.push(`${channel} workflow video duration must be ${limit.minSeconds}–${limit.maxSeconds} seconds.`);
 if(!Number.isInteger(video.width)||!Number.isInteger(video.height)||video.width<limit.minDimension||video.height<limit.minDimension||video.width>limit.maxWidth||video.height>limit.maxHeight||video.width%2||video.height%2)issues.push(`${channel} workflow needs even video dimensions, at least ${limit.minDimension}px per side and at most ${limit.maxWidth}×${limit.maxHeight}px.`);
 if(!Number.isFinite(video.frameRate)||video.frameRate<limit.minFps||video.frameRate>limit.maxFps)issues.push(`${channel} workflow video frame rate must be ${limit.minFps}–${limit.maxFps} FPS.`);
 return issues;
}
