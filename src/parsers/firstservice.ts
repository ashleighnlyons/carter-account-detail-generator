import type { GLAccountSummary, GLTransaction, GLSubaccountSummary, GLSourceHierarchy, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookRow, WorkbookSheet } from '../models/workbook';
import type { GLParser, GLParseResult, ParserDetection, ParserIssue, SkippedRowCategory } from './types';
import { cellAt, cellText, dateFromCell, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';
import { addCents, balancesAgree, fromCents, moneyDifference, toCents, type Cents } from '../utils/money';

export const FIRSTSERVICE_HEADERS = ['Account Sub\nType JE ID', 'Source', 'Description', 'Description Date', 'Debit', 'Credit', 'Balance'] as const;
type Column = typeof FIRSTSERVICE_HEADERS[number];
type Columns = Record<Column, number> & { jeId: number };
interface Layout { sheet: WorkbookSheet; header: WorkbookRow; columns: Columns; confidence: number; reasons: string[] }
const names = FIRSTSERVICE_HEADERS.map(normalizedHeader);
function onlyColumns(row: WorkbookRow, columns: readonly number[]) { return row.cells.every((cell, i) => columns.includes(i) || (!cell.error && !cellText(cell).trim())); }
function labelAt(row: WorkbookRow, index: number) { return !cellAt(row, index).error ? cellText(cellAt(row, index)).trim().toLowerCase() : ''; }
function isHeader(row: WorkbookRow) { const found = row.cells.map(c => normalizedHeader(cellText(c))); return names.every(name => found.filter(x => x === name).length === 1); }
function mainHeading(row: WorkbookRow, c: Columns) { return labelAt(row, c.Description) === 'beginning balance' && onlyColumns(row, [c[FIRSTSERVICE_HEADERS[0]], c.Description, c.Balance]); }
function subHeading(row: WorkbookRow, c: Columns) { return labelAt(row, c['Description Date']) === 'subaccount beginning balance' && onlyColumns(row, [c[FIRSTSERVICE_HEADERS[0]], c['Description Date'], c.Balance]); }
function control(row: WorkbookRow, c: Columns, label: string, activity: boolean) { return labelAt(row, c.Description) === label && onlyColumns(row, activity ? [c.Description, c.Debit, c.Credit, c.Balance] : [c.Description, c.Balance]); }
function inspectLayouts(workbook: ParserWorkbook): Layout[] {
  return workbook.sheets.flatMap(sheet => {
    const header = sheet.rows.find(r => r.sourceRowNumber <= 200 && isHeader(r)); if (!header) return [];
    const found = header.cells.map(c => normalizedHeader(cellText(c)));
    const columns = Object.fromEntries(FIRSTSERVICE_HEADERS.map((name,i) => [name,found.indexOf(names[i])])) as Columns;
    const typeColumn = columns[FIRSTSERVICE_HEADERS[0]]; columns.jeId = typeColumn + 1;
    // This report's compound Account/Sub/Type/JE ID heading owns an unlabeled JE slot before Source.
    if (columns.Source !== typeColumn + 2 || cellText(cellAt(header, columns.jeId)).trim()) return [];
    const body = sheet.rows.filter(row => row.sourceRowNumber > header.sourceRowNumber);
    const main = body.some(r => mainHeading(r,columns)) && body.some(r => control(r,columns,'total monthly activity',true)) && body.some(r => control(r,columns,'account ending balance',false));
    const sub = body.some(r => subHeading(r,columns)) && body.some(r => control(r,columns,'subaccount total',true)) && body.some(r => control(r,columns,'subaccount balance',false));
    const confidence = Math.round((0.45 + (main ? 0.25 : 0) + (sub ? 0.30 : 0)) * 100) / 100;
    const reasons = ['Distinctive compound Account/Sub/Type/JE ID header with an adjacent JE slot, Source and Description Date columns.'];
    if (main) reasons.push('Main Beginning Balance, Total Monthly Activity and Account Ending Balance controls.');
    if (sub) reasons.push('Subaccount Beginning Balance, Subaccount Total and Subaccount Balance controls.');
    return [{ sheet, header, columns, confidence, reasons }];
  }).sort((a,b)=>b.confidence-a.confidence);
}
export function detectFirstService(workbook: ParserWorkbook): ParserDetection {
  const layouts = inspectLayouts(workbook);
  if (layouts.filter(l=>l.confidence>=0.85).length>1) return { confidence:0, reasons:['Multiple FirstService report sheets require explicit entity/scope review.'] };
  return layouts[0] ? {confidence:layouts[0].confidence,reasons:layouts[0].reasons} : {confidence:0,reasons:['The FirstService compound columns and two-level account controls were not found.']};
}
interface ActivityContext { heading: number; rawHeading: string; beginning?: number; ending?: number; endingRow?: number; totalRow?: number; count: number; debits: Cents[]; credits: Cents[]; reliable: boolean }
interface Parent extends ActivityContext { accountNumber: string; accountDescription: string; children: GLSubaccountSummary[] }
interface Child extends ActivityContext { subaccountNumber?: string; subaccountDescription?: string }
/** Source syntax is identifier + first literal space + description; never numerically convert either code. */
function splitHeading(text: string, required: boolean) {
  if (!text.trim()) { if (required) throw new TypeError('Missing identifier'); return { identifier: undefined, description: undefined }; }
  const separator = text.indexOf(' ');
  const identifier = separator < 0 ? text : text.slice(0,separator), description = separator < 0 ? undefined : text.slice(separator+1);
  if (!identifier.trim() || (required && !description?.trim())) throw new TypeError('Ambiguous heading');
  return { identifier, description };
}
export function parseFirstServiceWorkbook(workbook: ParserWorkbook): GLParseResult {
  const transactions: GLTransaction[] = [], accountSummaries: GLAccountSummary[] = [], subaccountSummaries: GLSubaccountSummary[] = [], warnings: ParserIssue[] = [], errors: ParserIssue[] = [];
  const reportFields: Record<string,SourceFieldValue> = Object.create(null);
  const sourceMetadata = { parserId:'firstservice' as const, workbook:workbook.metadata, parserVersion:'0.5.0', reportFields };
  const accountMatching = {status:'requiresConfirmation' as const,sourceIdentifierDescription:'Source main GL account identifier; subaccount dimensions are retained separately.',reason:'Confirm the main/subaccount identifier convention against the authoritative client flat CCH trial balance. No combined identifier or normalization rule has been assumed.'};
  const layout = inspectLayouts(workbook)[0];
  if (!layout || detectFirstService(workbook).confidence<0.85) return {transactions,accountSummaries,subaccountSummaries,warnings,errors:[{code:'FIRSTSERVICE_STRUCTURE_UNRECOGNIZED',message:'No single FirstService two-level ledger structure was confidently recognized.'}],sourceMetadata,accountMatching};
  const { sheet,header,columns:c } = layout, typeColumn = c[FIRSTSERVICE_HEADERS[0]];
  const accountHeadingRows:number[]=[],subaccountHeadingRows:number[]=[],beginningBalanceRows:number[]=[],endingBalanceRows:number[]=[],subaccountTotalRows:number[]=[],subaccountEndingRows:number[]=[],mainAccountTotalRows:number[]=[],ambiguousHierarchyRows:number[]=[];
  const skippedRows:Record<SkippedRowCategory,number>={reportHeader:0,columnHeader:0,accountHeading:0,beginningBalance:0,endingBalance:0,subtotal:0,blank:0,reportFooter:0,review:0};
  let parent:Parent|undefined, child:Child|undefined, numericIdentifierCount=0, firstNumericRow:number|undefined, repeatedHeaderCount=0, changedColumns=false;
  const prefixLabels = new Set(sheet.rows.filter(r=>r.sourceRowNumber<header.sourceRowNumber && onlyColumns(r,[typeColumn])).map(r=>cellText(cellAt(r,typeColumn)).trim()).filter(Boolean));
  function issue(code:string,message:string,row?:number):ParserIssue {return {code,message,sourceSheetName:sheet.name,sourceRowNumber:row};}
  function hierarchy():GLSourceHierarchy {return {parentAccountNumber:parent!.accountNumber,parentAccountDescription:parent!.accountDescription,subaccountNumber:child!.subaccountNumber,subaccountDescription:child!.subaccountDescription,sourceParentHeadingRowNumber:parent!.heading,sourceSubaccountHeadingRowNumber:child!.heading};}
  function finishChild() {
    if (!child) return;
    if (child.ending===undefined) {child.reliable=false;warnings.push(issue('FIRSTSERVICE_SUB_ENDING_UNAVAILABLE','Subaccount has no reliable paired ending control; intrinsic balance validation is unavailable.',child.heading));}
    const summary:GLSubaccountSummary={...hierarchy(),beginningBalance:child.beginning,endingBalance:child.ending,transactionCount:child.count,balanceControlsReliable:child.reliable && child.ending!==undefined,sourceSheetName:sheet.name,sourceHeadingText:child.rawHeading,sourceTotalRowNumber:child.totalRow,sourceEndingRowNumber:child.endingRow};
    subaccountSummaries.push(summary);parent!.children.push(summary);if(!summary.balanceControlsReliable)parent!.reliable=false;child=undefined;
  }
  function finishParent() {
    if (!parent) return;finishChild();
    if(parent.ending===undefined) {parent.reliable=false;warnings.push(issue('FIRSTSERVICE_MAIN_ENDING_UNAVAILABLE','Main account has no reliable paired explicit ending control; intrinsic balance validation is unavailable.',parent.heading));}
    accountSummaries.push({accountNumber:parent.accountNumber,accountDescription:parent.accountDescription,beginningBalance:parent.beginning,endingBalance:parent.ending,transactionCount:parent.count,balanceValidationAvailable:parent.reliable && parent.ending!==undefined,sourceSheetName:sheet.name,sourceHeadingRowNumber:parent.heading,sourceEndingRowNumber:parent.endingRow});parent=undefined;
  }
  function reject(row:WorkbookRow,code:string,message:string,blocking:boolean) {
    const problem=issue(code,message,row.sourceRowNumber);warnings.push(problem);if(blocking)errors.push(problem);skippedRows.review++;ambiguousHierarchyRows.push(row.sourceRowNumber);
    if(child)child.reliable=false;if(parent)parent.reliable=false;finishParent();
  }
  function amount(row:WorkbookRow,column:'Debit'|'Credit'|'Balance',required:boolean,blocking:boolean) {
    try {const value=monetaryValue(cellAt(row,c[column]));if(required && value===undefined)throw new Error('Missing');return value;}
    catch {(blocking?errors:warnings).push(issue('FIRSTSERVICE_INVALID_AMOUNT',`${column} contains a missing, invalid or unsafe amount. Review the source row.`,row.sourceRowNumber));if(child)child.reliable=false;if(parent)parent.reliable=false;return undefined;}
  }
  function checkTotal(row:WorkbookRow,context:ActivityContext) {
    const debit=amount(row,'Debit',context.count>0,false),credit=amount(row,'Credit',context.count>0,false),net=amount(row,'Balance',true,false);context.totalRow=row.sourceRowNumber;
    try {
      const actualDebit=fromCents(addCents(context.debits)),actualCredit=fromCents(addCents(context.credits));
      // Blank debit/credit total cells are only legitimate in an explicit zero-activity section.
      if(!balancesAgree(debit??0,actualDebit)||!balancesAgree(credit??0,actualCredit)||(net!==undefined && !balancesAgree(net,moneyDifference(actualDebit,actualCredit)))) {context.reliable=false;warnings.push(issue('FIRSTSERVICE_ACTIVITY_CONTROL_DIFFERENCE','Activity debit/credit/net totals disagree; intrinsic balance validation is unavailable.',row.sourceRowNumber));}
    } catch {context.reliable=false;errors.push(issue('FIRSTSERVICE_AMOUNT_RANGE','Activity controls cannot retain safe cent precision.',row.sourceRowNumber));}
  }
  function checkEnding(row:WorkbookRow,context:ActivityContext) {
    context.ending=amount(row,'Balance',true,false);context.endingRow=row.sourceRowNumber;
    if(context.totalRow===undefined) {context.reliable=false;warnings.push(issue('FIRSTSERVICE_UNPAIRED_ENDING','Explicit ending has no paired activity total; completeness requires review.',row.sourceRowNumber));}
    try {
      if(context.beginning!==undefined && context.ending!==undefined) {const expected=fromCents(addCents([toCents(context.beginning),...context.debits,...context.credits.map(v=>-v as Cents)]));if(!balancesAgree(expected,context.ending)){context.reliable=false;warnings.push(issue('FIRSTSERVICE_ROLLFORWARD_DIFFERENCE','Beginning plus activity does not agree with the explicit ending; intrinsic validation is unavailable.',row.sourceRowNumber));}}
    } catch {context.reliable=false;errors.push(issue('FIRSTSERVICE_AMOUNT_RANGE','Balance controls cannot retain safe cent precision.',row.sourceRowNumber));}
  }
  function sourceFields(row:WorkbookRow) {
    const fields:Record<string,SourceFieldValue>=Object.create(null);
    row.cells.forEach((cell,index)=>{
      const original=index===c.jeId?'JE ID':cellText(cellAt(header,index)).trim()||`Source Column ${index+1}`;
      const key=Object.hasOwn(fields,original)?`${original} [column ${index+1}]`:original;
      fields[key]=cell.error??(cell.dateValue?cell.formattedText??cell.dateValue: index===c.jeId || index===c.Source ? (cell.value===null?null:cellText(cell)):cell.value);
    });
    for(const [name,value] of [['Main Account Heading',parent!.rawHeading],['Subaccount Heading',child!.rawHeading]]){let key=name,suffix=1;while(Object.hasOwn(fields,key))key=`${name} [report context ${suffix++}]`;fields[key]=value;}
    return fields;
  }
  for(const row of sheet.rows) {
    if(isBlankRow(row)){skippedRows.blank++;continue;}
    if(row.sourceRowNumber<header.sourceRowNumber){skippedRows.reportHeader++;row.cells.forEach((cell,i)=>{if(cell.value!==null && cellText(cell).trim())reportFields[`Report row ${row.sourceRowNumber} column ${i+1}`]=cell.dateValue??cell.value;});continue;}
    if(changedColumns){skippedRows.review++;continue;}
    if(isHeader(row)){if(FIRSTSERVICE_HEADERS.every(name=>normalizedHeader(cellText(cellAt(row,c[name])))===normalizedHeader(name)) && !cellText(cellAt(row,c.jeId)).trim()){skippedRows.columnHeader++;if(row.sourceRowNumber!==header.sourceRowNumber)repeatedHeaderCount++;}else{reject(row,'FIRSTSERVICE_COLUMNS_CHANGED','Repeated column positions changed; further rows require review.',true);changedColumns=true;}continue;}
    const text=cellText(cellAt(row,typeColumn));
    if(onlyColumns(row,[typeColumn]) && prefixLabels.has(text.trim())) {skippedRows.reportHeader++;continue;}
    if(onlyColumns(row,[typeColumn]) && (/^general ledger report$/i.test(text.trim()) || /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(text.trim()))) {skippedRows.reportFooter++;continue;}
    if(mainHeading(row,c)) {
      finishParent();
      try {const source=cellAt(row,typeColumn);if(source.error || typeof source.value!=='string')throw new Error('Invalid');const split=splitHeading(text,true);accountHeadingRows.push(row.sourceRowNumber);beginningBalanceRows.push(row.sourceRowNumber);skippedRows.accountHeading++;
        parent={accountNumber:split.identifier!,accountDescription:split.description!,heading:row.sourceRowNumber,rawHeading:text,count:0,debits:[],credits:[],reliable:true,children:[]};parent.beginning=amount(row,'Balance',true,false);
      }catch{reject(row,'FIRSTSERVICE_MAIN_HEADING_INVALID','Main account identifier/description cannot be separated confidently. No identifier was invented.',true);}continue;
    }
    if(subHeading(row,c)) {
      if(!parent || parent.totalRow!==undefined){reject(row,'FIRSTSERVICE_SUB_CONTEXT','Subaccount has no unique active main account. Its context was not assigned.',false);continue;}
      finishChild();
      try {const source=cellAt(row,typeColumn);if(source.error || source.value!==null && typeof source.value!=='string')throw new Error('Invalid');const split=splitHeading(text,false);subaccountHeadingRows.push(row.sourceRowNumber);beginningBalanceRows.push(row.sourceRowNumber);skippedRows.beginningBalance++;
        child={subaccountNumber:split.identifier,subaccountDescription:split.description,heading:row.sourceRowNumber,rawHeading:text,count:0,debits:[],credits:[],reliable:true};child.beginning=amount(row,'Balance',true,false);
      }catch{reject(row,'FIRSTSERVICE_SUB_HEADING_INVALID','Subaccount heading cannot be classified safely; parent/child context was cleared.',true);}continue;
    }
    if(control(row,c,'subaccount total',true)) {
      if(!parent || !child || child.totalRow!==undefined){reject(row,'FIRSTSERVICE_SUB_TOTAL_CONTEXT','Subaccount Total has no unique open subaccount; it was not assigned.',false);continue;}
      skippedRows.subtotal++;subaccountTotalRows.push(row.sourceRowNumber);checkTotal(row,child);continue;
    }
    if(control(row,c,'subaccount balance',false)) {
      if(!parent || !child){reject(row,'FIRSTSERVICE_SUB_BALANCE_CONTEXT','Subaccount Balance has no unique open subaccount; it was not assigned.',false);continue;}
      skippedRows.endingBalance++;subaccountEndingRows.push(row.sourceRowNumber);checkEnding(row,child);finishChild();continue;
    }
    if(control(row,c,'total monthly activity',true)) {
      if(!parent || parent.totalRow!==undefined){reject(row,'FIRSTSERVICE_MAIN_TOTAL_CONTEXT','Main activity total has no unique open main account; it was not assigned.',false);continue;}
      finishChild();skippedRows.subtotal++;mainAccountTotalRows.push(row.sourceRowNumber);checkTotal(row,parent);continue;
    }
    if(control(row,c,'account ending balance',false)) {
      if(!parent){reject(row,'FIRSTSERVICE_MAIN_BALANCE_CONTEXT','Main ending balance has no unique open account; it was not assigned.',false);continue;}
      finishChild();skippedRows.endingBalance++;endingBalanceRows.push(row.sourceRowNumber);checkEnding(row,parent);
      try {
        const children=parent.children;
        if(!children.length || children.some(s=>!s.balanceControlsReliable || s.beginningBalance===undefined || s.endingBalance===undefined) ||
          parent.beginning!==undefined && !balancesAgree(fromCents(addCents(children.map(s=>toCents(s.beginningBalance!)))),parent.beginning) ||
          parent.ending!==undefined && !balancesAgree(fromCents(addCents(children.map(s=>toCents(s.endingBalance!)))),parent.ending)) {
          parent.reliable=false;warnings.push(issue('FIRSTSERVICE_HIERARCHY_COVERAGE','Subaccount balance coverage does not reliably agree to main-account controls. Intrinsic main balance validation is unavailable.',row.sourceRowNumber));
        }
      }catch{parent.reliable=false;errors.push(issue('FIRSTSERVICE_AMOUNT_RANGE','Hierarchy control totals cannot retain safe cent precision.',row.sourceRowNumber));}
      finishParent();continue;
    }
    const date=dateFromCell(cellAt(row,c['Description Date']));
    if(date) {
      if(!parent || !child || parent.totalRow!==undefined || child.totalRow!==undefined){reject(row,'FIRSTSERVICE_ORPHAN_TRANSACTION','Dated activity has no reliable open main/subaccount context, or follows an activity total. It was not assigned.',true);continue;}
      const before=errors.length,debit=amount(row,'Debit',false,true),credit=amount(row,'Credit',false,true);
      if(before===errors.length && debit===undefined && credit===undefined)errors.push(issue('FIRSTSERVICE_MISSING_TRANSACTION_AMOUNT','Dated activity has neither debit nor credit; no zero amount was guessed.',row.sourceRowNumber));
      if(errors.length>before){child.reliable=false;parent.reliable=false;skippedRows.review++;continue;}
      const runningBalance=amount(row,'Balance',false,false);let netAmount:number;
      try{netAmount=moneyDifference(debit??0,credit??0);}catch{child.reliable=false;parent.reliable=false;errors.push(issue('FIRSTSERVICE_AMOUNT_RANGE','Activity cannot retain safe cent precision.',row.sourceRowNumber));skippedRows.review++;continue;}
      for(const index of [c.jeId,c.Source])if(typeof cellAt(row,index).value==='number'){numericIdentifierCount++;firstNumericRow??=row.sourceRowNumber;}
      const optional=(index:number)=>{const value=cellText(cellAt(row,index));return value.trim()?value:undefined;};
      transactions.push({accountNumber:parent.accountNumber,accountDescription:parent.accountDescription,transactionDate:date,transactionType:optional(typeColumn),reference:optional(c.Source),description:optional(c.Description),debit,credit,netAmount,runningBalance,sourceFormat:'firstservice',sourceRowNumber:row.sourceRowNumber,sourceSheetName:sheet.name,sourceHierarchy:hierarchy(),sourceFields:sourceFields(row)});
      for(const context of [parent,child]){context.count++;context.debits.push(toCents(debit??0));context.credits.push(toCents(credit??0));}continue;
    }
    const shaped=[c.jeId,c.Source,c['Description Date'],c.Debit,c.Credit].some(i=>cellAt(row,i).error || cellText(cellAt(row,i)).trim());
    reject(row,shaped?'FIRSTSERVICE_MALFORMED_TRANSACTION':'FIRSTSERVICE_AMBIGUOUS_BOUNDARY','Row cannot be safely assigned within the source hierarchy. Main/subaccount context was cleared for review.',!!shaped);
  }
  finishParent();
  if(!accountSummaries.length)errors.push(issue('FIRSTSERVICE_NO_ACCOUNTS','No main ledger account summaries were found.'));
  if(numericIdentifierCount)warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY',`${numericIdentifierCount.toLocaleString()} numeric JE/Source identifiers were preserved using displayed text. Leading zeros already lost without source formatting cannot be recovered.`,firstNumericRow));
  warnings.push(issue('ACCOUNT_MATCHING_REQUIRES_CONFIRMATION','Account matching requires confirmation of the source main/subaccount convention against the authoritative flat CCH trial balance.'));
  const seen=new Set<string>();for(const account of accountSummaries){if(seen.has(account.accountNumber))warnings.push(issue('FIRSTSERVICE_DUPLICATE_MAIN_ACCOUNT','Main account appears in multiple sections; exact matching would require review.',account.sourceHeadingRowNumber));seen.add(account.accountNumber);}
  return {transactions,accountSummaries,subaccountSummaries,warnings,errors,sourceMetadata,accountMatching,diagnostics:{detectedSheet:sheet.name,headerRowNumber:header.sourceRowNumber,accountHeadingRows,beginningBalanceRows,endingBalanceRows,subaccountHeadingRows,subaccountTotalRows,subaccountEndingRows,mainAccountTotalRows,reportTotalRows:[],ambiguousHierarchyRows,repeatedHeaderCount,subtotalRows:[...subaccountTotalRows,...mainAccountTotalRows].sort((a,b)=>a-b),skippedRows,transactionCount:transactions.length,endingBalanceCount:accountSummaries.filter(a=>a.endingBalance!==undefined).length,reliableEndingBalanceCount:accountSummaries.filter(a=>a.balanceValidationAvailable).length,warningCount:warnings.length,numericIdentifierCount}};
}
export const firstserviceParser:GLParser={id:'firstservice',displayName:'FirstService General Ledger',implemented:true,detect:detectFirstService,parse:async workbook=>parseFirstServiceWorkbook(workbook)};
