import type { TBAccount } from '../models/trialBalance';
import type { GLAccountSummary } from '../models/generalLedger';
import type { AnalysisResult, ReconciledAccount } from '../models/processing';
import { AccountMappingStatus as Mapping, BalanceValidationStatus as Balance } from '../models/reconciliation';
import { normalizeAccountNumber, matchTBAccountToGLAccount } from '../utils/accountMatching';
import { balancesAgree, moneyDifference, sumMoney } from '../utils/money';
import { groupAccountsByLeadcode } from '../utils/leadcodeGrouping';
import type { ParserIssue } from '../parsers/types';

/** Exact identifiers are indexed once. No fuzzy matching, inference from net activity or adjusted-TB agreement test. */
export function reconcileAccounts(tbAccounts: readonly TBAccount[], glAccounts: readonly GLAccountSummary[]): AnalysisResult {
  const index = new Map<string, GLAccountSummary[]>();
  for (const gl of glAccounts) {
    const identifier = normalizeAccountNumber(gl.accountNumber), candidates = index.get(identifier) ?? [];
    candidates.push(gl); index.set(identifier, candidates);
  }
  const accounts: ReconciledAccount[] = tbAccounts.map(tb => {
    const match = matchTBAccountToGLAccount(tb, index.get(normalizeAccountNumber(tb.accountNumber)) ?? []);
    const gl = match.candidates.length === 1 ? match.candidates[0] : undefined;
    const available = gl?.balanceValidationAvailable === true && gl.endingBalance !== undefined && Number.isFinite(gl.endingBalance);
    const glEndingBalance = available ? gl!.endingBalance : undefined;
    return { accountNumber: tb.accountNumber, tb, unadjustedTB: tb.unadjustedBalance, finalAdjustedTB: tb.finalAdjustedBalance,
      auditAdjustmentDifference: moneyDifference(tb.finalAdjustedBalance, tb.unadjustedBalance),
      mappingStatus: match.status, balanceStatus: available ? (balancesAgree(glEndingBalance!, tb.unadjustedBalance) ? Balance.Agrees : Balance.Differs) : Balance.Unavailable,
      glEndingBalance, glVsUnadjustedDifference: available ? moneyDifference(glEndingBalance!, tb.unadjustedBalance) : undefined,
      transactionCount: gl?.transactionCount ?? 0 };
  });
  const accountIndex = new Map(accounts.map(account => [account.accountNumber, account]));
  const leadcodes = groupAccountsByLeadcode(tbAccounts).map(group => {
    const rows = group.accounts.map(account => accountIndex.get(account.accountNumber)!);
    const unavailable = rows.filter(row => row.balanceStatus === Balance.Unavailable).length;
    const differing = rows.filter(row => row.balanceStatus === Balance.Differs).length;
    const glEndingBalance = unavailable === 0 ? sumMoney(rows.map(row => row.glEndingBalance!)) : undefined;
    const difference = glEndingBalance !== undefined ? moneyDifference(glEndingBalance, group.unadjustedTBBalance) : undefined;
    return { ...group, accountReconciliations: rows, matchedAccountCount: rows.filter(row => row.mappingStatus === Mapping.Matched || row.mappingStatus === Mapping.NoActivity).length,
      unmatchedAccountCount: rows.filter(row => row.mappingStatus === Mapping.Unmatched).length, noActivityAccountCount: rows.filter(row => row.mappingStatus === Mapping.NoActivity).length,
      reviewAccountCount: rows.filter(row => row.mappingStatus === Mapping.Review).length, transactionCount: rows.reduce((sum, row) => sum + row.transactionCount, 0),
      balanceUnavailableCount: unavailable, balanceDifferenceCount: differing, glEndingBalance, glVsUnadjustedDifference: difference,
      reconciliationStatus: differing > 0 || (glEndingBalance !== undefined && !balancesAgree(glEndingBalance, group.unadjustedTBBalance)) ? Balance.Differs : unavailable > 0 ? Balance.Unavailable : Balance.Agrees };
  });
  const identifiers = new Set(tbAccounts.map(tb => normalizeAccountNumber(tb.accountNumber)));
  const extra = glAccounts.filter(gl => !identifiers.has(normalizeAccountNumber(gl.accountNumber)));
  const glOnlyAccountCount = new Set(extra.map(gl => normalizeAccountNumber(gl.accountNumber))).size;
  const warnings: ParserIssue[] = glOnlyAccountCount ? [{ code: 'GL_ACCOUNTS_OUTSIDE_TB', message: `${glOnlyAccountCount} GL accounts are not mapped to the uploaded TB and are outside leadcode selections.` }] : [];
  return { accounts, leadcodes, warnings,
    glOnlyAccountCount,
    availableBalanceCount: accounts.filter(account => account.balanceStatus !== Balance.Unavailable && account.balanceStatus !== Balance.NotTested).length,
    matchedAccountCount: accounts.filter(account => account.mappingStatus === Mapping.Matched || account.mappingStatus === Mapping.NoActivity).length,
    unmatchedAccountCount: accounts.filter(account => account.mappingStatus === Mapping.Unmatched).length,
    noActivityAccountCount: accounts.filter(account => account.mappingStatus === Mapping.NoActivity).length,
    reviewAccountCount: accounts.filter(account => account.mappingStatus === Mapping.Review).length,
    unavailableBalanceCount: accounts.filter(account => account.balanceStatus === Balance.Unavailable).length,
    differingBalanceCount: accounts.filter(account => account.balanceStatus === Balance.Differs).length,
    transactionCount: accounts.reduce((sum, account) => sum + account.transactionCount, 0) };
}
