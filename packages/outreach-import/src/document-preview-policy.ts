import { createHash } from 'node:crypto';

export const HTML_DOCUMENT_PREVIEW_MESSAGE_TYPE = 'carl-allen-document-action';
export const HTML_DOCUMENT_PREVIEW_READY_MESSAGE_TYPE = 'carl-allen-document-ready';
/** Fixed product-owned bridge. Uploaded scripts and handlers never become part of this code. */
export const HTML_DOCUMENT_PREVIEW_BRIDGE = `(()=>{
const hash=document.documentElement.getAttribute('data-carl-preview-source-hash');
function select(event){
 const element=event.target instanceof Element?event.target.closest('[data-carl-trigger-id]'):null;
 if(!element)return;
 event.preventDefault();event.stopPropagation();
 const actionId=element.getAttribute('data-carl-trigger-id');
 if(/^[a-f0-9]{64}$/.test(hash||'')&&/^html-action-[0-9]+$/.test(actionId||''))parent.postMessage({type:'carl-allen-document-action',sourceHash:hash,actionId},'*');
}
document.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a,area,button,input[type=submit],input[type=image]'))event.preventDefault();select(event);},true);
document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target instanceof Element&&event.target.closest('[data-carl-trigger-id]'))select(event);},true);
document.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();},true);
function ready(){if(/^[a-f0-9]{64}$/.test(hash||''))parent.postMessage({type:'carl-allen-document-ready',sourceHash:hash},'*');}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();`;
export const HTML_DOCUMENT_PREVIEW_SCRIPT_HASH = `sha256-${createHash('sha256').update(HTML_DOCUMENT_PREVIEW_BRIDGE).digest('base64')}`;
export const HTML_DOCUMENT_PREVIEW_CSP = `default-src 'none'; script-src '${HTML_DOCUMENT_PREVIEW_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
export const HTML_DOCUMENT_PREVIEW_STYLES = ':where(a[data-carl-trigger-id]){cursor:pointer;text-decoration:underline;color:LinkText}:where([data-carl-trigger-id]):focus-visible{outline:2px solid currentColor;outline-offset:3px}';

export interface HtmlPreviewOmission { kind: string; count: number; message: string }
export const PREVIEW_OMISSION_MESSAGES: Record<string, string> = {
  scripts: 'Uploaded scripts and event handlers are inert. Supported triggers remain in the sidebar.',
  resources: 'External or unsupported images, stylesheets, fonts, and other resources are not loaded.',
  embedded: 'Embedded documents, generated content, and unsupported markup are omitted.',
  navigation: 'Original navigation and form submission are disabled in the document view.',
  styles: 'Unsafe, unsupported, or overly complex style rules are omitted; layout may differ.',
};
