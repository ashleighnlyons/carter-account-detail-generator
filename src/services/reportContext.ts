import type {ParserWorkbook,WorkbookCell,WorkbookRow} from '../models/workbook';
import type {ContextEvidence,ReportContext} from '../models/reportContext';
import type {SessionState} from './sessionState';

function text(cell:WorkbookCell|undefined){return !cell||cell.formula||cell.error?'':String(cell.value??'').trim();}
/** Explicit four-digit dates or a validated Excel calendar value; never a filename/export timestamp. */
function date(cell:WorkbookCell|undefined):string|undefined {
  if(!cell||cell.formula||cell.error)return undefined;
  const input=cell.dateValue??text(cell),iso=/^\d{4}-\d{2}-\d{2}$/.test(input)?input:input.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,(_full,m,d,y)=>`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return undefined;
  const d=new Date(`${iso}T00:00:00Z`);return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===iso?iso:undefined;
}
const months:Record<string,string>={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
function range(value:string):[string,string]|undefined {
  const numeric=/^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\s*(?:to|-)\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})(?:\s+\([^)]*\))?$/i.exec(value);
  if(numeric){const start=date({value:numeric[1]}),end=date({value:numeric[2]});return start&&end&&start<=end?[start,end]:undefined;}
  const monthly=/^([A-Za-z]{3})\s+(\d{4})\s*-\s*([A-Za-z]{3})\s+(\d{4})$/.exec(value);
  if(monthly&&months[monthly[1].toLowerCase()]&&months[monthly[3].toLowerCase()]){
    const start=`${monthly[2]}-${months[monthly[1].toLowerCase()]}-01`,endDate=new Date(Date.UTC(Number(monthly[4]),Number(months[monthly[3].toLowerCase()]),0)),end=endDate.toISOString().slice(0,10);
    return start<=end?[start,end]:undefined;
  }
}
/** Header metadata only; all account/transaction parsing stays in the existing parsers. */
export function extractReportContext(book:ParserWorkbook,sheetName:string|undefined,headerRow:number|undefined,format:string):ReportContext|undefined {
  const sheet=book.sheets.find(s=>s.name===sheetName);if(!sheet)return undefined;
  const entities:NonNullable<ReportContext['entity']>[]=[],starts:ContextEvidence[]=[],ends:ContextEvidence[]=[],notes:string[]=[];
  const evidence=(value:string,label:string,row:WorkbookRow):ContextEvidence=>({value,label,sourceSheetName:sheet.name,sourceRowNumber:row.sourceRowNumber});
  const addRange=(value:string,label:string,row:WorkbookRow)=>{const pair=range(value);if(pair){starts.push(evidence(pair[0],label,row));ends.push(evidence(pair[1],label,row));}};
  const prefix=sheet.rows.filter(r=>r.sourceRowNumber<(headerRow??201)&&r.sourceRowNumber<=200);
  for(const row of prefix){
    const marker=text(row.cells[0]);
    for(let c=0;c<row.cells.length;c++){
      const raw=text(row.cells[c]);if(!raw)continue;
      const match=/^(Client|Company|Entity|Property|Portfolio|Portfolios|Period Ending|Period End|Date Range|Period|Reporting Period)\s*[:=]\s*(.*)$/i.exec(raw);
      if(!match)continue;const label=match[1],value=match[2]||text(row.cells[c+1]),lower=label.toLowerCase();if(!value)continue;
      if(['client','company','entity','property','portfolio','portfolios'].includes(lower)){
        if((lower==='portfolios'||lower==='portfolio')&&(value.toLowerCase()==='all'||/[;,]/.test(value)))continue;
        const kind=lower==='portfolios'?'portfolio':lower as NonNullable<ReportContext['entity']>['kind'];
        // CCH Client includes a report-assigned client ID before the explicit delimiter.
        const display=format==='published-cch'&&marker==='RPT_HEADERCLIENT'?value.replace(/^\d+\s+-\s+/,''):value;
        entities.push({...evidence(display,label,row),kind});
      }else if(lower==='period ending'||lower==='period end'){
        const d=match[2]?date({value}):date(row.cells[c+1]);if(d)ends.push(evidence(d,label,row));
      }else addRange(value,label,row);
    }
    // The inspected Yardi title explicitly identifies a single property, not a legal company.
    if(format==='yardi'&&row.sourceRowNumber===1){const populated=row.cells.map(text).filter(Boolean);if(populated.length===1){const m=/^(.+?)\s+\([A-Za-z0-9-]+\)$/.exec(populated[0]);if(m)entities.push({...evidence(m[1].trim(),'Property',row),kind:'property'});}}
    if(format==='vantaca'){const title=row.cells.map(text).find(v=>/^GL Trial Balance For /i.test(v));if(title)addRange(title.replace(/^GL Trial Balance For /i,''),'GL Trial Balance For',row);}
  }
  // Published current balance dates are tagged and tied to discovered UNADJ/FINAL headers.
  if(format==='published-cch'){
    const header=sheet.rows.find(r=>text(r.cells[0])==='Col_Header_1');
    if(header)for(const row of sheet.rows.filter(r=>text(r.cells[0])==='Col_Header_2'))for(const name of ['UNADJ','FINAL']){
      const col=header.cells.findIndex(c=>text(c)===name),d=col<0?undefined:date(row.cells[col]);if(d)ends.push(evidence(d,`${name} period`,row));
    }
  }
  function unique<T extends ContextEvidence>(items:T[],label:string){const values=new Set(items.map(i=>i.value));if(values.size>1){notes.push(`The ${label} labels conflict within this source. Confirm the report scope.`);return undefined;}return items[0];}
  const entity=unique(entities,'entity'),periodStart=unique(starts,'period start'),periodEnd=unique(ends,'period end');
  return entity||periodStart||periodEnd||notes.length?{entity,periodStart,periodEnd,notes}:undefined;
}
const comparable=(value:string)=>value.toLowerCase().replace(/[.,]/g,'').replace(/\s+/g,' ').trim();
export function assessReportContext(state:SessionState){
  const tb=state.trialBalance?.reportContext,gl=state.generalLedger?.sourceMetadata.reportContext,warnings=[...tb?.notes??[],...gl?.notes??[]];
  const entityConflict=!!tb?.entity&&!!gl?.entity&&comparable(tb.entity.value)!==comparable(gl.entity.value);
  const periodConflict=!!tb?.periodEnd&&!!gl?.periodEnd&&tb.periodEnd.value!==gl.periodEnd.value;
  if(entityConflict)warnings.push('The TB client/entity and GL scope names differ. Confirm that both files belong to the same engagement; property and legal entity names can differ.');
  if(periodConflict)warnings.push('The TB period end and GL reporting period differ. Confirm the intended period before using the workbook.');
  if(tb?.periodEnd&&!gl?.periodEnd&&state.generalLedger?.transactions.length){
    const year=tb.periodEnd.value.slice(0,4),dates=state.generalLedger.transactions.map(t=>t.transactionDate).filter((d):d is NonNullable<typeof d>=>!!d);
    if(dates.length&&dates.every(d=>d.slice(0,4)!==year))warnings.push('All GL transaction dates fall outside the TB period-end year. Confirm the reporting scope; dates alone do not establish a reporting period.');
  }
  const entity=!entityConflict&&!tb?.notes.length&&!gl?.notes.length?(tb?.entity??gl?.entity)?.value:undefined;
  const periodEnd=!periodConflict&&!tb?.notes.length&&!gl?.notes.length?(tb?.periodEnd??gl?.periodEnd)?.value:undefined;
  return {tb,gl,warnings,entity,periodEnd};
}
