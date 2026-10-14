import type {AnalysisResult, ReconciledAccount} from '../models/processing';
import type {GLTransaction} from '../models/generalLedger';
import type {LeadcodeGroup} from '../models/leadcode';

export interface LeadcodeTransaction {
  readonly leadcode: string;
  readonly transaction: GLTransaction;
  readonly matchedAccount: ReconciledAccount;
}
/** Pre-generation population only. No workbook, source mutation or leadcode inference from GL data. */
export function assignTransactionsToLeadcodes(analysis: AnalysisResult, transactions: readonly GLTransaction[]): LeadcodeTransaction[] {
  const seen = new Set<string>(), index = new Map<string, ReconciledAccount>();
  for (const row of analysis.accounts) {
    if (seen.has(row.accountNumber)) throw new Error('Duplicate authoritative TB account cannot receive multiple assignments.');
    seen.add(row.accountNumber);
    if (row.mappingStatus === 'matched' || row.mappingStatus === 'noActivity') index.set(row.accountNumber, row);
  }
  return transactions.flatMap(transaction => {
    const matchedAccount = index.get(transaction.accountNumber);
    return matchedAccount ? [{leadcode: matchedAccount.tb.leadcode, transaction, matchedAccount}] : [];
  });
}
export function selectLeadcodePopulation(groups: readonly LeadcodeGroup[], assigned: readonly LeadcodeTransaction[], selected: readonly string[]) {
  const codes = new Set(selected), selectedGroups = groups.filter(g => codes.has(g.leadcode));
  return {
    groups: selectedGroups,
    accounts: selectedGroups.flatMap(g => g.accounts),
    transactions: assigned.filter(t => codes.has(t.leadcode)),
  };
}
