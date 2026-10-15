import * as XLSX from 'xlsx';
import {APP_VERSION} from '../version';
import type {AccountDetailWorkbookPlan, LeadcodeWorksheetPlan} from '../output/workbookContract';
import {OUTPUT_CONTRACT} from '../output/workbookContract';
import {GenerationError} from '../output/generationEligibility';
import {fromCents, toCents} from '../utils/money';
import {validateGenerationPlan,assertGenerationCounts} from '../output/generationIntegrity';
import {finishWorkpaperPackage} from './workpaperPackage';
import type {SheetPresentation,NativeTable} from './workpaperPackage';
import {dateFromCell,normalizedHeader} from '../utils/workbookValues';
import type {SourceFieldValue} from '../models/generalLedger';

export const OUTPUT_LIMITS = {rows:1_048_576, columns:16_384, text:32_767, cells:5_000_000} as const;
export const MONEY_FORMAT='#,##0.00;(#,##0.00);"-"';
const MONEY=MONEY_FORMAT;
const TB_MONEY='$#,##0.00;($#,##0.00);"-"';
type Value=string|number|boolean|null|undefined|XLSX.CellObject;
const amount=(value:number|undefined, unavailable=false):Value => value===undefined ? (unavailable?'Unavailable':undefined) : {t:'n',v:fromCents(toCents(value)),z:MONEY};
function periodLabel(value:string|undefined){
  if(!value)return 'Period end unavailable';
  const date=/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(`${value}T00:00:00.000Z`):undefined;
  return date&&Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',day:'numeric',year:'numeric'}).format(date):value;
}
function tableLabels(labels:readonly string[]){const used=new Set<string>();return labels.map(label=>{let value=label,i=1;while(used.has(value.toLowerCase()))value=`${label} [${++i}]`;used.add(value.toLowerCase());return value;});}
/** UTC calendar dates: Excel's 1900 date system, including its historical leap-day offset. */
export function excelDate(value:string|undefined):Value {
  if(value===undefined)return undefined;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new GenerationError('A transaction date is not a valid calendar date.');
  const date=new Date(`${value}T00:00:00.000Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value||value<'1900-01-01'||value>'9999-12-31')throw new GenerationError('A transaction date is outside the supported Excel calendar.');
  const days=(date.getTime()-Date.UTC(1899,11,31))/86_400_000;
  return {t:'n',v:days+(value>='1900-03-01'?1:0),z:'mm/dd/yyyy'};
}
export function validateOutputDimensions(rows:number,columns:number,cells:number) {
  if(rows>OUTPUT_LIMITS.rows||columns>OUTPUT_LIMITS.columns)throw new GenerationError('The selected output exceeds Excel worksheet limits. Select fewer leadcodes or reduce source columns.');
  if(cells>OUTPUT_LIMITS.cells)throw new GenerationError('The selected output is too large for this browser generation limit. Generate smaller groups of leadcodes.');
}
function checkValue(value:Value) {
  const v=typeof value==='object'&&value!==null?value.v:value;
  if(typeof v==='string'&&v.length>OUTPUT_LIMITS.text)throw new GenerationError('A source value exceeds Excel’s cell text limit. Shorten it in a working copy of the source export.');
  if(typeof v==='number'&&!Number.isFinite(v))throw new GenerationError('A source value is not a finite number. Review the export.');
}
/** All text is literal text, including strings beginning with =, +, - or @. */
function sheetBuilder() {
  const sheet:XLSX.WorkSheet={},columns:string[]=[];
  const heights:XLSX.RowInfo[]=[];
  let row=0,width=1;
  return {sheet, add(values:readonly Value[],height=18) {
    heights[row]={hpt:height};
    for(let c=0;c<values.length;c++) {
      const value=values[c];checkValue(value);
      if(value===undefined||value===null)continue;
      columns[c]??=XLSX.utils.encode_col(c);
      const cell:XLSX.CellObject=typeof value==='object'?value:typeof value==='number'?{t:'n',v:value}:typeof value==='boolean'?{t:'b',v:value}:{t:'s',v:value};
      sheet[`${columns[c]}${row+1}`]=cell;
    }
    width=Math.max(width,values.length);row++;
  }, get row(){return row;}, finish(widths:number[],hiddenColumns:readonly number[]=[]) {
    sheet['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,row-1),c:width-1}});
    const hidden=new Set(hiddenColumns);
    sheet['!cols']=Array.from({length:width},(_,i)=>({wch:widths[i]??24,hidden:hidden.has(i)}));
    sheet['!rows']=heights;
    return sheet;
  }};
}
function leadcodeRows(s:LeadcodeWorksheetPlan) {return 1+s.transactions.length;}
function sourceWidth(label:string) {
  const value=normalizedHeader(label);
  if(/date|period/.test(value))return 14;
  if(/debit|credit|amount|balance/.test(value))return 17;
  if(/description|memo|remark/.test(value))return 48;
  if(/payee|payer|person|name/.test(value))return 30;
  if(/reference|control|ledger id|document|doc|number|num/.test(value))return 20;
  if(/type|journal|jnl/.test(value))return 18;
  return 22;
}
function sourceValue(label:string,value:SourceFieldValue|undefined):Value {
  const normalized=normalizedHeader(label);
  if(typeof value==='string'&&/(?:^| )(?:date|dt\.)(?:$| )/.test(normalized)){
    const date=dateFromCell({value});if(date)return excelDate(date);
  }
  return typeof value==='number'&&/debit|credit|amount|balance/.test(normalized)?amount(value):value;
}
/** Values-only serialization. No formulas, macros, external links or application persistence. */
export function serializeWorkbook(plan:AccountDetailWorkbookPlan):ArrayBuffer {
  const expected=validateGenerationPlan(plan),written={sheets:1,leadcodes:0,accounts:0,transactions:0};
  let cells=(20+plan.summary.length*6)*3;
  for(const s of plan.leadcodeSheets){const cols=12+s.additionalSourceColumns.length,rows=leadcodeRows(s);cells+=rows*cols;validateOutputDimensions(rows,cols,cells);}
  validateOutputDimensions(20+plan.summary.length*6,3,cells);
  const presentations:SheetPresentation[]=[];
  const workbook=XLSX.utils.book_new(),b=sheetBuilder(),meta=plan.metadata;
  const summaryStyle={titleRows:[1],sectionRows:[] as number[],headerRows:[] as number[],summaryBoxRows:[] as number[],warningRows:[] as number[],noteRows:[] as number[],totalRows:[] as number[],cellStyles:{} as Record<string,'label'|'warning'|'error'|'success'|'link'|'note'>,merges:[] as string[],tables:[] as NativeTable[]};
  b.add([meta?.displayEntity??meta?.tbContext?.entity?.value??'Client unavailable'],32);summaryStyle.merges.push('A1:C1');
  b.add([`Account Detail — ${periodLabel(meta?.displayPeriodEnd??meta?.tbContext?.periodEnd?.value)}`],24);summaryStyle.noteRows.push(b.row);summaryStyle.merges.push('A2:C2');
  b.add([],18);
  const summaryHeader=b.row+1,summaryLabels=['Leadcode','Description','TB Balance'];
  b.add(summaryLabels,29);summaryStyle.headerRows.push(b.row);summaryStyle.summaryBoxRows.push(b.row);
  for(const r of plan.summary){
    b.add([r.leadcode,r.leadcodeDescription,{t:'n',v:fromCents(toCents(r.unadjustedTBBalance)),z:TB_MONEY}],31);summaryStyle.summaryBoxRows.push(b.row);
  }
  b.add([],24);b.add(['Items to Review'],27);summaryStyle.sectionRows.push(b.row);summaryStyle.merges.push(`A${b.row}:C${b.row}`);
  let issues=0;
  const addIssue=(scope:string,issue:string,value:number,action:string)=>{const label=value===1?issue.replaceAll('accounts','account').replaceAll('leadcodes','leadcode'):issue;b.add([`${value.toLocaleString('en-US')} ${label} ${scope}; ${action}`],37);summaryStyle.warningRows.push(b.row);summaryStyle.merges.push(`A${b.row}:C${b.row}`);issues++;};
  for(const r of plan.summary){
    if(r.unmatchedAccountCount)addIssue(`in leadcode ${r.leadcode}`,'unmatched TB accounts',r.unmatchedAccountCount,'GL detail and balance validation are unavailable for these accounts.');
    const otherUnavailable=Math.max(0,(r.balanceUnavailableCount??0)-r.unmatchedAccountCount);
    if(otherUnavailable)addIssue(`in leadcode ${r.leadcode}`,'matched accounts without reliable GL balance validation',otherUnavailable,'review the source GL balance controls.');
    if(r.balanceDifferenceCount)addIssue(`in leadcode ${r.leadcode}`,'GL balances differ from Unadjusted TB',r.balanceDifferenceCount,'review the account-level GL and TB balances.');
    if(r.noActivityAccountCount)addIssue(`in leadcode ${r.leadcode}`,'matched accounts with no GL transactions',r.noActivityAccountCount,'confirm that no activity is expected.');
    if(!r.transactionCount)addIssue(`in leadcode ${r.leadcode}`,'selected leadcodes with no matched GL transactions',1,'confirm the selection and account mappings.');
  }
  if(meta?.glOnlyAccountCount)addIssue('across the full GL; no leadcode assignment has been verified','GL-only accounts',meta.glOnlyAccountCount,'review accounts outside the uploaded TB.');
  if(!issues){b.add(['No actionable mapping or balance exceptions identified.'],30);summaryStyle.noteRows.push(b.row);summaryStyle.merges.push(`A${b.row}:C${b.row}`);}
  b.add([],18);b.add(['TB Balance is unadjusted. A completed GL-to-TB reconciliation is not represented where GL balance validation is unavailable.'],36);summaryStyle.noteRows.push(b.row);summaryStyle.merges.push(`A${b.row}:C${b.row}`);
  XLSX.utils.book_append_sheet(workbook,b.finish([21,39,24]),'Summary');
  presentations.push({...summaryStyle,name:'Summary',rows:b.row,columns:3,freezeRows:0,freezeColumns:0,printHeader:summaryHeader,printColumns:3});
  for(const s of plan.leadcodeSheets){const a=sheetBuilder();
    const style={titleRows:[] as number[],sectionRows:[] as number[],headerRows:[] as number[],warningRows:[] as number[],noteRows:[] as number[],totalRows:[] as number[],cellStyles:{} as Record<string,'label'|'warning'|'error'|'success'|'note'>,merges:[] as string[],tables:[] as NativeTable[]};
    const labels=tableLabels([...OUTPUT_CONTRACT.transactionColumns,...s.additionalSourceColumns,...OUTPUT_CONTRACT.sourceRowTraceability]);
    const header=a.row+1;a.add(labels,30);style.headerRows.push(a.row);style.tables.push({name:`TransactionDetail_${presentations.length}`,header,count:s.transactions.length,labels});
    const transitionRows:number[]=[];let priorAccount:string|undefined;
    for(const t of s.transactions){if(priorAccount!==undefined&&priorAccount!==t.accountNumber)transitionRows.push(a.row+1);priorAccount=t.accountNumber;
      a.add([t.accountNumber,t.accountDescription,excelDate(t.transactionDate),t.reference,t.payeeOrName,t.description,amount(t.debit),amount(t.credit),amount(t.runningBalance),...s.additionalSourceColumns.map(k=>sourceValue(k,t.sourceFields[k])),t.sourceFormat,t.sourceSheetName,t.sourceRowNumber],Math.min(48,Math.max(28,Math.ceil((t.description?.length??0)/58)*14)));written.transactions++;}
    const hidden=Array.from({length:s.additionalSourceColumns.length+3},(_,index)=>OUTPUT_CONTRACT.transactionColumns.length+index);
    const widths=[19,39,15,19,29,55,17,17,17,...s.additionalSourceColumns.map(sourceWidth),14,24,14];
    const memoColumns=['B','E','F',...s.additionalSourceColumns.flatMap((label,index)=>/description|memo|remark|payee|payer|person|name/.test(normalizedHeader(label))?[XLSX.utils.encode_col(index+OUTPUT_CONTRACT.transactionColumns.length)]:[])];
    XLSX.utils.book_append_sheet(workbook,a.finish(widths,hidden),s.sheetName);
    presentations.push({...style,name:s.sheetName,rows:a.row,columns:labels.length,freezeRows:1,freezeColumns:0,printHeader:1,printColumns:9,representedAccounts:s.accounts.length,transactions:{start:2,count:s.transactions.length},transactionRequiredColumns:[0,1,labels.length-3,labels.length-2,labels.length-1],memoColumns,transitionRows});written.accounts+=s.accounts.length;written.sheets++;written.leadcodes++;
  }
  workbook.Props={Title:'Account Detail Workbook',Author:'Carter & Company',Subject:'Account detail export'};
  assertGenerationCounts(expected,written);
  workbook.Custprops={'Application Version':meta?.applicationVersion??APP_VERSION};
  return finishWorkpaperPackage(XLSX.write(workbook,{type:'array',bookType:'xlsx',compression:true}) as ArrayBuffer,presentations,expected);
}
