/* global crypto, sessionStorage, btoa */
export function createUploader({api,readBytes,rememberPreview}) {
return async function upload(file, onProgress, signal = {}) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];
  if (!allowed.includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP, MP4 file.');
  const max = file.type.startsWith('video/') ? 100 * 1048576 : 5 * 1048576;
  if (!file.size || file.size > max) throw new Error(`${file.name}: composer uploads support images up to 5 MB and videos up to 100 MB.`);
  const cancelled=()=>Boolean(signal.cancelled||signal.aborted);if(cancelled())throw new Error('Upload cancelled.');
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await readBytes(file))),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(cancelled())throw new Error('Upload cancelled.');
  const key='carl-upload:v1:'+sha256;const saved=(()=>{try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}})();
  const remember=value=>{try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch{/* Server hash idempotency still permits recovery when browser storage is unavailable. */}};
  let progress;let uploadId;
  try {
    if(saved?.uploadId&&saved.sha256===sha256&&saved.size===file.size&&saved.mime===file.type){
      uploadId=saved.uploadId;
      try{progress=await api('publishing-upload-status',{uploadId});}catch(error){if(/not found|upload expired/i.test(error.message)){remember(null);uploadId=undefined;}else throw error;}
      if(progress&&(progress.expectedSha256!==sha256||progress.size!==file.size||progress.mime!==file.type))throw new Error('The resumed upload belongs to different bytes or media. Cancel it before trying again.');
    }
    if(!uploadId){progress=await api('publishing-upload-start',{input:{name:file.name,mime:file.type,size:file.size,sha256}});uploadId=progress.uploadId;remember({uploadId,sha256,size:file.size,mime:file.type});}
    const chunkBytes=progress.chunkBytes??65536;let offset=progress.receivedBytes??0;let index=progress.nextIndex??0;
    if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>65536||!Number.isSafeInteger(offset)||offset<0||offset>file.size||!Number.isSafeInteger(index)||index<0||(offset<file.size&&offset!==index*chunkBytes))throw new Error('The server returned an invalid upload offset. Cancel this upload and try again.');
    onProgress(offset,file.size);
    for(;offset<file.size;index++){
      if(cancelled())throw new Error('Upload cancelled.');
      const bytes=await readBytes(file.slice(offset,offset+chunkBytes));let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);
      await api('publishing-upload-chunk',{uploadId,index,data:btoa(raw)});offset+=bytes.length;onProgress(offset,file.size);
    }
    if(cancelled())throw new Error('Upload cancelled.');
    const asset=progress.state==='complete'&&progress.asset?progress.asset:(await api('publishing-upload-complete',{uploadId})).asset;
    if(!asset||asset.sha256!==sha256||asset.size!==file.size||asset.mime!==file.type)throw new Error('Final upload checksum or metadata differs from the selected file. The file was not attached.');
    remember(null);rememberPreview(asset.id,file);return asset;
  } catch(error){
    if(cancelled()&&uploadId){await api('publishing-upload-cancel',{uploadId}).then(()=>remember(null)).catch(()=>{});throw new Error('Upload cancelled.');}
    if(uploadId)throw new Error(`${error.message} Select this same file again to resume the upload.`);
    throw error;
  }
};
}
