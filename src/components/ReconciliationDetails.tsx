import type { AnalysisResult } from '../models/processing';
const dollars = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = (value?: number) => value === undefined ? 'Unavailable' : dollars.format(value);

export function ReconciliationDetails({ analysis, selectedLeadcodes }: { analysis: AnalysisResult; selectedLeadcodes: readonly string[] }) {
  const selected = new Set(selectedLeadcodes);
  const groups = selected.size ? analysis.leadcodes.filter(group => selected.has(group.leadcode)) : analysis.leadcodes;
  const accounts = groups.flatMap(group => group.accountReconciliations ?? []);
  return <div className="reconciliation-details">
    <details><summary>Leadcode balances</summary><p className="detail-note">GL totals are unavailable unless every TB account in the leadcode has a reliable, unambiguous ending balance. Final TB adjustments are shown separately.</p>
      <div className="table-scroll detail-table"><table><thead><tr><th>Leadcode</th><th className="numeric">Unadjusted TB</th><th className="numeric">Final Adjusted TB</th><th className="numeric">GL Ending Balance</th><th className="numeric">GL vs Unadjusted TB</th><th className="numeric">Audit Adjustment Difference</th><th>Balance Status</th></tr></thead><tbody>{groups.map(group => <tr key={group.leadcode}><td>{group.leadcode}</td><td className="numeric">{amount(group.unadjustedTBBalance)}</td><td className="numeric">{amount(group.finalAdjustedTBBalance)}</td><td className="numeric">{amount(group.glEndingBalance)}</td><td className="numeric">{amount(group.glVsUnadjustedDifference)}</td><td className="numeric">{amount(group.auditAdjustmentDifference)}</td><td>{group.reconciliationStatus}</td></tr>)}</tbody></table></div>
    </details>
    <details><summary>Account reconciliation ({accounts.length} accounts)</summary><p className="detail-note">{selected.size ? 'Showing selected leadcodes.' : 'Showing all leadcodes.'} Agreement compares GL Ending Balance to Unadjusted TB with a $0.01 tolerance. Mapping and balance status are separate.</p>
      <div className="table-scroll detail-table"><table><thead><tr><th>Leadcode</th><th>Account Number</th><th>Account Description</th><th className="numeric">Unadjusted TB</th><th className="numeric">Final Adjusted TB</th><th className="numeric">GL Ending Balance</th><th className="numeric">GL vs Unadjusted TB Difference</th><th className="numeric">Audit Adjustment Difference</th><th>Mapping Status</th><th>Balance Status</th></tr></thead><tbody>{accounts.map(account => <tr key={account.accountNumber}><td>{account.tb.leadcode}</td><td>{account.accountNumber}</td><td>{account.tb.accountDescription}</td><td className="numeric">{amount(account.unadjustedTB)}</td><td className="numeric">{amount(account.finalAdjustedTB)}</td><td className="numeric">{amount(account.glEndingBalance)}</td><td className="numeric">{amount(account.glVsUnadjustedDifference)}</td><td className="numeric">{amount(account.auditAdjustmentDifference)}</td><td>{account.mappingStatus}</td><td className={account.balanceStatus === 'agrees' ? 'success-text' : 'warning-text'}>{account.balanceStatus}</td></tr>)}</tbody></table></div>
    </details>
  </div>;
}
