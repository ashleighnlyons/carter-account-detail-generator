import type {ParserWorkbook, WorkbookSheet, WorkbookRow, WorkbookCell} from '../models/workbook';
import type {TBParseResult} from '../models/processing';
import type {ParserIssue} from './types';
import {TB_COLUMNS} from '../models/trialBalance';
import {cellAt, cellText, isBlankRow, normalizedHeader} from '../utils/workbookValues';
import {parseStandardizedTrialBalance} from './trialBalance';

const accountMarker = /^AD_\{(\d+)\}$/;
const subgroupMarker = /^SG_\{(\d+)\}$/;
const subgroupTotal = /^SG_\{(\d+)\}_T$/;
const groupMarker = /^(?:G|SB)_\{\d+\}$/;
const groupTotal = /^(?:G|SB)_\{\d+\}_T$/;
const spacerMarker = /^(?:SG|G|SB)_\{\d+\}_T_B$/;
// An account segment such as _X6600_ can be decoded from OOXML's _xHHHH_
// escape form into one BMP character before the parser sees the CCH marker.
const journalEntryMarker = /^\d+_(\d+)_(\d+)(?:_[^{}\r\n]+_|[\u0080-\uFFFF])JE_\{\d+\}$/u;
const subgroupCode = /^\s*Subgroup\s*:\s*\[([^\]]+)\]\s*$/i;
const names = ['account','description','unadj','final','1st pp final'];
function labels(row: WorkbookRow) {return row.cells.map(c=>normalizedHeader(cellText(c)));}
function columns(row: WorkbookRow) {const values=labels(row);return names.map(n=>values.indexOf(n));}
function header(row: WorkbookRow) {return row.cells.findIndex(c=>cellText(c)==='Col_Header_1');}

export interface PublishedCCHCandidate {readonly sheet: WorkbookSheet; readonly headerRow?: WorkbookRow; readonly markerColumn: number; readonly confidence: number; readonly reasons: readonly string[];}
/** Content only: marker families plus an account/description header and typed subgroup structure. */
export function detectPublishedCCH(workbook: ParserWorkbook): PublishedCCHCandidate[] {
  return workbook.sheets.map(sheet=>{
    const headerRow=sheet.rows.find(r=>header(r)>=0 && columns(r).slice(0,2).every(c=>c>=0));
    const markerColumn=headerRow?header(headerRow):-1, cols=headerRow?columns(headerRow):[];
    const marker=(row:WorkbookRow)=>cellText(cellAt(row,markerColumn));
    const subgroup=markerColumn>=0 && sheet.rows.some(r=>subgroupMarker.test(marker(r)) && subgroupCode.test(cellText(cellAt(r,cols[0]))));
    const posting=markerColumn>=0 && sheet.rows.some(r=>accountMarker.test(marker(r)));
    const metadata=markerColumn>=0 && sheet.rows.some(r=>marker(r)==='Col_Metadata_row_2' && cellText(cellAt(r,cols[0]))==='NameCol' && cellText(cellAt(r,cols[1]))==='DescCol');
    const report=markerColumn>=0 && sheet.rows.some(r=>/^RPT_(?:HEADER|CPE)/.test(marker(r)));
    const reasons=[headerRow?'CCH-tagged account/description header':'No CCH-tagged account header',subgroup?'Tagged subgroup with bracketed source code':'No valid tagged subgroup',posting?'Tagged posting-account rows':'No tagged posting accounts'];
    const confidence=headerRow && subgroup && posting ? Math.min(1,.4+.2+.2+(metadata ? .1 : 0)+(report ? .1 : 0)) : 0;
    return {sheet,headerRow,markerColumn,confidence,reasons};
  }).sort((a,b)=>b.confidence-a.confidence);
}

export function parsePublishedCCH(workbook: ParserWorkbook, candidate?: PublishedCCHCandidate): TBParseResult {
  const candidates=detectPublishedCCH(workbook).filter(c=>c.confidence>=.85);
  const selected=candidate??candidates[0];
  const errors:ParserIssue[]=[], warnings:ParserIssue[]=[], skippedRows:Record<string,number>={};
  const empty=(message:string,code='CCH_STRUCTURE_UNSUPPORTED'):TBParseResult=>({accounts:[],warnings,errors:[{code,message}],diagnostics:{accountCount:0,reviewedRows:[],format:'published-cch',confidence:selected?.confidence??0}});
  if(!selected?.headerRow || selected.confidence<.85)return empty('This workbook does not have enough structure to identify a supported CCH Published Leadcode Trial Balance. Export the original CCH report with its account, subgroup and balance columns intact.');
  if(candidates.length!==1)return empty('More than one CCH account table was found. Provide one trial balance report with a single accounting sheet.','CCH_MULTIPLE_TABLES');
  if(workbook.sheets.some(s=>s!==selected.sheet && s.rows.some(r=>r.cells.some(c=>accountMarker.test(cellText(c)) || subgroupMarker.test(cellText(c))))))return empty('Another worksheet contains CCH account/subgroup rows without a complete recognized table. Review the export and provide one complete accounting sheet.','CCH_PARTIAL_EXTRA_TABLE');
  const {sheet,headerRow,markerColumn}=selected, sourceColumns=columns(headerRow);
  const [accountCol,descriptionCol,unadjustedCol,finalCol,priorCol]=sourceColumns;
  const issue=(code:string,message:string,row?:WorkbookRow)=>({code,message,sourceSheetName:sheet.name,sourceRowNumber:row?.sourceRowNumber});
  const count=(kind:string)=>{skippedRows[kind]=(skippedRows[kind]??0)+1;};
  if(sourceColumns.some(c=>c<0) || names.some(n=>labels(headerRow).filter(v=>v===n).length!==1))return empty('The CCH report requires unique Account, Description, UNADJ, FINAL and 1st PP-FINAL columns. Export the complete report with all three balance types.','CCH_REQUIRED_COLUMNS');
  const projected:WorkbookRow[]=[{sourceRowNumber:headerRow.sourceRowNumber,cells:TB_COLUMNS.map(value=>({value}))}];
  let active:{id:string;code:WorkbookCell;description:WorkbookCell}|undefined;
  let activePostingAccountId:string|undefined;
  const reportValues=new Map<string,string>();
  for(const row of sheet.rows){
    const marker=cellText(cellAt(row,markerColumn));
    if(isBlankRow(row) && !row.cells.some(c=>c.formula)){count('blank');continue;}
    if(cellAt(row,markerColumn).formula || cellAt(row,markerColumn).error){errors.push(issue('CCH_MARKER_INVALID','A CCH structural row identifier contains a formula or Excel error. Export the original report with usable row identifiers.',row));active=undefined;activePostingAccountId=undefined;count('review');continue;}
    if(marker==='Col_Header_1'){
      count('columnHeader');
      if(columns(row).some((c,i)=>c!==sourceColumns[i]) || names.some(n=>labels(row).filter(v=>v===n).length!==1) || row.cells.some(c=>c.formula||c.error)){
        errors.push(issue('CCH_HEADER_CHANGED','The CCH account or balance columns changed or contain formulas/errors. Export one consistent report table.',row));active=undefined;activePostingAccountId=undefined;
      }continue;
    }
    if(/^RPT_/.test(marker)){
      if(/^RPT_FOOTER/.test(marker)){count('footer');active=undefined;activePostingAccountId=undefined;continue;}
      count('reportMetadata');const value=JSON.stringify(row.cells.map(c=>[c.value,c.formula,c.error]));
      if(reportValues.has(marker) && reportValues.get(marker)!==value){errors.push(issue('CCH_REPORT_SCOPE_CHANGED','Report information changes within the CCH table. Export one client, period and trial balance scope.',row));active=undefined;activePostingAccountId=undefined;}
      reportValues.set(marker,value);continue;
    }
    if(marker==='Col_Header_2'){
      count('periodHeader');const value=JSON.stringify(sourceColumns.slice(2).map(c=>cellAt(row,c).value));
      if(reportValues.has(marker) && reportValues.get(marker)!==value){errors.push(issue('CCH_PERIOD_CHANGED','Balance periods change within the CCH report. Export one consistent period.',row));active=undefined;activePostingAccountId=undefined;}
      reportValues.set(marker,value);continue;
    }
    if(/^Col_Metadata_row_\d+$/.test(marker)){count('columnMetadata');if(marker==='Col_Metadata_row_2' && (cellText(cellAt(row,accountCol))!=='NameCol' || cellText(cellAt(row,descriptionCol))!=='DescCol')){errors.push(issue('CCH_METADATA_CHANGED','CCH account-column metadata disagrees with the report headers. Export one consistent original report.',row));active=undefined;activePostingAccountId=undefined;}continue;}
    if(marker==='T_First'){count('tableBoundary');active=undefined;activePostingAccountId=undefined;continue;}
    if(groupMarker.test(marker)){count('groupHeading');active=undefined;activePostingAccountId=undefined;continue;}
    const subgroup=subgroupMarker.exec(marker);
    if(subgroup){
      count('subgroupHeading');active=undefined;activePostingAccountId=undefined;
      const codeCell=cellAt(row,accountCol),code=subgroupCode.exec(cellText(codeCell))?.[1];
      // CCH emits an empty unassigned bucket even when every posting row has a leadcode.
      // It supplies no assignment: any following AD row remains an orphan and blocks matching.
      if(/^\s*Subgroup\s*:\s*None\s*$/i.test(cellText(codeCell)) && !codeCell.formula && !codeCell.error){count('unassignedSubgroup');continue;}
      if(!code?.trim() || codeCell.formula || codeCell.error){errors.push(issue('CCH_LEADCODE_REQUIRED','The CCH subgroup heading has no usable leadcode. Export the subgroup code and assign each posting account to it.',row));continue;}
      active={id:subgroup[1],code:typeof codeCell.value==='number'?{...codeCell,formattedText:code}:{value:code},description:cellAt(row,descriptionCol)};continue;
    }
    const total=subgroupTotal.exec(marker);
    if(total){
      count('subgroupSubtotal');
      if(!active || active.id!==total[1])errors.push(issue('CCH_SUBGROUP_BOUNDARY','A CCH subtotal does not belong to the active subgroup. Account assignment cannot continue safely.',row));
      active=undefined;activePostingAccountId=undefined;continue;
    }
    if(groupTotal.test(marker)){count('groupTotal');active=undefined;activePostingAccountId=undefined;continue;}
    if(spacerMarker.test(marker)){count('controlSpacer');if(sourceColumns.some(c=>cellText(cellAt(row,c)).trim() || cellAt(row,c).formula || cellAt(row,c).error)){errors.push(issue('CCH_SPACER_DATA','A CCH spacer/control row contains unexpected account or balance data. Review the original report layout.',row));active=undefined;activePostingAccountId=undefined;}continue;}
    if(/^NetIncomeLoss(?:_B)?$/.test(marker)){count('netIncomeControl');active=undefined;activePostingAccountId=undefined;continue;}
    const journalEntry=journalEntryMarker.exec(marker);
    if(journalEntry && active?.id===journalEntry[1] && activePostingAccountId===journalEntry[2]){
      count('journalEntryControl');
      // Published CCH reports may place legitimate AJE reference/amount detail in
      // different presentation columns. The typed JE marker distinguishes these
      // rows from authoritative AD posting accounts, whose balances already
      // include the adjustments. Exclude the detail without changing subgroup
      // context or projecting it as another TB account.
      continue;
    }
    const account=accountMarker.exec(marker);
    if(account){
      if(!active)errors.push(issue('CCH_ORPHAN_ACCOUNT','The CCH report contains a posting account before a valid leadcode/subgroup heading, or after its closing subtotal. Assign the account to a valid subgroup and export again.',row));
      if(row.sourceRowNumber<=headerRow.sourceRowNumber)errors.push(issue('CCH_ACCOUNT_BEFORE_HEADER','A posting account appears before the CCH balance headers. Export the complete original report.',row));
      projected.push({sourceRowNumber:row.sourceRowNumber,cells:[cellAt(row,accountCol),cellAt(row,descriptionCol),active?.code??{value:null},active?.description??{value:null},cellAt(row,unadjustedCol),cellAt(row,finalCol),cellAt(row,priorCol)]});
      activePostingAccountId=account[1];
      count('postingAccount');continue;
    }
    errors.push(issue('CCH_UNKNOWN_ROW','An unrecognized row interrupts the CCH account table. Review the report layout or export a fresh original CCH Leadcode Trial Balance.',row));active=undefined;activePostingAccountId=undefined;count('review');
  }
  for(const merge of sheet.mergedRanges??[]){
    const relevant=sheet.rows.some(row=>row.sourceRowNumber>=merge.startRow && row.sourceRowNumber<=merge.endRow && (accountMarker.test(cellText(cellAt(row,markerColumn))) || subgroupMarker.test(cellText(cellAt(row,markerColumn))) || header(row)>=0));
    if(relevant && [...sourceColumns,markerColumn].some(c=>c+1>=merge.startColumn && c+1<=merge.endColumn))errors.push(issue('CCH_MERGED_ACCOUNT_DATA','Merged account, subgroup or balance cells cannot establish reliable CCH account assignments. Export these fields in separate cells.'));
  }
  // Project source cells, then apply the unchanged flat value/uniqueness validator.
  const normalized=parseStandardizedTrialBalance({...workbook,sheets:[{name:sheet.name,rows:projected}]});
  return {...normalized,errors:[...errors,...normalized.errors],warnings:[...warnings,...normalized.warnings],diagnostics:{...normalized.diagnostics,format:'published-cch',confidence:selected.confidence,detectionReasons:selected.reasons,skippedRows,sourceColumns:{account:accountCol+1,description:descriptionCol+1,unadjusted:unadjustedCol+1,final:finalCol+1,priorYear:priorCol+1},reviewedRows:[...new Set([...normalized.diagnostics.reviewedRows,...errors.flatMap(e=>e.sourceRowNumber?[e.sourceRowNumber]:[])])]}};
}
