import { execFileSync } from 'node:child_process';
/** Actual synthetic H.264 MP4; no user media and no validation bypass. */
export function syntheticVideoBytes():Buffer {
 return execFileSync(process.env.OUTREACH_FFMPEG_PATH??'ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=720x1280:r=25:d=3','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-an','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{timeout:30000,maxBuffer:5*1024*1024});
}
