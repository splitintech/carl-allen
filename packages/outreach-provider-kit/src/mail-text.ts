/** Extract display/search text only. Never renders HTML or loads its links and resources. */
export function plainMailText(content:string,type='html'):string {
 let text=content.slice(0,1024*1024);
 if(type.toLowerCase()!=='text'&&type.toLowerCase()!=='text/plain'){
  text=text.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<(?:br\s*\/?|\/(?:p|div|li|tr|h[1-6]))\s*>/gi,'\n').replace(/<[^>]*>/g,'');
  const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  text=text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_match,entity:string)=>{if(entity[0]!=='#')return named[entity.toLowerCase()]??'';const n=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);return n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'\uFFFD';});
 }
 return text.replace(/\r\n?/g,'\n').replace(/[\t ]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim().slice(0,10000);
}
