import {outputFileName} from '../output/fileName';
/** Returns a disposer for Reset/page hide; the temporary URL is also automatically revoked. */
export function downloadWorkbook(bytes:ArrayBuffer,_generatedAt:string,context?:{entity?:string;periodEnd?:string}):()=>void {
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  let timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;clearTimeout(timer);URL.revokeObjectURL(url);};
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=outputFileName(context);anchor.hidden=true;
  try{document.body.append(anchor);anchor.click();timer=setTimeout(dispose,1000);}catch(error){dispose();throw error;}finally{anchor.remove();}
  return dispose;
}
