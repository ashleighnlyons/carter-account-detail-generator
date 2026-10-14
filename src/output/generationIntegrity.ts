import type {AccountDetailWorkbookPlan} from './workbookContract';
import {GenerationError} from './generationEligibility';
export interface GenerationCounts {readonly sheets:number;readonly leadcodes:number;readonly accounts:number;readonly transactions:number;}
export function integrityFailure():never {
  throw new GenerationError('Workbook completeness check failed. No file was downloaded. Start Over and reprocess both files; contact the utility maintainer if this repeats.');
}
export function assertGenerationCounts(expected:GenerationCounts,written:GenerationCounts){
  if((Object.keys(expected) as (keyof GenerationCounts)[]).some(key=>expected[key]!==written[key]))integrityFailure();
}
/** Independent plan/control counts and legal sheet aliases, before any output allocation. */
export function validateGenerationPlan(plan:AccountDetailWorkbookPlan):GenerationCounts {
  const names=new Set(['summary']),codes=new Set<string>();
  if(!plan.summary.length||plan.summary.length!==plan.leadcodeSheets.length)integrityFailure();
  for(const s of plan.leadcodeSheets){
    if(!s.sheetName||s.sheetName.length>31||/[\[\]:*?\/\\\u0000-\u001f]/.test(s.sheetName)||/^'|'$/.test(s.sheetName)||s.sheetName.toLowerCase()==='history'||names.has(s.sheetName.toLowerCase()))throw new GenerationError('A worksheet name is invalid or duplicated. Reprocess the files and contact the utility maintainer if this repeats.');
    names.add(s.sheetName.toLowerCase());
    if(codes.has(s.control.leadcode))integrityFailure();codes.add(s.control.leadcode);
    const controls=plan.summary.filter(r=>r.leadcode===s.control.leadcode);
    if(controls.length!==1||s.accounts.length!==s.control.numberOfAccounts||s.accounts.length!==controls[0].numberOfAccounts||s.transactions.length!==controls[0].transactionCount||(s.control.transactionCount!==undefined&&s.control.transactionCount!==s.transactions.length)||s.transactions.some(t=>t.leadcode!==s.control.leadcode))integrityFailure();
    if(new Set(s.accounts.map(a=>a.accountNumber)).size!==s.accounts.length)integrityFailure();
    const accounts=new Set(s.accounts.map(a=>a.accountNumber));if(s.transactions.some(t=>!accounts.has(t.accountNumber)))integrityFailure();
  }
  const expected={sheets:plan.summary.length+1,leadcodes:plan.summary.length,accounts:plan.summary.reduce((n,r)=>n+r.numberOfAccounts,0),transactions:plan.summary.reduce((n,r)=>n+r.transactionCount,0)};
  if(plan.metadata?.expectedPopulation)assertGenerationCounts(plan.metadata.expectedPopulation,expected);
  return expected;
}
