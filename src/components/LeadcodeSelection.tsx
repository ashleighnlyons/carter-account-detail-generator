import type { SessionState, SessionAction } from '../services/sessionState';
import { demoLeadcodes } from '../test-fixtures/demoAccounts';
import { Icon } from './Icon';
import { ReconciliationDetails } from './ReconciliationDetails';

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function LeadcodeSelection({ state, dispatch }: { state: SessionState; dispatch: (action: SessionAction) => void }) {
  const selected = new Set(state.selectedLeadcodes);
  const query = state.search.toLowerCase();
  const allRows = state.demoVisible ? demoLeadcodes : state.analysis?.leadcodes ?? [];
  const enabled = state.demoVisible || !!state.analysis;
  const rows = allRows.filter(group => `${group.leadcode} ${group.leadcodeDescription}`.toLowerCase().includes(query));
  const selection = allRows.filter(group => selected.has(group.leadcode));
  const hasFiles = Object.values(state.files).some(slot => slot.status !== 'empty');
  const pendingMatching = state.generalLedger?.accountMatching?.status === 'requiresConfirmation' && !state.generalLedger.errors.length && state.detection?.recognized;
  return <section className="panel leadcode-panel" aria-labelledby="leadcodes-title">
    <div className="section-heading"><div className="heading-with-step"><span className="step-number">2</span><h2 id="leadcodes-title">Select leadcodes</h2></div><span className={`badge ${state.demoVisible ? 'demo' : state.analysis ? 'success' : 'neutral'}`}>{state.demoVisible ? 'Demo data only' : state.analysis ? 'Parsed client data' : pendingMatching ? 'Mapping confirmation required' : 'Awaiting both files'}</span></div>
    <p className="section-description">The trial balance determines which accounts belong to each leadcode.</p>
    <div className="table-toolbar">
      <label className="search-box"><Icon kind="search" size={17}/><input type="search" aria-label="Search leadcodes" placeholder="Search leadcode or description" value={state.search} disabled={!enabled} onChange={event => dispatch({ type: 'setSearch', value: event.target.value })}/></label>
      <div className="table-actions"><button className="text-button" disabled={!enabled} onClick={() => dispatch({ type: 'setSelection', leadcodes: allRows.map(group => group.leadcode) })}>Select All</button><button className="text-button" disabled={!enabled || !selected.size} onClick={() => dispatch({ type: 'setSelection', leadcodes: [] })}>Clear All</button></div>
    </div>
    <div className="table-scroll"><table><thead><tr><th className="checkbox-cell"><span className="sr-only">Select</span></th><th>Leadcode</th><th>Description</th><th className="numeric">Accounts</th><th className="numeric">Final TB</th><th>GL Match</th></tr></thead><tbody>
      {rows.map(group => <tr key={group.leadcode} className={selected.has(group.leadcode) ? 'selected-row' : ''}><td className="checkbox-cell"><input type="checkbox" aria-label={`Select leadcode ${group.leadcode}`} checked={selected.has(group.leadcode)} onChange={event => dispatch({ type: 'setSelection', leadcodes: event.target.checked ? [...selected, group.leadcode] : [...selected].filter(code => code !== group.leadcode) })}/></td><td className="leadcode-code">{group.leadcode}</td><td>{group.descriptionConflict ? 'Conflicting descriptions — review TB' : group.leadcodeDescription || 'Description unavailable'}</td><td className="numeric">{group.accountCount}</td><td className="numeric tabular">{money.format(group.finalAdjustedTBBalance)}</td><td>{state.demoVisible ? <span className="muted">Not tested</span> : <><span>{group.matchedAccountCount}/{group.accountCount} matched</span><small className={`balance-caption ${group.reconciliationStatus === 'agrees' ? 'success-text' : 'warning-text'}`}>Balance: {group.reconciliationStatus}{group.reviewAccountCount ? ` · ${group.reviewAccountCount} mappings need review` : ''}</small></>}</td></tr>)}
    </tbody></table></div>
    {!rows.length && <div className="empty-state">{enabled ? `No ${state.demoVisible ? 'demo ' : ''}leadcodes match your search.` : pendingMatching ? <><strong>Account mapping requires confirmation</strong><span>The GL was parsed. Confirm its account identifiers and hierarchy against the authoritative same-client CCH trial balance before selecting leadcodes.</span></> : <><strong>Choose and validate both source workbooks</strong><span>A supported CCH TB and a recognized GL with confirmed account identifiers are required.</span><button className="secondary-button compact" disabled={hasFiles} onClick={() => dispatch({ type: 'showDemo' })}>View demo leadcodes</button>{hasFiles && <small>Use Start Over to view the separate demo.</small>}</>}</div>}
    {state.demoVisible && <p className="demo-note">Synthetic demonstration data. These accounts and balances are unrelated to client files. GL transactions are not included.</p>}
    <div className="selection-summary" aria-live="polite"><span><strong>{selection.length}</strong> {state.demoVisible ? 'demo ' : ''}leadcodes selected</span><span><strong>{selection.reduce((total, group) => total + group.accountCount, 0)}</strong> {state.demoVisible ? 'demo ' : ''}accounts selected</span><span><strong>{enabled ? selection.reduce((total, group) => total + (group.transactionCount ?? 0), 0).toLocaleString() : '—'}</strong> {state.demoVisible ? 'demo GL transactions' : state.analysis ? 'GL transactions selected' : 'GL transactions · not processed'}</span></div>
    {state.analysis && <ReconciliationDetails analysis={state.analysis} selectedLeadcodes={state.selectedLeadcodes}/>}
  </section>;
}

