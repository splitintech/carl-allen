import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { WorkPackageManifest, sha256Hex, type HtmlImportAction, type WorkManifest, type WorkPackageIssue } from '@splitin/outreach-contracts';
import { parseHtmlTable, textOf, selectAll } from './html';
import { extractHtmlActions } from './html-actions';
import { inferContactManifest, reportName } from './work-package-infer';
type Node = DefaultTreeAdapterMap['node'];
export interface WorkPackageExtraction { manifest: WorkManifest | null; issues: WorkPackageIssue[]; actions: HtmlImportAction[]; tables: Record<string,string>[][]; text: string; sourceHash: string }
/** parse5 never executes code or fetches resources. The one JSON script is read strictly as data. */
export function extractWorkPackage(html: string): WorkPackageExtraction {
 if(Buffer.byteLength(html,'utf8')>20*1024*1024)throw new Error('HTML exceeds 20 MiB');
 const root=parse(html);const manifests:string[]=[];let count=0;
 const walk=(n:Node,depth:number):void=>{if(depth>128||++count>100_000)throw new Error('HTML complexity limit exceeded');
  if('tagName' in n&&n.tagName==='script'&&n.attrs.some(a=>a.name==='id'&&a.value==='carl-allen-manifest')) {
   if(!n.attrs.some(a=>a.name==='type'&&a.value==='application/json'))throw new Error('Manifest must be application/json');
   manifests.push(n.childNodes.map(x=>'value' in x?x.value:'').join(''));
  }if('childNodes' in n)for(const child of n.childNodes)walk(child,depth+1);
 };walk(root,0);
 if(manifests.length>1)throw new Error('More than one Carl-Allen manifest');
 const issues:WorkPackageIssue[]=[];const actions=extractHtmlActions(root,issues);let manifest:WorkManifest|null=null;
 if(manifests.length){try{const result=WorkPackageManifest.safeParse(JSON.parse(manifests[0]!));if(result.success)manifest=result.data;else issues.push(...result.error.issues.map(i=>({field:i.path.join('.'),message:i.message})));}catch{issues.push({field:'manifest',message:'Invalid manifest JSON'});}}
 else {
  manifest=inferContactManifest(root,html,issues);
  if(!manifest&&actions.some(action=>action.kind!=='unsupported')) {
   manifest=WorkPackageManifest.parse({schemaVersion:1,packageId:'report-'+sha256Hex(html).slice(0,32),revision:1,name:reportName(root)});
   issues.push({field:'html.actions',message:'Imported links are available for manual navigation and email composition. No outreach was scheduled.',severity:'info'});
  }
  if(!manifest)issues.push({field:'manifest',message:'Map this report into a Carl-Allen manifest before scheduling',severity:'error'});
 }
 const tables=selectAll(root,'table').slice(0,20).map((_,i)=>parseHtmlTable(html,i,10_000).map(row=>({...row.values})));
 return {manifest,issues,actions,tables,text:textOf(root).slice(0,100_000),sourceHash:sha256Hex(html)};
}
export function workPackageTemplate():string {
 const sample:WorkManifest=WorkPackageManifest.parse({schemaVersion:1,packageId:'my-monthly-plan',revision:1,name:'Monthly publishing plan',timezone:'America/New_York',accountRefs:[{id:'linkedin-main',channel:'linkedin',label:'Choose my LinkedIn account'}],publishingPlans:[{id:'post-1',accountRef:'linkedin-main',channel:'linkedin',text:'Replace this with the approved caption.',scheduledFor:new Date(Date.now()+86400000).toISOString(),media:[],format:'feed',tags:[]} ]});
 const data=JSON.stringify(sample,null,2).replace(/</g,'\\u003c');
 return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Carl-Allen work package</title><body><h1>Monthly publishing plan</h1><p>Research in Papr or ChatGPT. Edit the JSON manifest. Upload this HTML and its media to Carl-Allen for mapping and review. Uploading never authorizes sending.</p><script type="application/json" id="carl-allen-manifest">'+data+'</script></body></html>';
}
