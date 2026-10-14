import type {SessionState} from '../services/sessionState';
import type {GLTransaction} from '../models/generalLedger';
import type {AccountDetailWorkbookPlan,LeadcodeWorksheetPlan,OutputSummaryRow} from './workbookContract';
import {generationEligibility,GenerationError} from './generationEligibility';
import {allocateSheetNames,compareText} from './sheetNames';
import {reconcileAccounts} from '../services/reconcileAccounts';
import {assignTransactionsToLeadcodes} from '../services/leadcodePopulation';
import {moneyDifference} from '../utils/money';
import {assessReportContext} from '../services/reportContext';
import {APP_VERSION} from '../version';
const optionalText=(a:string|undefined,b:string|undefined)=>a===undefined?(b===undefined?0:1):b===undefined?-1:compareText(a,b);
const GENERATED_IDENTITY_FIELDS=new Set(['account number','account description']);
/** Preserve the original GL column order. Account identity is supplied separately in A:B. */
export function usefulSourceColumns(transactions:readonly GLTransaction[]):string[]{
  const columns:string[]=[];
  const seen=new Set<string>();
  for(const transaction of transactions)for(const key of Object.keys(transaction.sourceFields)){
    if(GENERATED_IDENTITY_FIELDS.has(key.trim().toLowerCase())||seen.has(key))continue;
    seen.add(key);columns.push(key);
  }
  return columns;
}
export function sortTransactions<T extends GLTransaction>(rows:readonly T[]):T[] {
  return rows.map((row,index)=>({row,index})).sort((a,b)=>compareText(a.row.accountNumber,b.row.accountNumber)||optionalText(a.row.transactionDate,b.row.transactionDate)||optionalText(a.row.reference,b.row.reference)||compareText(a.row.sourceSheetName,b.row.sourceSheetName)||a.row.sourceRowNumber-b.row.sourceRowNumber||a.index-b.index).map(r=>r.row);
}
export function buildWorkbookPlan(state:SessionState,generatedAt=new Date().toISOString()):AccountDetailWorkbookPlan {
  const eligibility=generationEligibility(state);
  if(!eligibility.eligible)throw new GenerationError(eligibility.reasons[0]);
  if(!Number.isFinite(Date.parse(generatedAt)))throw new GenerationError('The generation timestamp is invalid.');
  const gl=state.generalLedger!,tb=state.trialBalance!;
  if(gl.sourceMetadata.parserId!==state.detection!.parserId)throw new GenerationError('GL recognition has changed. Choose the source again.');
  // Reuse the exact existing reconciliation engine to revalidate the generation snapshot.
  const analysis=reconcileAccounts(tb.accounts,gl.accountSummaries),selected=new Set(state.selectedLeadcodes);
  const groups=analysis.leadcodes.filter(g=>selected.has(g.leadcode)).sort((a,b)=>compareText(a.leadcode,b.leadcode));
  if(groups.length!==selected.size || groups.some(g=>g.reviewAccountCount))throw new GenerationError('The selected account mappings are not unambiguous. Review the source files.');
  const names=allocateSheetNames(groups.map(g=>g.leadcode)),assigned=assignTransactionsToLeadcodes(analysis,gl.transactions);
  const populations=new Map<string,(GLTransaction & {leadcode:string})[]>(),counts=new Map<string,number>(),provenance=new Set<string>();
  for(const item of assigned){if(!selected.has(item.leadcode))continue;const t=item.transaction;
    if(!Number.isSafeInteger(t.sourceRowNumber)||t.sourceRowNumber<1||!t.sourceSheetName||t.sourceFormat!==gl.sourceMetadata.parserId)throw new GenerationError('Selected GL transactions have invalid source traceability. Review the export.');
    const key=JSON.stringify([t.sourceSheetName,t.sourceRowNumber]);if(provenance.has(key))throw new GenerationError('A selected source transaction appears more than once. Review the GL export.');provenance.add(key);
    counts.set(t.accountNumber,(counts.get(t.accountNumber)??0)+1);
    const population=populations.get(item.leadcode)??[];population.push({...t,leadcode:item.leadcode,accountDescription:t.accountDescription??item.matchedAccount.tb.accountDescription});populations.set(item.leadcode,population);
  }
  const summary:OutputSummaryRow[]=[],leadcodeSheets:LeadcodeWorksheetPlan[]=[];
  for(const group of groups){
    const old=state.analysis!.leadcodes.find(g=>g.leadcode===group.leadcode);
    if(!old || old.accountCount!==group.accountCount || old.transactionCount!==group.transactionCount || old.unadjustedTBBalance!==group.unadjustedTBBalance || old.finalAdjustedTBBalance!==group.finalAdjustedTBBalance || old.glEndingBalance!==group.glEndingBalance)throw new GenerationError('Account analysis has changed. Reprocess the files before generation.');
    const rows=group.accountReconciliations!;
    if(rows.some(a=>(counts.get(a.accountNumber)??0)!==a.transactionCount))throw new GenerationError('Selected transaction counts do not agree with the parsed account controls. Review the GL export.');
    const transactions=sortTransactions(populations.get(group.leadcode)??[]);
    const warnings=[...(group.unmatchedAccountCount?[`${group.unmatchedAccountCount} unmatched TB accounts`]:[]),...(group.noActivityAccountCount?[`${group.noActivityAccountCount} matched accounts with no activity`]:[]),...(group.balanceUnavailableCount?[`${group.balanceUnavailableCount} unavailable balance validations`]:[]),...(group.balanceDifferenceCount?[`${group.balanceDifferenceCount} GL/Unadjusted TB differences`]:[]),...(group.descriptionConflict?['Conflicting leadcode descriptions; review source TB']:[]),...(!transactions.length?['No matched GL transactions for this leadcode']:[])];
    const control={leadcode:group.leadcode,leadcodeDescription:group.leadcodeDescription,numberOfAccounts:group.accountCount,transactionCount:transactions.length,unadjustedTBBalance:group.unadjustedTBBalance,finalAdjustedTBBalance:group.finalAdjustedTBBalance,priorYearTBBalance:group.priorYearTBBalance,glEndingBalance:group.glEndingBalance,glVsUnadjustedTBDifference:group.glVsUnadjustedDifference,auditAdjustmentDifference:moneyDifference(group.finalAdjustedTBBalance,group.unadjustedTBBalance)};
    summary.push({...control,matchedAccountCount:group.matchedAccountCount!,unmatchedAccountCount:group.unmatchedAccountCount!,noActivityAccountCount:group.noActivityAccountCount,balanceUnavailableCount:group.balanceUnavailableCount,balanceDifferenceCount:group.balanceDifferenceCount,transactionCount:transactions.length,balanceStatus:group.reconciliationStatus,warnings});
    leadcodeSheets.push({sheetName:names.get(group.leadcode)!,control,accounts:[...rows].sort((a,b)=>compareText(a.accountNumber,b.accountNumber)).map(a=>({accountNumber:a.accountNumber,accountDescription:a.tb.accountDescription,unadjustedTB:a.unadjustedTB,finalAdjustedTB:a.finalAdjustedTB,priorYearFinalTB:a.tb.priorYearFinalBalance,auditAdjustmentDifference:a.auditAdjustmentDifference,glEndingBalance:a.glEndingBalance,glVsUnadjustedDifference:a.glVsUnadjustedDifference,mappingStatus:a.mappingStatus,balanceStatus:a.balanceStatus})),transactions,additionalSourceColumns:usefulSourceColumns(transactions)});
  }
  const context=assessReportContext(state);
  return {summary,leadcodeSheets,metadata:{generatedAt,tbFileName:state.files.trialBalance.status==='ready'?state.files.trialBalance.metadata.fileName:'',glFileName:state.files.generalLedger.status==='ready'?state.files.generalLedger.metadata.fileName:'',tbFormat:tb.diagnostics.format??'flat',glFormat:gl.sourceMetadata.parserId,totalGLTransactions:gl.transactions.length,glOnlyAccountCount:analysis.glOnlyAccountCount,tbContext:context.tb,glContext:context.gl,displayEntity:context.entity,displayPeriodEnd:context.periodEnd,scopeWarnings:context.warnings,applicationVersion:APP_VERSION,expectedPopulation:{sheets:groups.length+1,leadcodes:groups.length,accounts:groups.reduce((n,g)=>n+g.accountCount,0),transactions:groups.reduce((n,g)=>n+(g.transactionCount??0),0)},sourceWarnings:[...tb.warnings.map(w=>({source:'Trial Balance',message:w.message,sheet:w.sourceSheetName,row:w.sourceRowNumber})),...gl.warnings.map(w=>({source:'General Ledger',message:w.message,sheet:w.sourceSheetName,row:w.sourceRowNumber})),...analysis.warnings.map(w=>({source:'Account Matching',message:w.message,sheet:w.sourceSheetName,row:w.sourceRowNumber})),...context.warnings.map(message=>({source:'Input scope',message}))]}};
}
