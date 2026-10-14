import type { GLAccountHierarchy, GLAccountControl, GLAccountSummary, GLTransaction, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookRow, WorkbookSheet } from '../models/workbook';
import type { GLParser, GLParseResult, ParserDetection, ParserIssue, SkippedRowCategory, GLParserDiagnostics } from './types';
import { cellAt, cellText, dateFromCell, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';
import { addCents, balancesAgree, fromCents, moneyDifference, toCents, type Cents } from '../utils/money';

export const QUICKBOOKS_HEADERS = ['Type', 'Date', 'Num', 'Name', 'Memo', 'Split', 'Debit', 'Credit', 'Balance'] as const;
type Column = typeof QUICKBOOKS_HEADERS[number];
type Columns = Record<Column, number>;
interface Layout { sheet: WorkbookSheet; header: WorkbookRow; columns: Columns; hierarchyColumns: number[]; confidence: number; reasons: string[] }
const headerNames = QUICKBOOKS_HEADERS.map(normalizedHeader);
function headerColumns(row: WorkbookRow): Columns | undefined {
  const names = row.cells.map(c => normalizedHeader(cellText(c)));
  if (!headerNames.every(name => names.filter(n => n === name).length === 1)) return;
  return Object.fromEntries(QUICKBOOKS_HEADERS.map((name, i) => [name, names.indexOf(headerNames[i])])) as Columns;
}
function onlyColumns(row: WorkbookRow, allowed: readonly number[]) { return row.cells.every((c, i) => allowed.includes(i) || !c.error && !cellText(c).trim()); }
function hierarchyLabel(row: WorkbookRow, layout: Layout) {
  const found = layout.hierarchyColumns.filter(i => cellText(cellAt(row, i)).trim() || cellAt(row, i).error);
  if (found.length !== 1) return;
  const column = found[0], cell = cellAt(row, column);
  if (cell.error || typeof cell.value !== 'string' || !cell.value.trim()) return;
  return { column, text: cell.value };
}
function layouts(workbook: ParserWorkbook): Layout[] {
  return workbook.sheets.flatMap(sheet => {
    const header = sheet.rows.find(r => r.sourceRowNumber <= 200 && headerColumns(r)); if (!header) return [];
    const columns = headerColumns(header)!, first = Math.min(...Object.values(columns));
    const hierarchyColumns = Array.from({ length: first }, (_, i) => i).filter(i => !cellText(cellAt(header, i)).trim());
    if (!hierarchyColumns.length) return [];
    const layout: Layout = { sheet, header, columns, hierarchyColumns, confidence: 0.4, reasons: ['Distinct Type/Date/Num/Name/Memo/Split/Debit/Credit/Balance columns with separate unlabeled hierarchy slots.'] };
    const headings = new Map<number, Set<string>>(); let paired = false, activity = false, zeroControl = false, report = false;
    for (const row of sheet.rows) {
      if (row.sourceRowNumber <= header.sourceRowNumber) continue;
      const label = hierarchyLabel(row, layout);
      if (label && onlyColumns(row, [label.column, columns.Balance]) && !/^total(?:\s|$)/i.test(label.text.trim())) { const set = headings.get(label.column) ?? new Set(); set.add(label.text); headings.set(label.column, set); }
      if (label && onlyColumns(row, [label.column, columns.Debit, columns.Credit, columns.Balance])) {
        if (label.text.startsWith('Total ') && headings.get(label.column)?.has(label.text.slice(6))) { paired = true; zeroControl ||= cellAt(row, columns.Debit).value === 0 && cellAt(row, columns.Credit).value === 0; }
        if (label.text.trim() === 'TOTAL' && cellText(cellAt(row, columns.Debit)).trim() && cellText(cellAt(row, columns.Credit)).trim()) report = true;
      }
      activity ||= !!dateFromCell(cellAt(row, columns.Date)) && !!cellText(cellAt(row, columns.Type)).trim() && !!cellText(cellAt(row, columns.Split)).trim() && !!cellText(cellAt(row, columns.Balance)).trim();
    }
    if (paired) { layout.confidence += 0.25; layout.reasons.push('Column-aligned exact account heading / Total heading controls.'); }
    if (activity || zeroControl) { layout.confidence += 0.15; layout.reasons.push('Typed dated activity with Split/running balance, or explicit zero-activity controls.'); }
    if (report) { layout.confidence += 0.2; layout.reasons.push('Separate report TOTAL with debit and credit controls.'); }
    layout.confidence = Math.round(layout.confidence * 100) / 100;
    return [layout];
  });
}
export function detectQuickBooks(workbook: ParserWorkbook): ParserDetection {
  const found = layouts(workbook), confident = found.filter(l => l.confidence >= 0.85);
  if (confident.length > 1) return { confidence: 0, reasons: ['Multiple compatible QuickBooks sheets; scope requires review.'] };
  const best = confident[0] ?? found.sort((a, b) => b.confidence - a.confidence)[0];
  return best ? { confidence: best.confidence, reasons: best.reasons } : { confidence: 0, reasons: ['No supported grouped QuickBooks ledger structure.'] };
}
interface Frame {
  identifier: string; column: number; headingRow: number; hierarchy: GLAccountHierarchy;
  beginning?: number; ending?: number; totalRow?: number; totalDebit?: number; totalCredit?: number;
  directCount: number; aggregateCount: number; childCount: number; children: GLAccountControl[];
  debits: Cents[]; credits: Cents[]; lastRunning?: number; lastRunningRow?: number; runningComplete: boolean; reliable: boolean; derived: boolean;
}
export function parseQuickBooksWorkbook(workbook: ParserWorkbook): GLParseResult {
  const sourceMetadata = { parserId: 'quickbooks' as const, workbook: workbook.metadata, parserVersion: '0.6.0' };
  const accountMatching = { status: 'requiresConfirmation' as const, sourceIdentifierDescription: 'Full original QuickBooks heading identifiers and hierarchy paths.', reason: 'Number-like prefixes are not a separate authoritative CCH key. Confirm numbering and posting-level correspondence against the same-client flat CCH TB; no name or prefix mapping is inferred.' };
  const found = layouts(workbook).filter(l => l.confidence >= 0.85);
  if (found.length !== 1) return { transactions: [], accountSummaries: [], accountControls: [], warnings: [], errors: [{ code: 'QUICKBOOKS_SCOPE', message: 'A single supported grouped QuickBooks ledger sheet could not be identified.' }], sourceMetadata, accountMatching };
  const layout = found[0], { sheet, header, columns: c } = layout;
  const transactions: GLTransaction[] = [], accountSummaries: GLAccountSummary[] = [], accountControls: GLAccountControl[] = [];
  const warnings: ParserIssue[] = [], errors: ParserIssue[] = [], stack: Frame[] = [];
  const accountHeadingRows: number[] = [], beginningBalanceRows: number[] = [], endingBalanceRows: number[] = [], accountTotalRows: number[] = [], parentTotalRows: number[] = [], reportTotalRows: number[] = [], ambiguousHierarchyRows: number[] = [];
  const skippedRows: Record<SkippedRowCategory, number> = { reportHeader: 0, columnHeader: 0, accountHeading: 0, beginningBalance: 0, endingBalance: 0, subtotal: 0, blank: 0, reportFooter: 0, review: 0 };
  const reportDebits: Cents[] = [], reportCredits: Cents[] = [], reportFields: Record<string, SourceFieldValue> = Object.create(null);
  let hierarchyLevels = 0, repeatedHeaderCount = 0, numericIdentifierCount = 0, firstNumericRow: number | undefined, derivedEndingBalanceCount = 0, changedColumns = false, reportClosed = false;
  let reportControl: { debit: number; credit: number; endingBalance?: number } | undefined;
  const issue = (code: string, message: string, row?: number): ParserIssue => ({ code, message, sourceSheetName: sheet.name, sourceRowNumber: row });
  function amount(row: WorkbookRow, column: Column, required = false): number | undefined {
    try { const value = monetaryValue(cellAt(row, c[column])); if (value === undefined && required) throw new Error(); return value; }
    catch { errors.push(issue('QUICKBOOKS_INVALID_AMOUNT', `${column} is missing, invalid or outside safe cent precision.`, row.sourceRowNumber)); stack.forEach(f => f.reliable = false); return; }
  }
  const moneySum = (values: readonly Cents[]) => fromCents(addCents(values));
  function finish(frame: Frame) {
    if (frame.totalRow === undefined) { frame.reliable = false; warnings.push(issue('QUICKBOOKS_MISSING_TOTAL', 'Account has no paired closing total; ending validation is unavailable.', frame.headingRow)); }
    const parent = frame.childCount > 0, role = parent ? frame.directCount ? 'postingAndParent' : 'parentAggregate' : 'postingAccount';
    if (parent && frame.directCount) warnings.push(issue('QUICKBOOKS_PARENT_DIRECT_ACTIVITY', 'Parent also posts direct activity. Aggregate balances are preserved as controls but excluded from its primary summary; own balances require review.', frame.headingRow));
    const control: GLAccountControl = { accountIdentifier: frame.identifier, accountHierarchy: frame.hierarchy, role, beginningBalance: frame.beginning, endingBalance: frame.ending, debit: frame.totalDebit, credit: frame.totalCredit, directTransactionCount: frame.directCount, descendantTransactionCount: frame.aggregateCount - frame.directCount, balanceControlsReliable: frame.reliable && frame.ending !== undefined, sourceSheetName: sheet.name, sourceHeadingRowNumber: frame.headingRow, sourceTotalRowNumber: frame.totalRow };
    accountControls.push(control);
    if (!parent || frame.directCount) accountSummaries.push({ accountNumber: frame.identifier, accountDescription: frame.identifier, accountHierarchy: frame.hierarchy, beginningBalance: parent ? undefined : frame.beginning, endingBalance: parent ? undefined : frame.ending, transactionCount: frame.directCount, balanceValidationAvailable: !parent && control.balanceControlsReliable, sourceSheetName: sheet.name, sourceHeadingRowNumber: frame.headingRow, sourceEndingRowNumber: frame.derived ? frame.lastRunningRow : frame.totalRow });
    if (stack.length) stack.at(-1)!.children.push(control);
  }
  function clearContext() { stack.forEach(f => f.reliable = false); while (stack.length) finish(stack.pop()!); }
  function reject(row: WorkbookRow, code: string, message: string) { skippedRows.review++; ambiguousHierarchyRows.push(row.sourceRowNumber); warnings.push(issue(code, message, row.sourceRowNumber)); clearContext(); }
  function fields(row: WorkbookRow, frame: Frame) {
    const result: Record<string, SourceFieldValue> = Object.create(null);
    row.cells.forEach((cell, index) => {
      const original = cellText(cellAt(header, index)).trim() || `Source Column ${index + 1}`;
      const key = Object.hasOwn(result, original) ? `${original} [column ${index + 1}]` : original;
      result[key] = cell.error ?? (index === c.Num ? cell.value === null ? null : cellText(cell) : cell.dateValue ? cell.formattedText ?? cell.dateValue : cell.value);
    });
    for (const [index, identity] of frame.hierarchy.accountPath.entries()) { let key = `Account Heading Level ${index + 1}`, suffix = 1; while (Object.hasOwn(result, key)) key = `Account Heading Level ${index + 1} [context ${suffix++}]`; result[key] = identity; }
    return result;
  }
  for (const row of sheet.rows) {
    if (isBlankRow(row)) { skippedRows.blank++; continue; }
    if (row.sourceRowNumber < header.sourceRowNumber) { skippedRows.reportHeader++; row.cells.forEach((cell, i) => { if (cell.value !== null) reportFields[`Report row ${row.sourceRowNumber} column ${i + 1}`] = cell.dateValue ?? cell.value; }); continue; }
    if (changedColumns) { skippedRows.review++; continue; }
    const repeated = headerColumns(row);
    if (repeated) { if (QUICKBOOKS_HEADERS.every(name => repeated[name] === c[name])) { skippedRows.columnHeader++; if (row.sourceRowNumber !== header.sourceRowNumber) repeatedHeaderCount++; } else { reject(row, 'QUICKBOOKS_COLUMNS_CHANGED', 'Column positions changed in a repeated header; subsequent rows require review.'); changedColumns = true; } continue; }
    const label = hierarchyLabel(row, layout);
    if (label && /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(label.text.trim()) && onlyColumns(row, [label.column])) { skippedRows.reportFooter++; continue; }
    if (label && label.text.trim() === 'TOTAL' && onlyColumns(row, [label.column, c.Debit, c.Credit, c.Balance])) {
      if (stack.length) { warnings.push(issue('QUICKBOOKS_OPEN_REPORT_SCOPE', 'Report total encountered with unclosed accounts; their controls are unavailable.', row.sourceRowNumber)); clearContext(); }
      if (reportClosed) { reject(row, 'QUICKBOOKS_DUPLICATE_REPORT_TOTAL', 'Multiple report totals require scope review.'); reportControl = undefined; continue; }
      const debit = amount(row, 'Debit', true), credit = amount(row, 'Credit', true), endingBalance = amount(row, 'Balance');
      if (debit !== undefined && credit !== undefined) reportControl = { debit, credit, endingBalance };
      reportClosed = true; skippedRows.subtotal++; reportTotalRows.push(row.sourceRowNumber); continue;
    }
    if (reportClosed) { reject(row, 'QUICKBOOKS_ACTIVITY_AFTER_REPORT', 'Non-footer data follows the report TOTAL; no further account context is inferred.'); continue; }
    if (label && label.text.startsWith('Total ') && onlyColumns(row, [label.column, c.Debit, c.Credit, c.Balance])) {
      const frame = stack.at(-1);
      if (!frame || frame.column !== label.column || frame.identifier !== label.text.slice(6)) { reject(row, 'QUICKBOOKS_TOTAL_CONTEXT', 'Closing total does not exactly identify the open account and hierarchy column.'); continue; }
      const before = errors.length; frame.totalRow = row.sourceRowNumber;
      // The inspected export leaves zero-activity totals blank. Only a closed scope with no activity
      // permits these blanks to mean zero; its unchanged beginning/ending is checked below.
      frame.totalDebit = amount(row, 'Debit', frame.aggregateCount > 0) ?? (frame.aggregateCount === 0 ? 0 : undefined);
      frame.totalCredit = amount(row, 'Credit', frame.aggregateCount > 0) ?? (frame.aggregateCount === 0 ? 0 : undefined);
      frame.ending = amount(row, 'Balance');
      try {
        if (errors.length > before || frame.totalDebit === undefined || frame.totalCredit === undefined || !balancesAgree(moneySum(frame.debits), frame.totalDebit) || !balancesAgree(moneySum(frame.credits), frame.totalCredit)) { frame.reliable = false; warnings.push(issue('QUICKBOOKS_ACTIVITY_DIFFERENCE', 'Extracted activity does not agree to the account total; balance validation is unavailable.', row.sourceRowNumber)); }
        if (frame.ending === undefined && !frame.childCount && frame.directCount && frame.runningComplete && frame.lastRunning !== undefined && frame.reliable && frame.beginning !== undefined) { frame.ending = frame.lastRunning; frame.derived = true; derivedEndingBalanceCount++; }
        if (frame.beginning === undefined || frame.ending === undefined) frame.reliable = false;
        else if (!balancesAgree(fromCents(addCents([toCents(frame.beginning), ...frame.debits, ...frame.credits.map(v => -v as Cents)])), frame.ending)) { frame.reliable = false; warnings.push(issue('QUICKBOOKS_ROLLFORWARD_DIFFERENCE', 'Beginning plus debit less credit differs from ending; validation is unavailable.', row.sourceRowNumber)); }
        if (frame.childCount && (!frame.children.every(child => child.balanceControlsReliable) || !frame.directCount && (frame.children.some(child => child.beginningBalance === undefined || child.endingBalance === undefined) || frame.beginning !== undefined && !balancesAgree(moneySum(frame.children.map(child => toCents(child.beginningBalance!))), frame.beginning) || frame.ending !== undefined && !balancesAgree(moneySum(frame.children.map(child => toCents(child.endingBalance!))), frame.ending)))) { frame.reliable = false; warnings.push(issue('QUICKBOOKS_CHILD_COVERAGE', 'Child controls do not reliably cover the parent aggregate.', row.sourceRowNumber)); }
        if (!frame.childCount && frame.directCount && frame.lastRunning !== undefined && frame.ending !== undefined && !balancesAgree(frame.lastRunning, frame.ending)) { frame.reliable = false; warnings.push(issue('QUICKBOOKS_FINAL_RUNNING_DIFFERENCE', 'Final running balance differs from the explicit ending control.', row.sourceRowNumber)); }
      } catch { frame.reliable = false; errors.push(issue('QUICKBOOKS_AMOUNT_RANGE', 'Control aggregation exceeds safe cent precision.', row.sourceRowNumber)); }
      skippedRows.subtotal++; if (frame.childCount) parentTotalRows.push(row.sourceRowNumber); else accountTotalRows.push(row.sourceRowNumber);
      if (!frame.derived && frame.ending !== undefined) endingBalanceRows.push(row.sourceRowNumber);
      stack.pop(); finish(frame); continue;
    }
    if (label && !/^total(?:\s|$)/i.test(label.text.trim()) && onlyColumns(row, [label.column, c.Balance])) {
      if (stack.length && label.column <= stack.at(-1)!.column) { warnings.push(issue('QUICKBOOKS_UNCLOSED_BOUNDARY', 'A new heading interrupted an unclosed account; old controls are unavailable.', row.sourceRowNumber)); clearContext(); }
      const path = [...stack.map(f => f.identifier), label.text], rows = [...stack.map(f => f.headingRow), row.sourceRowNumber], columns = [...stack.map(f => f.column + 1), label.column + 1];
      const hierarchy: GLAccountHierarchy = { accountPath: path, accountDepth: path.length, parentAccountIdentifier: stack.at(-1)?.identifier, sourceHeadingRows: rows, sourceHeadingColumns: columns };
      if (stack.length) stack.at(-1)!.childCount++;
      const frame: Frame = { identifier: label.text, column: label.column, headingRow: row.sourceRowNumber, hierarchy, directCount: 0, aggregateCount: 0, childCount: 0, children: [], debits: [], credits: [], runningComplete: true, reliable: true, derived: false };
      stack.push(frame); frame.beginning = amount(row, 'Balance'); frame.lastRunning = frame.beginning;
      accountHeadingRows.push(row.sourceRowNumber); if (frame.beginning !== undefined) beginningBalanceRows.push(row.sourceRowNumber);
      hierarchyLevels = Math.max(hierarchyLevels, path.length); skippedRows.accountHeading++; continue;
    }
    const date = dateFromCell(cellAt(row, c.Date));
    if (date && !layout.hierarchyColumns.some(i => cellText(cellAt(row, i)).trim() || cellAt(row, i).error)) {
      const frame = stack.at(-1);
      if (!frame) { reject(row, 'QUICKBOOKS_ORPHAN_TRANSACTION', 'Dated activity has no unambiguous open account.'); continue; }
      const before = errors.length, debit = amount(row, 'Debit'), credit = amount(row, 'Credit'), runningBalance = amount(row, 'Balance');
      if (debit === undefined && credit === undefined) errors.push(issue('QUICKBOOKS_MISSING_ACTIVITY', 'Dated activity has neither debit nor credit; no amount is fabricated.', row.sourceRowNumber));
      if (errors.length > before) { stack.forEach(f => f.reliable = false); skippedRows.review++; continue; }
      try {
        const netAmount = moneyDifference(debit ?? 0, credit ?? 0);
        if (runningBalance === undefined || frame.lastRunning === undefined) frame.runningComplete = false;
        else if (!frame.childCount && !balancesAgree(fromCents(addCents([toCents(frame.lastRunning), toCents(netAmount)])), runningBalance)) { frame.reliable = false; warnings.push(issue('QUICKBOOKS_RUNNING_DIFFERENCE', 'Running balance step differs from debit less credit; validation is unavailable.', row.sourceRowNumber)); }
        frame.lastRunning = runningBalance; frame.lastRunningRow = row.sourceRowNumber; frame.directCount++;
        for (const current of stack) { current.aggregateCount++; current.debits.push(toCents(debit ?? 0)); current.credits.push(toCents(credit ?? 0)); }
        reportDebits.push(toCents(debit ?? 0)); reportCredits.push(toCents(credit ?? 0));
        if (typeof cellAt(row, c.Num).value === 'number') { numericIdentifierCount++; firstNumericRow ??= row.sourceRowNumber; }
        const optional = (column: Column) => { const value = cellText(cellAt(row, c[column])); return value.trim() ? value : undefined; };
        transactions.push({ accountNumber: frame.identifier, accountDescription: frame.identifier, accountHierarchy: frame.hierarchy, transactionDate: date, transactionType: optional('Type'), reference: optional('Num'), payeeOrName: optional('Name'), description: optional('Memo'), debit, credit, netAmount, runningBalance, sourceFormat: 'quickbooks', sourceSheetName: sheet.name, sourceRowNumber: row.sourceRowNumber, sourceFields: fields(row, frame) });
      } catch { stack.forEach(f => f.reliable = false); skippedRows.review++; errors.push(issue('QUICKBOOKS_AMOUNT_RANGE', 'Activity cannot retain safe cent precision.', row.sourceRowNumber)); }
      continue;
    }
    reject(row, 'QUICKBOOKS_AMBIGUOUS_BOUNDARY', 'Row is not safely classifiable; hierarchy was cleared to prevent account-context bleed.');
  }
  clearContext();
  accountSummaries.sort((a, b) => a.sourceHeadingRowNumber! - b.sourceHeadingRowNumber!); accountControls.sort((a, b) => a.sourceHeadingRowNumber - b.sourceHeadingRowNumber);
  let sourceControlTotals: GLParserDiagnostics['sourceControlTotals'];
  try {
    if (reportControl) {
      const parsedDebit = moneySum(reportDebits), parsedCredit = moneySum(reportCredits), activityAgrees = balancesAgree(parsedDebit, reportControl.debit) && balancesAgree(parsedCredit, reportControl.credit);
      const primaryEndingBalance = accountSummaries.every(a => a.balanceValidationAvailable && a.endingBalance !== undefined) ? moneySum(accountSummaries.map(a => toCents(a.endingBalance!))) : undefined;
      const endingBalancesAgree = reportControl.endingBalance !== undefined && primaryEndingBalance !== undefined ? balancesAgree(reportControl.endingBalance, primaryEndingBalance) : undefined;
      sourceControlTotals = { ...reportControl, parsedDebit, parsedCredit, primaryEndingBalance, activityAgrees, endingBalancesAgree };
      if (!activityAgrees || endingBalancesAgree === false) warnings.push(issue('QUICKBOOKS_REPORT_DIFFERENCE', 'Parsed activity or primary endings differ from the report control. Source scope requires review.', reportTotalRows[0]));
    } else warnings.push(issue('QUICKBOOKS_REPORT_CONTROL_UNAVAILABLE', 'A unique report total is unavailable; report-wide control validation was not guessed.'));
  } catch { errors.push(issue('QUICKBOOKS_AMOUNT_RANGE', 'Report control aggregation exceeds safe cent precision.')); }
  if (!accountSummaries.length) errors.push(issue('QUICKBOOKS_NO_POSTING_ACCOUNTS', 'No posting or controlled no-activity account summaries were found.'));
  if (numericIdentifierCount) warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', `${numericIdentifierCount.toLocaleString()} numeric Num identifiers were preserved using displayed text; lost source leading zeros cannot be recovered.`, firstNumericRow));
  warnings.push(issue('ACCOUNT_MATCHING_REQUIRES_CONFIRMATION', 'QuickBooks full heading identities and posting-level correspondence require authoritative same-client CCH confirmation; no prefix/name matching is inferred.'));
  return { transactions, accountSummaries, accountControls, warnings, errors, accountMatching, sourceMetadata: { ...sourceMetadata, reportFields }, diagnostics: { detectedSheet: sheet.name, headerRowNumber: header.sourceRowNumber, accountHeadingRows, beginningBalanceRows, endingBalanceRows, accountTotalRows, parentTotalRows, reportTotalRows, ambiguousHierarchyRows, subtotalRows: [...accountTotalRows, ...parentTotalRows].sort((a, b) => a - b), repeatedHeaderCount, skippedRows, transactionCount: transactions.length, endingBalanceCount: accountSummaries.filter(a => a.endingBalance !== undefined && endingBalanceRows.includes(a.sourceEndingRowNumber!)).length, reliableEndingBalanceCount: accountSummaries.filter(a => a.balanceValidationAvailable).length, warningCount: warnings.length, numericIdentifierCount, hierarchyLevels, postingAccountCount: accountSummaries.length, parentControlAccountCount: accountControls.filter(a => a.role !== 'postingAccount').length, derivedEndingBalanceCount, sourceControlTotals } };
}
export const quickbooksParser: GLParser = { id: 'quickbooks', displayName: 'QuickBooks General Ledger', implemented: true, detect: detectQuickBooks, parse: async workbook => parseQuickBooksWorkbook(workbook) };
