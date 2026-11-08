import { spawnSync } from 'node:child_process';
export interface VideoMetadata { durationSeconds:number; width:number; height:number; videoCodec:string; audioCodecs:string[]; frameRate:number; pixelFormat:string }
interface Stream { codec_type?:string; codec_name?:string; width?:number; height?:number; duration?:string; avg_frame_rate?:string; pix_fmt?:string }
/** Local bytes only: pipe protocol disallows input references to network or filesystem resources. */
export function probeVideoBytes(bytes:Uint8Array):VideoMetadata {
  if(bytes.byteLength<12||bytes.byteLength>100*1024*1024)throw new Error('Video must be a valid file no larger than 100 MB');
  const probe=spawnSync(process.env.OUTREACH_FFPROBE_PATH??'ffprobe',['-v','error','-protocol_whitelist','pipe','-show_entries','stream=codec_type,codec_name,width,height,duration,avg_frame_rate,pix_fmt:format=duration,format_name','-of','json','-i','pipe:0'],{input:bytes,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true});
  // A clean metadata probe may close stdin early; Node reports EPIPE for the unwritten tail.
  if(probe.error&&!(probe.status===0&&(probe.error as NodeJS.ErrnoException).code==='EPIPE')){if((probe.error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('Video inspection is unavailable. Install ffprobe on the server or configure OUTREACH_FFPROBE_PATH before review or execution.');throw new Error('Video inspection timed out or could not start. Re-export a standard MP4 and retry inspection.');}
  if(probe.status!==0)throw new Error('Video inspection failed. Re-export a valid MP4 with H.264 video and AAC audio; the uploaded file has not been changed.');
  let report:{streams?:Stream[];format?:{duration?:string;format_name?:string}};try{report=JSON.parse(probe.stdout) as typeof report;}catch{throw new Error('Video inspection returned invalid metadata. Ask an administrator to check ffprobe.');}
  const video=report.streams?.filter(stream=>stream.codec_type==='video')??[];
  if(video.length!==1||!report.format?.format_name?.split(',').includes('mp4'))throw new Error('Use an MP4 with exactly one video stream. Other containers and multiple video tracks need a reviewed re-export.');
  const stream=video[0]!;const ratio=stream.avg_frame_rate?.split('/').map(Number)??[];const frameRate=ratio.length===2?ratio[0]!/ratio[1]!:Number(stream.avg_frame_rate);
  return {durationSeconds:Number(stream.duration??report.format.duration),width:Number(stream.width),height:Number(stream.height),videoCodec:stream.codec_name??'',audioCodecs:(report.streams??[]).filter(s=>s.codec_type==='audio').map(s=>s.codec_name??''),frameRate,pixelFormat:stream.pix_fmt??''};
}
