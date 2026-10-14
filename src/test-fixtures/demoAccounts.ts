import type { TBAccount } from '../models/trialBalance';
import { groupAccountsByLeadcode } from '../utils/leadcodeGrouping';

/** Synthetic display-only records. Never merged into a client session or used for parser detection. */
export const demoAccounts: readonly TBAccount[] = [
  { accountNumber: '0010-00', accountDescription: 'Operating cash', leadcode: 'A', leadcodeDescription: 'Cash and cash equivalents', unadjustedBalance: 82450, finalAdjustedBalance: 82450, priorYearFinalBalance: 74200 },
  { accountNumber: '0010-10', accountDescription: 'Reserve cash', leadcode: 'A', leadcodeDescription: 'Cash and cash equivalents', unadjustedBalance: 115000, finalAdjustedBalance: 115000, priorYearFinalBalance: 105000 },
  { accountNumber: '0120.00', accountDescription: 'Assessments receivable', leadcode: 'B', leadcodeDescription: 'Accounts receivable', unadjustedBalance: 24875, finalAdjustedBalance: 23875, priorYearFinalBalance: 21400 },
  { accountNumber: '1300 A', accountDescription: 'Prepaid insurance', leadcode: 'C', leadcodeDescription: 'Prepaid expenses', unadjustedBalance: 18300, finalAdjustedBalance: 18300, priorYearFinalBalance: 16200 },
  { accountNumber: '2000-01', accountDescription: 'Trade accounts payable', leadcode: 'L', leadcodeDescription: 'Accounts payable and accruals', unadjustedBalance: -42600, finalAdjustedBalance: -44200, priorYearFinalBalance: -38750 },
];
export const demoLeadcodes = groupAccountsByLeadcode(demoAccounts);
