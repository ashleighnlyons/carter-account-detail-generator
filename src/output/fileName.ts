/** Presentation only. Never infer context from uploaded filenames or transaction names. */
export function outputFileName(context?:{entity?:string;periodEnd?:string}):string {
  if(!context?.entity||!context.periodEnd||!/^\d{4}-\d{2}-\d{2}$/.test(context.periodEnd))return 'Account Detail Workbook.xlsx';
  const clean=(value:string)=>value.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').trim().replace(/[. ]+$/,'');
  const entity=clean(context.entity),period=clean(context.periodEnd);if(!entity||!period)return 'Account Detail Workbook.xlsx';
  const prefix='Account Detail - ',suffix=` - ${period}`;let shortened=entity;
  while(prefix.length+shortened.length+suffix.length>180)shortened=Array.from(shortened).slice(0,-1).join('');
  const base=prefix+shortened+suffix;
  return `${base}.xlsx`;
}
