import type { TBAccount } from '../models/trialBalance';
import type { LeadcodeGroup } from '../models/leadcode';
import { BalanceValidationStatus } from '../models/reconciliation';
import { moneyDifference, sumMoney } from './money';

export function groupAccountsByLeadcode(accounts: readonly TBAccount[]): LeadcodeGroup[] {
  const groups = new Map<string, TBAccount[]>();
  const identifiers = new Set<string>();
  for (const account of accounts) {
    if (typeof account.accountNumber !== 'string' || typeof account.leadcode !== 'string') {
      throw new TypeError('Account numbers and leadcodes must be text.');
    }
    if (!account.accountNumber.trim() || !account.leadcode.trim()) throw new Error('Account number and leadcode are required.');
    if (identifiers.has(account.accountNumber)) throw new Error('Duplicate TB account identifier requires review.');
    identifiers.add(account.accountNumber);
    if (![account.unadjustedBalance, account.finalAdjustedBalance, account.priorYearFinalBalance].every(Number.isFinite)) {
      throw new Error('TB balances must be finite numbers.');
    }
    const group = groups.get(account.leadcode) ?? [];
    group.push(account);
    groups.set(account.leadcode, group);
  }
  return [...groups.entries()].map(([leadcode, grouped]) => ({
    leadcode,
    leadcodeDescription: grouped.find(account => account.leadcodeDescription.trim())?.leadcodeDescription ?? '',
    descriptionConflict: new Set(grouped.map(a => a.leadcodeDescription).filter(d => d.trim())).size > 1,
    accountCount: grouped.length,
    accounts: [...grouped],
    unadjustedTBBalance: sumMoney(grouped.map(account => account.unadjustedBalance)),
    finalAdjustedTBBalance: sumMoney(grouped.map(account => account.finalAdjustedBalance)),
    priorYearTBBalance: sumMoney(grouped.map(account => account.priorYearFinalBalance)),
    auditAdjustmentDifference: sumMoney(grouped.map(account => moneyDifference(account.finalAdjustedBalance, account.unadjustedBalance))),
    reconciliationStatus: BalanceValidationStatus.NotTested,
  }));
}
