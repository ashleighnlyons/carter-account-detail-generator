/** Presentation aliases only. Original leadcodes never change. */
export function allocateSheetNames(codes:readonly string[]) {
  const used=new Set(['summary','history']),result=new Map<string,string>();
  const shorten=(value:string,length:number)=>{let text='';for(const char of value){if(text.length+char.length>length)break;text+=char;}return text;};
  for(const code of codes){
    const base=code.replace(/[\[\]:*?\/\\\u0000-\u001f]/g,'_').trim().replace(/^'+|'+$/g,'')||'Leadcode';
    let name=shorten(base,31),suffix=1;
    while(used.has(name.toLowerCase())){const end=`_${++suffix}`;name=shorten(base,31-end.length)+end;}
    used.add(name.toLowerCase());result.set(code,name);
  }
  return result;
}
export function compareText(a:string,b:string){return a<b?-1:a>b?1:0;}
