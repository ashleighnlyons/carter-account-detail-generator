import type { SessionState } from '../services/sessionState';
import { SourceContext } from './SourceContext';
import type { ParserIssue } from '../parsers/types';
import { sourceIdentifierCoverage } from '../services/sourceIdentifierCoverage';

function Issues({ issues, label }: { issues: readonly ParserIssue[]; label: string }) {
  if (!issues.length) return null;
  return <details className="issue-details"><summary>{label} ({issues.length})</summary><ul>{issues.map((issue, index) => <li key={index}>
    {issue.sourceSheetName && <span className="issue-location">{issue.sourceSheetName}{issue.sourceRowNumber ? ` · row ${issue.sourceRowNumber}` : ''}: </span>}{issue.message}
  </li>)}</ul></details>;
}

export function ValidationPanel({ state }: { state: SessionState }) {
  const tb = state.trialBalance, gl = state.generalLedger, analysis = state.analysis;
  const errors = [...tb?.errors ?? [], ...gl?.errors ?? [], ...state.processingErrors ?? []];
  const warnings = [...tb?.warnings ?? [], ...gl?.warnings ?? [], ...analysis?.warnings ?? []];
  const tbValid = !!tb && !tb.errors.length, glValid = !!gl && !gl.errors.length && state.detection?.recognized;
  const glName = state.detection?.displayName ?? 'General Ledger';
  const pendingMatching = glValid && gl?.accountMatching?.status === 'requiresConfirmation';
  const coverage = pendingMatching && tbValid ? sourceIdentifierCoverage(tb!.accounts, gl!.accountSummaries) : undefined;
  const reading = Object.values(state.files).some(slot => slot.status === 'reading');
  const nextStep = errors.length ? 'Correct the source issues before account matching can continue.' : reading ? 'Processing locally in your browser…' : pendingMatching ? `${glName} successfully parsed. Account matching requires confirmation against the authoritative same-client CCH trial balance.` : analysis ? 'Ready for leadcode selection. Balance comparisons use Unadjusted TB with a $0.01 tolerance.' : tbValid ? 'Trial balance is ready. Choose a Yardi, AppFolio, OneSite, FirstService, QuickBooks or Vantaca general ledger to continue.' : glValid ? `${glName} is ready. Choose a supported CCH trial balance to continue.` : 'Choose a CCH trial balance and a Yardi, AppFolio, OneSite, FirstService, QuickBooks or Vantaca general ledger.';
  return <section className="panel validation-panel" aria-labelledby="validation-title">
    <div className="section-heading"><h2 id="validation-title">File validation</h2><span className={`badge ${analysis ? 'success' : 'neutral'}`}>{analysis ? 'Processing complete' : pendingMatching ? 'GL parsed · Mapping pending' : 'Local validation'}</span></div>
    <dl className="validation-grid">
      <div><dt>Trial balance structure</dt><dd className={tbValid ? 'success-text' : tb?.errors.length ? 'error-text' : ''}>{tbValid ? <><span>Trial balance structure valid</span><small className="balance-caption">{tb!.diagnostics.format === 'published-cch' ? 'CCH Published Leadcode Trial Balance' : 'Carter/CCH Flat Trial Balance'} recognized — {tb!.accounts.length.toLocaleString()} accounts | {new Set(tb!.accounts.map(a => a.leadcode)).size} leadcodes</small></> : tb?.errors.length ? 'Trial balance needs correction' : 'Not validated'}</dd></div>
      <div><dt>GL format recognition</dt><dd className={glValid ? 'success-text' : gl?.errors.length ? 'error-text' : ''}>{glValid ? `${glName} recognized` : gl?.errors.length ? 'GL needs review' : 'Waiting for GL'}</dd></div>
      <div><dt>Matched accounts</dt><dd>{analysis ? `${analysis.matchedAccountCount} of ${analysis.accounts.length} TB accounts matched` : pendingMatching ? 'Pending confirmation' : <>— <span>Not processed</span></>}</dd></div>
      <div><dt>Unmatched accounts</dt><dd>{analysis ? `${analysis.unmatchedAccountCount} unmatched accounts` : pendingMatching ? 'Pending confirmation' : <>— <span>Not processed</span></>}</dd></div>
    </dl>
    {analysis && <div className="reconciliation-counts"><span>{analysis.glOnlyAccountCount} GL accounts are not mapped to the uploaded TB</span><span>{analysis.availableBalanceCount} TB accounts with balance validation available</span><span>{analysis.unavailableBalanceCount} accounts with unavailable balance validation</span><span>{analysis.differingBalanceCount} accounts with GL/TB differences</span><span>{analysis.noActivityAccountCount} matched accounts with no activity</span><span>{analysis.reviewAccountCount} account mappings requiring review</span></div>}
    {pendingMatching && <div className="reconciliation-counts"><span>{coverage ? `GL-only identifier count (unconfirmed): ${coverage.glOnlyIdentifierCount}` : 'Choose a same-client CCH TB to review source-identifier coverage.'}</span><span>Source account identifiers only; TB reconciliation and leadcode selection are pending confirmation.</span></div>}
    <SourceContext state={state}/>
    <p className={`placeholder-note ${analysis ? 'ready-note' : errors.length ? 'blocking-note' : pendingMatching ? 'warning-note' : ''}`}>{nextStep}</p>
    <div className="validation-details"><Issues issues={errors} label="Blocking issues"/><Issues issues={warnings} label="Warnings and review items"/>
      {!warnings.length && (tb || gl) && <p className="muted small">No source validation warnings.</p>}
      {(tb || gl) && <details className="diagnostic-details"><summary>Source details (local only)</summary>
        {tb && <p>TB worksheet: {tb.diagnostics.detectedSheet ?? 'No compatible sheet'} · Header row {tb.diagnostics.headerRowNumber ?? 'not found'} · {tb.accounts.length} account records</p>}
        {tb?.diagnostics.skippedRows && <p>TB excluded rows: {Object.entries(tb.diagnostics.skippedRows).map(([kind,count])=>`${kind}: ${count}`).join(' · ')}</p>}
        {gl?.diagnostics?.workbookType && <p>Workbook type: {gl.diagnostics.workbookType.toUpperCase()} · {gl.accountSummaries.filter(a => !a.transactionCount).length} accounts with no activity · {gl.diagnostics.reportTotalRows?.length ?? 0} report totals</p>}
        {gl?.diagnostics && <><p>GL: {gl.diagnostics.detectedSheet} · Header row {gl.diagnostics.headerRowNumber} · {gl.accountSummaries.length} account summaries · {gl.transactions.length.toLocaleString()} transactions</p><p>{gl.diagnostics.accountHeadingRows.length} account headings · {gl.diagnostics.endingBalanceCount} explicit ending balances · {gl.diagnostics.reliableEndingBalanceCount} reliable ending balances</p><p>Skipped rows: {Object.entries(gl.diagnostics.skippedRows).map(([category, count]) => `${category}: ${count}`).join(' · ')}</p></>}
        {gl?.diagnostics && <p>{gl.accountSummaries.length - gl.diagnostics.reliableEndingBalanceCount} GL accounts without reliable balance validation · {gl.warnings.length} parser warnings · {gl.diagnostics.skippedRows.review} review rows{gl.diagnostics.beginningBalanceRows && <> · {gl.diagnostics.beginningBalanceRows.length} beginning-balance controls · {gl.diagnostics.subtotalRows?.length ?? 0} account-total controls · {gl.diagnostics.repeatedHeaderCount ?? 0} repeated headers</>}{analysis && <> · {analysis.glOnlyAccountCount} GL-only accounts</>}</p>}
        {gl?.diagnostics?.subaccountHeadingRows && <><p>{gl.diagnostics.accountHeadingRows.length} main accounts · {gl.diagnostics.subaccountHeadingRows.length} subaccount sections · {gl.diagnostics.subaccountTotalRows?.length ?? 0} subaccount totals · {gl.diagnostics.subaccountEndingRows?.length ?? 0} subaccount endings · {gl.diagnostics.mainAccountTotalRows?.length ?? 0} main-account totals · {gl.diagnostics.reportTotalRows?.length ?? 0} report totals · {gl.diagnostics.ambiguousHierarchyRows?.length ?? 0} ambiguous hierarchy rows</p><p>{gl.accountSummaries.filter(a => !a.transactionCount).length} main accounts with no activity · {gl.subaccountSummaries?.filter(a => !a.transactionCount).length ?? 0} subaccount sections with no activity · {gl.subaccountSummaries?.filter(a => a.balanceControlsReliable).length ?? 0} reliable subaccount balances</p></>}
        {gl?.diagnostics?.hierarchyLevels && <><p>{gl.diagnostics.hierarchyLevels} hierarchy levels · {gl.diagnostics.postingAccountCount} posting/no-activity account summaries · {gl.diagnostics.parentControlAccountCount} parent/control accounts · {gl.diagnostics.accountTotalRows?.length ?? 0} account totals · {gl.diagnostics.parentTotalRows?.length ?? 0} parent totals · {gl.diagnostics.reportTotalRows?.length ?? 0} report totals</p><p>{gl.accountSummaries.filter(a => !a.transactionCount).length} posting accounts with no activity · {gl.diagnostics.derivedEndingBalanceCount ?? 0} endings derived from controlled final running balances · {gl.accountMatching ? gl.accountSummaries.length : 0} source identities pending CCH confirmation</p></>}
        {gl?.diagnostics?.sourceControlTotals && <p>Source report controls: debit {gl.diagnostics.sourceControlTotals.debit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · credit {gl.diagnostics.sourceControlTotals.credit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · extracted activity {gl.diagnostics.sourceControlTotals.activityAgrees ? 'agrees' : 'differs'}{gl.diagnostics.sourceControlTotals.endingBalancesAgree !== undefined && <> · primary ending balances {gl.diagnostics.sourceControlTotals.endingBalancesAgree ? 'agree' : 'differ'}</>}</p>}
        {pendingMatching && <p>Source balance controls only; TB reconciliation pending confirmation. {gl!.accountMatching!.sourceIdentifierDescription} Confirm posting-level account identifiers using the same-client CCH trial balance and authoritative import mapping.{coverage && <> GL-only source identifiers: {coverage.glOnlyIdentifierCount} (unconfirmed).</>}</p>}
        {state.detection && <p>General ledger layout: {state.detection.displayName??'Unrecognized export'}. {state.detection.recognized?'The source layout was recognized.':'Obtain a supported standard export or contact the utility maintainer.'}</p>}
      </details>}
    </div>
  </section>;
}
