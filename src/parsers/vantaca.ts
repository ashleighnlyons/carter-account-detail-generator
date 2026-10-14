import type { GLAccountSummary, GLTransaction, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookRow, WorkbookSheet } from '../models/workbook';
import type { GLParser, GLParseResult, GLParserDiagnostics, ParserDetection, ParserIssue, SkippedRowCategory } from './types';
import { cellAt, cellText, dateFromCell, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';
import { addCents, balancesAgree, fromCents, moneyDifference, toCents, type Cents } from '../utils/money';

export const VANTACA_COLUMNS = ['Date', 'Ledger ID', 'Description', 'Debit', 'Credit', 'Type'] as const;
export const VANTACA_CONTROL_COLUMNS = ['Beginning Balance', 'Debit', 'Credit', 'Ending Balance'] as const;
type Column = typeof VANTACA_COLUMNS[number];
type ControlColumn = typeof VANTACA_CONTROL_COLUMNS[number];
type Columns = Record<Column, number>;
type ControlColumns = Record<ControlColumn, number>;
type ControlSpans = Record<ControlColumn, readonly number[]>;
interface Layout { sheet: WorkbookSheet; header: WorkbookRow; controlHeader: WorkbookRow; columns: Columns; controls: ControlColumns; spans: ControlSpans; confidence: number; reasons: string[] }
function headerPositions<T extends string>(row: WorkbookRow, labels: readonly T[]): Record<T, number> | undefined {
  const names = row.cells.map(c => normalizedHeader(cellText(c)));
  if (!labels.every(label => names.filter(n => n === normalizedHeader(label)).length === 1)) return;
  return Object.fromEntries(labels.map(label => [label, names.indexOf(normalizedHeader(label))])) as Record<T, number>;
}
function headerCandidate(row: WorkbookRow, labels: readonly string[]) {
  const names = row.cells.map(c => normalizedHeader(cellText(c)));
  return labels.every(label => names.includes(normalizedHeader(label)));
}
function onlyColumns(row: WorkbookRow, allowed: readonly number[]) { return row.cells.every((cell, i) => allowed.includes(i) || !cell.error && !cellText(cell).trim()); }
function spansFor(sheet: WorkbookSheet, row: WorkbookRow, columns: ControlColumns): ControlSpans {
  const result: ControlSpans = { 'Beginning Balance': [], Debit: [], Credit: [], 'Ending Balance': [] };
  for (const label of VANTACA_CONTROL_COLUMNS) {
    const index = columns[label], merge = sheet.mergedRanges?.find(m => m.startRow === row.sourceRowNumber && m.endRow === row.sourceRowNumber && m.startColumn === index + 1);
    result[label] = merge ? Array.from({ length: merge.endColumn - merge.startColumn + 1 }, (_, i) => index + i) : [index];
  }
  return result;
}
function controlLabel(row: WorkbookRow, layout: Layout) {
  const monetarySlots = Object.values(layout.spans).flat();
  const possible = row.cells.flatMap((cell, index) => !monetarySlots.includes(index) && index < Math.min(...Object.values(layout.controls)) && (cell.error || cellText(cell).trim()) ? [index] : []);
  if (possible.length !== 1) return;
  const column = possible[0], source = cellAt(row, column);
  if (source.error || typeof source.value !== 'string' || !onlyColumns(row, [column, ...monetarySlots])) return;
  return { column, text: source.value };
}
/** Exact delimiter defines a source code/description pair; neither part is numerically coerced. */
function splitHeading(text: string) {
  const separator = text.indexOf(' - '); if (separator < 0) return;
  const accountNumber = text.slice(0, separator), accountDescription = text.slice(separator + 3);
  if (!accountNumber.trim() || !accountDescription.trim()) return;
  return { accountNumber, accountDescription };
}
function layouts(workbook: ParserWorkbook): Layout[] {
  return workbook.sheets.flatMap(sheet => {
    const header = sheet.rows.find(r => r.sourceRowNumber <= 200 && headerCandidate(r, VANTACA_COLUMNS)), controlHeader = sheet.rows.find(r => r.sourceRowNumber <= 200 && headerCandidate(r, VANTACA_CONTROL_COLUMNS));
    if (!header || !controlHeader || !headerPositions(header, VANTACA_COLUMNS) || !headerPositions(controlHeader, VANTACA_CONTROL_COLUMNS)) return [];
    const columns = headerPositions(header, VANTACA_COLUMNS)!, controls = headerPositions(controlHeader, VANTACA_CONTROL_COLUMNS)!;
    if (columns.Debit !== controls.Debit || columns.Credit !== controls.Credit || controlHeader.sourceRowNumber >= header.sourceRowNumber) return [];
    const spans = spansFor(sheet, controlHeader, controls);
    if (new Set(Object.values(spans).flat()).size !== Object.values(spans).flat().length) return [];
    const layout: Layout = { sheet, header, controlHeader, columns, controls, spans, confidence: 0.7, reasons: ['Unique Date/Ledger ID/Description/Debit/Credit/Type detail headers and Beginning/Debit/Credit/Ending account controls with shared activity positions.'] };
    const body = sheet.rows.filter(r => r.sourceRowNumber > controlHeader.sourceRowNumber);
    if (body.some(row => { const label = controlLabel(row, layout); return label && splitHeading(label.text) && VANTACA_CONTROL_COLUMNS.every(name => spans[name].some(i => cellAt(row, i).error || cellText(cellAt(row, i)).trim())); })) { layout.confidence += 0.2; layout.reasons.push('Flat text account-code/description headings carry all four monetary control groups.'); }
    if (body.some(row => controlLabel(row, layout)?.text.trim().toLowerCase() === 'net total')) { layout.confidence += 0.1; layout.reasons.push('Separate Net Total for report-level balance and activity controls.'); }
    layout.confidence = Math.round(layout.confidence * 100) / 100; return [layout];
  });
}
export function detectVantaca(workbook: ParserWorkbook): ParserDetection {
  const found = layouts(workbook), confident = found.filter(l => l.confidence >= 0.85);
  if (confident.length > 1) return { confidence: 0, reasons: ['Multiple compatible Vantaca reports; scope requires review.'] };
  const best = confident[0] ?? found.sort((a, b) => b.confidence - a.confidence)[0];
  return best ? { confidence: best.confidence, reasons: best.reasons } : { confidence: 0, reasons: ['No supported GL Trial Balance account-control/detail structure.'] };
}
interface Context {
  accountNumber: string; accountDescription: string; originalHeading: string; headingRow: number; labelColumn: number;
  beginning?: number; ending?: number; debitControl?: number; creditControl?: number;
  count: number; debits: Cents[]; credits: Cents[]; reliable: boolean; headerSeen: boolean;
}
export function parseVantacaWorkbook(workbook: ParserWorkbook): GLParseResult {
  const sourceMetadata = { parserId: 'vantaca' as const, workbook: workbook.metadata, parserVersion: '0.7.0' };
  const found = layouts(workbook).filter(l => l.confidence >= 0.85);
  if (found.length !== 1) return { transactions: [], accountSummaries: [], warnings: [], errors: [{ code: 'VANTACA_SCOPE', message: 'A single supported Vantaca account-control/detail report was not identified.' }], sourceMetadata };
  const layout = found[0], { sheet, header, controlHeader, columns: c } = layout;
  const transactions: GLTransaction[] = [], accountSummaries: GLAccountSummary[] = [], warnings: ParserIssue[] = [], errors: ParserIssue[] = [];
  const accountHeadingRows: number[] = [], beginningBalanceRows: number[] = [], endingBalanceRows: number[] = [], accountTotalRows: number[] = [], reportTotalRows: number[] = [];
  const skippedRows: Record<SkippedRowCategory, number> = { reportHeader: 0, columnHeader: 0, accountHeading: 0, beginningBalance: 0, endingBalance: 0, subtotal: 0, blank: 0, reportFooter: 0, review: 0 };
  const reportFields: Record<string, SourceFieldValue> = Object.create(null), prefixLabels = new Set<string>();
  const reportDebits: Cents[] = [], reportCredits: Cents[] = [];
  let context: Context | undefined, accountLabelColumn: number | undefined, repeatedHeaderCount = 0, numericIdentifierCount = 0, firstNumericRow: number | undefined, changedColumns = false, reportClosed = false;
  let reportControl: { debit: number; credit: number; beginningBalance?: number; endingBalance?: number } | undefined;
  const issue = (code: string, message: string, row?: number): ParserIssue => ({ code, message, sourceSheetName: sheet.name, sourceRowNumber: row });
  const moneySum = (values: readonly Cents[]) => fromCents(addCents(values));
  function finish() {
    if (!context) return;
    try {
      if (context.beginning === undefined || context.ending === undefined || context.debitControl === undefined || context.creditControl === undefined) { context.reliable = false; warnings.push(issue('VANTACA_CONTROL_UNAVAILABLE', 'Account lacks complete beginning/activity/ending controls; balance validation is unavailable.', context.headingRow)); }
      else {
        if (!balancesAgree(moneySum(context.debits), context.debitControl) || !balancesAgree(moneySum(context.credits), context.creditControl)) { context.reliable = false; warnings.push(issue('VANTACA_ACTIVITY_DIFFERENCE', 'Extracted debit/credit differs from account-heading controls; validation is unavailable.', context.headingRow)); }
        const expected = fromCents(addCents([toCents(context.beginning), ...context.debits, ...context.credits.map(v => -v as Cents)]));
        if (!balancesAgree(expected, context.ending)) { context.reliable = false; warnings.push(issue('VANTACA_ROLLFORWARD_DIFFERENCE', 'Beginning plus activity differs from explicit ending; validation is unavailable.', context.headingRow)); }
      }
    } catch { context.reliable = false; errors.push(issue('VANTACA_AMOUNT_RANGE', 'Account control aggregation exceeds safe cent precision.', context.headingRow)); }
    accountSummaries.push({ accountNumber: context.accountNumber, accountDescription: context.accountDescription, beginningBalance: context.beginning, endingBalance: context.ending, transactionCount: context.count, balanceValidationAvailable: context.reliable && context.ending !== undefined, sourceSheetName: sheet.name, sourceHeadingRowNumber: context.headingRow, sourceEndingRowNumber: context.ending !== undefined ? context.headingRow : undefined });
    context = undefined;
  }
  function reject(row: WorkbookRow, code: string, message: string, blocking = false) { skippedRows.review++; (blocking ? errors : warnings).push(issue(code, message, row.sourceRowNumber)); if (context) context.reliable = false; finish(); }
  function controlAmount(row: WorkbookRow, label: ControlColumn) {
    const cells = layout.spans[label].filter(i => cellAt(row, i).error || cellText(cellAt(row, i)).trim());
    if (cells.length > 1) { errors.push(issue('VANTACA_AMBIGUOUS_CONTROL', `${label} has multiple populated cells in its logical merge span; no value was chosen.`, row.sourceRowNumber)); return; }
    try { return cells.length ? monetaryValue(cellAt(row, cells[0])) : undefined; }
    catch { errors.push(issue('VANTACA_INVALID_AMOUNT', `${label} is invalid or outside safe cent precision.`, row.sourceRowNumber)); return; }
  }
  function activityAmount(row: WorkbookRow, label: 'Debit' | 'Credit') {
    try { return monetaryValue(cellAt(row, c[label])); }
    catch { errors.push(issue('VANTACA_INVALID_AMOUNT', `${label} is invalid or outside safe cent precision.`, row.sourceRowNumber)); return; }
  }
  function sourceFields(row: WorkbookRow) {
    const fields: Record<string, SourceFieldValue> = Object.create(null);
    row.cells.forEach((cell, index) => {
      const original = cellText(cellAt(header, index)).trim() || `Source Column ${index + 1}`, key = Object.hasOwn(fields, original) ? `${original} [column ${index + 1}]` : original;
      fields[key] = cell.error ?? (index === c['Ledger ID'] ? cell.value === null ? null : cellText(cell) : cell.dateValue ? cell.formattedText ?? cell.dateValue : cell.value);
    });
    for (const [name, value] of [['Original Account Heading', context!.originalHeading], ...Object.entries(reportFields)]) { let key = name, suffix = 1; while (Object.hasOwn(fields, key)) key = `${name} [context ${suffix++}]`; fields[key] = value; }
    return fields;
  }
  for (const row of sheet.rows) {
    if (isBlankRow(row)) { skippedRows.blank++; continue; }
    if (row.sourceRowNumber < controlHeader.sourceRowNumber) { skippedRows.reportHeader++; row.cells.forEach((cell, i) => { if (cell.value !== null && cellText(cell).trim()) { reportFields[`Report row ${row.sourceRowNumber} column ${i + 1}`] = cell.dateValue ?? cell.value; if (onlyColumns(row, [i])) prefixLabels.add(cellText(cell)); } }); continue; }
    if (changedColumns) { skippedRows.review++; continue; }
    const detail = headerPositions(row, VANTACA_COLUMNS), controls = headerPositions(row, VANTACA_CONTROL_COLUMNS);
    if (controls) {
      const spans = spansFor(sheet, row, controls);
      if (!VANTACA_CONTROL_COLUMNS.every(name => controls[name] === layout.controls[name] && JSON.stringify(spans[name]) === JSON.stringify(layout.spans[name]))) { reject(row, 'VANTACA_COLUMNS_CHANGED', 'Repeated control positions changed; subsequent data requires review.', true); changedColumns = true; }
      else { skippedRows.columnHeader++; if (row.sourceRowNumber !== controlHeader.sourceRowNumber) repeatedHeaderCount++; } continue;
    }
    if (detail) {
      if (!VANTACA_COLUMNS.every(name => detail[name] === c[name])) { reject(row, 'VANTACA_COLUMNS_CHANGED', 'Repeated detail positions changed; subsequent data requires review.', true); changedColumns = true; }
      else { skippedRows.columnHeader++; if (row.sourceRowNumber !== header.sourceRowNumber) repeatedHeaderCount++; if (context?.headerSeen) reject(row, 'VANTACA_REPEATED_HEADER_SCOPE', 'A repeated detail header has no fresh account heading; subsequent activity requires scope review.', true); else if (context) context.headerSeen = true; } continue;
    }
    const nonblank = row.cells.flatMap((cell, i) => cellText(cell).trim() ? [i] : []);
    if (nonblank.length === 1 && !cellAt(row, nonblank[0]).error && prefixLabels.has(cellText(cellAt(row, nonblank[0])))) { skippedRows.reportHeader++; continue; }
    if (nonblank.length === 1 && /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(cellText(cellAt(row, nonblank[0])).trim())) { skippedRows.reportFooter++; continue; }
    const label = controlLabel(row, layout);
    if (label && label.text.trim().toLowerCase() === 'net total') {
      finish(); if (reportClosed) { reject(row, 'VANTACA_DUPLICATE_REPORT_TOTAL', 'Multiple Net Total rows require source scope review.', true); reportControl = undefined; continue; }
      const debit = controlAmount(row, 'Debit'), credit = controlAmount(row, 'Credit'), beginningBalance = controlAmount(row, 'Beginning Balance'), endingBalance = controlAmount(row, 'Ending Balance');
      if (debit !== undefined && credit !== undefined) reportControl = { debit, credit, beginningBalance, endingBalance };
      else warnings.push(issue('VANTACA_REPORT_CONTROL_UNAVAILABLE', 'Report activity controls are incomplete; no report total was inferred.', row.sourceRowNumber));
      reportClosed = true; skippedRows.subtotal++; reportTotalRows.push(row.sourceRowNumber); continue;
    }
    if (reportClosed) { reject(row, 'VANTACA_AFTER_REPORT', 'Unexpected data follows Net Total; no account context was reopened.', true); continue; }
    const heading = label && splitHeading(label.text);
    if (label && heading) {
      finish(); if (accountLabelColumn !== undefined && label.column !== accountLabelColumn) { reject(row, 'VANTACA_ACCOUNT_COLUMN_CHANGED', 'Account heading position changed; an unproven hierarchy was not assigned.', true); continue; }
      accountLabelColumn ??= label.column; const before = errors.length;
      const beginning = controlAmount(row, 'Beginning Balance'), ending = controlAmount(row, 'Ending Balance'), debitControl = controlAmount(row, 'Debit'), creditControl = controlAmount(row, 'Credit');
      context = { ...heading, originalHeading: label.text, headingRow: row.sourceRowNumber, labelColumn: label.column, beginning, ending, debitControl, creditControl, count: 0, debits: [], credits: [], headerSeen: false, reliable: errors.length === before };
      accountHeadingRows.push(row.sourceRowNumber); accountTotalRows.push(row.sourceRowNumber); if (beginning !== undefined) beginningBalanceRows.push(row.sourceRowNumber); if (ending !== undefined) endingBalanceRows.push(row.sourceRowNumber); skippedRows.accountHeading++; continue;
    }
    const date = dateFromCell(cellAt(row, c.Date));
    if (date) {
      if (!context || !context.headerSeen) { reject(row, 'VANTACA_ORPHAN_TRANSACTION', 'Dated activity lacks a confident account heading/detail-header scope; no carry-forward was guessed.', true); continue; }
      const before = errors.length, debit = activityAmount(row, 'Debit'), credit = activityAmount(row, 'Credit');
      if (debit === undefined && credit === undefined) errors.push(issue('VANTACA_MISSING_AMOUNT', 'Dated activity has no explicit debit or credit; no zero amount was invented.', row.sourceRowNumber));
      const allowed = new Set([...Object.values(c), ...header.cells.flatMap((cell, i) => cellText(cell).trim() ? [i] : [])]);
      if (!onlyColumns(row, [...allowed])) { reject(row, 'VANTACA_TRANSACTION_SCOPE', 'Dated row has data outside the discovered detail columns; account assignment requires review.', true); continue; }
      if (errors.length > before) { context.reliable = false; skippedRows.review++; continue; }
      try {
        const netAmount = moneyDifference(debit ?? 0, credit ?? 0), optional = (name: Column) => { const value = cellText(cellAt(row, c[name])); return value.trim() ? value : undefined; };
        if (typeof cellAt(row, c['Ledger ID']).value === 'number') { numericIdentifierCount++; firstNumericRow ??= row.sourceRowNumber; }
        transactions.push({ accountNumber: context.accountNumber, accountDescription: context.accountDescription, transactionDate: date, transactionType: optional('Type'), reference: optional('Ledger ID'), description: optional('Description'), debit, credit, netAmount, sourceFormat: 'vantaca', sourceSheetName: sheet.name, sourceRowNumber: row.sourceRowNumber, sourceFields: sourceFields(row) });
        context.count++; context.debits.push(toCents(debit ?? 0)); context.credits.push(toCents(credit ?? 0)); reportDebits.push(toCents(debit ?? 0)); reportCredits.push(toCents(credit ?? 0));
      } catch { context.reliable = false; skippedRows.review++; errors.push(issue('VANTACA_AMOUNT_RANGE', 'Activity cannot retain safe cent precision.', row.sourceRowNumber)); }
      continue;
    }
    reject(row, 'VANTACA_AMBIGUOUS_BOUNDARY', 'Unclassified row ended account context; following activity will not inherit it.', !!cellText(cellAt(row, c.Date)).trim());
  }
  finish();
  const seen = new Set<string>(); for (const account of accountSummaries) { if (seen.has(account.accountNumber)) warnings.push(issue('VANTACA_DUPLICATE_ACCOUNT', 'Repeated source account code is retained as separate summaries; deterministic matching requires review.', account.sourceHeadingRowNumber)); seen.add(account.accountNumber); }
  let sourceControlTotals: GLParserDiagnostics['sourceControlTotals'];
  try {
    if (reportControl) {
      const parsedDebit = moneySum(reportDebits), parsedCredit = moneySum(reportCredits), activityAgrees = balancesAgree(parsedDebit, reportControl.debit) && balancesAgree(parsedCredit, reportControl.credit);
      const complete = accountSummaries.every(a => a.balanceValidationAvailable), primaryBeginningBalance = complete && accountSummaries.every(a => a.beginningBalance !== undefined) ? moneySum(accountSummaries.map(a => toCents(a.beginningBalance!))) : undefined, primaryEndingBalance = complete && accountSummaries.every(a => a.endingBalance !== undefined) ? moneySum(accountSummaries.map(a => toCents(a.endingBalance!))) : undefined;
      const beginningBalancesAgree = reportControl.beginningBalance !== undefined && primaryBeginningBalance !== undefined ? balancesAgree(reportControl.beginningBalance, primaryBeginningBalance) : undefined, endingBalancesAgree = reportControl.endingBalance !== undefined && primaryEndingBalance !== undefined ? balancesAgree(reportControl.endingBalance, primaryEndingBalance) : undefined;
      sourceControlTotals = { ...reportControl, parsedDebit, parsedCredit, primaryBeginningBalance, primaryEndingBalance, activityAgrees, beginningBalancesAgree, endingBalancesAgree };
      if (!activityAgrees || beginningBalancesAgree === false || endingBalancesAgree === false) warnings.push(issue('VANTACA_REPORT_DIFFERENCE', 'Parsed activity or account balances differ from Net Total; report scope requires review.', reportTotalRows[0]));
    } else if (!reportTotalRows.length) warnings.push(issue('VANTACA_REPORT_CONTROL_UNAVAILABLE', 'No report Net Total; report-wide checks are unavailable rather than guessed.'));
  } catch { errors.push(issue('VANTACA_AMOUNT_RANGE', 'Report aggregation exceeds safe cent precision.')); }
  if (!accountSummaries.length) errors.push(issue('VANTACA_NO_ACCOUNTS', 'No posting-account summaries were found.'));
  if (numericIdentifierCount) warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', `${numericIdentifierCount.toLocaleString()} numeric Ledger ID references were preserved as displayed text; source leading zeros already lost without formatting cannot be recovered.`, firstNumericRow));
  return { transactions, accountSummaries, warnings, errors, sourceMetadata: { ...sourceMetadata, reportFields }, diagnostics: { workbookType: workbook.metadata.extension, controlHeaderRowNumber: controlHeader.sourceRowNumber, detectedSheet: sheet.name, headerRowNumber: header.sourceRowNumber, accountHeadingRows, beginningBalanceRows, endingBalanceRows, accountTotalRows, subtotalRows: accountTotalRows, reportTotalRows, repeatedHeaderCount, skippedRows, transactionCount: transactions.length, endingBalanceCount: accountSummaries.filter(a => a.endingBalance !== undefined).length, reliableEndingBalanceCount: accountSummaries.filter(a => a.balanceValidationAvailable).length, warningCount: warnings.length, numericIdentifierCount, sourceControlTotals } };
}
export const vantacaParser: GLParser = { id: 'vantaca', displayName: 'Vantaca General Ledger', implemented: true, detect: detectVantaca, parse: async workbook => parseVantacaWorkbook(workbook) };
