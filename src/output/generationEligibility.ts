import type {SessionState} from '../services/sessionState';
import {assessReportContext} from '../services/reportContext';
export class GenerationError extends Error {}
export function generationEligibility(state:SessionState) {
  const reasons:string[]=[],warnings:string[]=[];
  if(state.demoVisible)reasons.push('Demo data cannot be used to generate an audit workbook.');
  if(Object.values(state.files).some(f=>f.status!=='ready') || !state.trialBalance || !state.generalLedger)reasons.push('Choose and validate both source workbooks.');
  if(state.trialBalance?.errors.length || state.generalLedger?.errors.length || state.processingErrors?.length)reasons.push('Correct blocking source issues before generating a workbook.');
  if(!state.detection?.recognized || state.detection.parserId==='custom')reasons.push('A recognized general ledger is required.');
  if(state.generalLedger?.accountMatching?.status==='requiresConfirmation')reasons.push('Account identity requires same-client CCH confirmation; generation is unavailable for this GL.');
  if(!state.analysis)reasons.push('Account matching must complete before generation.');
  if(!state.selectedLeadcodes.length)reasons.push('Select at least one leadcode.');
  const selected=new Set(state.selectedLeadcodes),groups=state.analysis?.leadcodes.filter(g=>selected.has(g.leadcode))??[];
  if(groups.length!==selected.size)reasons.push('The leadcode selection is no longer valid. Select the leadcodes again.');
  if(groups.some(g=>(g.reviewAccountCount??0)>0))reasons.push('Resolve ambiguous account mappings in the selected leadcodes before generation.');
  if(groups.some(g=>(g.unmatchedAccountCount??0)>0))warnings.push('Unmatched TB accounts will appear in account controls; their GL detail and balances are unavailable.');
  if(groups.some(g=>(g.balanceUnavailableCount??0)>0))warnings.push('Unavailable GL balances will be labeled Unavailable.');
  if(groups.some(g=>(g.balanceDifferenceCount??0)>0))warnings.push('GL versus Unadjusted TB differences will remain visible in the workbook.');
  if(groups.length && groups.every(g=>!g.transactionCount))warnings.push('The selected leadcodes have no matched GL transactions; account controls will still be included.');
  warnings.push(...assessReportContext(state).warnings);
  return {eligible:reasons.length===0,reasons,warnings};
}
