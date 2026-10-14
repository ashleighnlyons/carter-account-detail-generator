import type { GLAccountSummary, GLTransaction, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookRow, WorkbookSheet } from '../models/workbook';
import type { GLParser, GLParseResult, ParserDetection, ParserIssue, SkippedRowCategory } from './types';
import { cellAt, cellText, dateFromCell, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';
import { addCents, balancesAgree, fromCents, moneyDifference, toCents, type Cents } from '../utils/money';

export const ONESITE_COLUMNS = ['Posted Dt.', 'Doc Dt.', 'Doc', 'Memo / Description', 'Department', 'Location', 'Unit', 'JNL', 'Debit', 'Credit', 'Balance'] as const;
type Column = typeof ONESITE_COLUMNS[number];
type Columns = Record<Column, number>;
interface Layout { sheet: WorkbookSheet; header: WorkbookRow; columns: Columns; confidence: number; reasons: string[] }
const headerNames = ONESITE_COLUMNS.map(normalizedHeader);
const scopeLabel = /^(?:company name|report name|reporting book|start date|end date|location)\s*:/i;
function onlyColumns(row: WorkbookRow, indices: readonly number[]) {
  return row.cells.every((cell, index) => indices.includes(index) || (!cell.error && !cellText(cell).trim()));
}
function isHeader(row: WorkbookRow) {
  const names = row.cells.map(cell => normalizedHeader(cellText(cell)));
  return headerNames.every(name => names.filter(candidate => candidate === name).length === 1);
}
/** The first literal delimiter separates the identifier; the trailing control suffix is removed separately. */
function heading(row: WorkbookRow, c: Columns) {
  const source = cellAt(row, c['Posted Dt.']), text = cellText(source);
  if (source.error || typeof source.value !== 'string' || dateFromCell(source) || scopeLabel.test(text.trim()) || /^totals for /i.test(text.trim()) || !onlyColumns(row, [c['Posted Dt.'], c.Balance])) return undefined;
  const forward = / \(Balance Forward As of ([^)]+)\)$/i.exec(text);
  const base = forward ? text.slice(0, forward.index) : text;
  const separator = base.indexOf(' - ');
  if (separator < 0 || (!forward && (cellAt(row, c.Balance).error || cellText(cellAt(row, c.Balance)).trim()))) return undefined;
  const accountNumber = base.slice(0, separator), accountDescription = base.slice(separator + 3);
  if (!accountNumber.trim() || !accountDescription.trim()) return undefined;
  return { accountNumber, accountDescription, base, originalHeading: text, forwardDate: forward?.[1], hasBeginning: !!forward };
}
function total(row: WorkbookRow, c: Columns) {
  const label = cellAt(row, c['Posted Dt.']);
  return !label.error && /^totals for /i.test(cellText(label)) && onlyColumns(row, [c['Posted Dt.'], c.Debit, c.Credit, c.Balance]);
}
function inspectLayouts(workbook: ParserWorkbook): Layout[] {
  return workbook.sheets.flatMap(sheet => {
    const header = sheet.rows.find(row => row.sourceRowNumber <= 200 && isHeader(row));
    if (!header) return [];
    const names = header.cells.map(cell => normalizedHeader(cellText(cell)));
    const c = Object.fromEntries(ONESITE_COLUMNS.map((name, i) => [name, names.indexOf(headerNames[i])])) as Columns;
    let activeBase: string | undefined, beginning = false, pairedTotal = false;
    for (const row of sheet.rows) {
      if (row.sourceRowNumber <= header.sourceRowNumber || isBlankRow(row) || isHeader(row)) continue;
      const account = heading(row, c);
      if (account) { activeBase = account.base; beginning ||= account.hasBeginning && !!dateFromCell({ value: account.forwardDate ?? null }); }
      else if (total(row, c)) { pairedTotal ||= !!activeBase && cellText(cellAt(row, c['Posted Dt.'])).slice('Totals for '.length) === activeBase; activeBase = undefined; }
    }
    const confidence = 0.5 + (beginning ? 0.25 : 0) + (pairedTotal ? 0.25 : 0);
    const reasons = ['Eleven unique OneSite columns, including Posted Dt., Doc Dt., Doc, Department, Unit and JNL.'];
    if (beginning) reasons.push('Composite account headings with a dated Balance Forward As of suffix.');
    if (pairedTotal) reasons.push('Totals for controls explicitly repeat the preceding account identifier and description.');
    return [{ sheet, header, columns: c, confidence, reasons }];
  }).sort((a, b) => b.confidence - a.confidence);
}
export function detectOneSite(workbook: ParserWorkbook): ParserDetection {
  const layouts = inspectLayouts(workbook);
  if (layouts.filter(layout => layout.confidence >= 0.85).length > 1) return { confidence: 0, reasons: ['Multiple OneSite report sheets require scope review; no sheet was automatically chosen.'] };
  return layouts[0] ? { confidence: layouts[0].confidence, reasons: layouts[0].reasons } : { confidence: 0, reasons: ['The distinctive OneSite columns and account control structure were not found.'] };
}
interface AccountContext {
  accountNumber: string; accountDescription: string; base: string; originalHeading: string; headingRow: number;
  beginningBalance?: number; endingBalance?: number; endingRow?: number; transactionCount: number;
  debits: Cents[]; credits: Cents[]; running?: number; lastReportedRunning?: number; reliable: boolean; activityAllowed: boolean;
}
export function parseOneSiteWorkbook(workbook: ParserWorkbook): GLParseResult {
  const transactions: GLTransaction[] = [], accountSummaries: GLAccountSummary[] = [], warnings: ParserIssue[] = [], errors: ParserIssue[] = [];
  const reportFields: Record<string, SourceFieldValue> = Object.create(null);
  const sourceMetadata = { parserId: 'onesite' as const, workbook: workbook.metadata, parserVersion: '0.4.0', reportFields };
  const layout = inspectLayouts(workbook)[0];
  if (!layout || detectOneSite(workbook).confidence < 0.85) return { transactions, accountSummaries, warnings, errors: [{ code: 'ONESITE_STRUCTURE_UNRECOGNIZED', message: 'No single OneSite general ledger structure was confidently recognized.' }], sourceMetadata };
  const { sheet, header, columns: c } = layout;
  const accountHeadingRows: number[] = [], beginningBalanceRows: number[] = [], endingBalanceRows: number[] = [], subtotalRows: number[] = [];
  const skippedRows: Record<SkippedRowCategory, number> = { reportHeader: 0, columnHeader: 0, accountHeading: 0, beginningBalance: 0, endingBalance: 0, subtotal: 0, blank: 0, reportFooter: 0, review: 0 };
  let current: AccountContext | undefined, numericIdentifierCount = 0, firstNumericRow: number | undefined, repeatedHeaderCount = 0, changedLayout = false;
  function issue(code: string, message: string, row?: number): ParserIssue { return { code, message, sourceSheetName: sheet.name, sourceRowNumber: row }; }
  function finish() {
    if (!current) return;
    if (current.endingBalance === undefined) warnings.push(issue('ONESITE_ENDING_UNAVAILABLE', 'No reliable explicit Totals for ending balance was captured; balance validation is unavailable.', current.headingRow));
    accountSummaries.push({ accountNumber: current.accountNumber, accountDescription: current.accountDescription, beginningBalance: current.beginningBalance, endingBalance: current.endingBalance,
      transactionCount: current.transactionCount, balanceValidationAvailable: current.reliable && current.endingBalance !== undefined,
      sourceSheetName: sheet.name, sourceHeadingRowNumber: current.headingRow, sourceEndingRowNumber: current.endingRow });
    current = undefined;
  }
  function amount(row: WorkbookRow, column: 'Debit' | 'Credit' | 'Balance', required: boolean, blocking: boolean) {
    try { const value = monetaryValue(cellAt(row, c[column])); if (required && value === undefined) throw new Error('Missing'); return value; }
    catch { (blocking ? errors : warnings).push(issue('ONESITE_INVALID_AMOUNT', `${column} contains a missing, invalid or unsafe amount. Review this source row.`, row.sourceRowNumber)); if (current) current.reliable = false; return undefined; }
  }
  function rejectBoundary(row: WorkbookRow, code: string, message: string, blocking: boolean) {
    // A review warning is retained even for blocking orphan/unsafe activity.
    const problem = issue(code, message, row.sourceRowNumber); warnings.push(problem); if (blocking) errors.push(problem);
    skippedRows.review++; if (current) current.reliable = false; finish();
  }
  function sourceFields(row: WorkbookRow) {
    const fields: Record<string, SourceFieldValue> = Object.create(null);
    row.cells.forEach((cell, index) => {
      const original = cellText(cellAt(header, index)).trim() || `Source Column ${index + 1}`;
      const label = Object.hasOwn(fields, original) ? `${original} [column ${index + 1}]` : original;
      fields[label] = cell.error ?? (cell.dateValue ? cell.formattedText ?? cell.dateValue : index === c.Doc ? (cell.value === null ? null : cellText(cell)) : cell.value);
    });
    let label = 'Account Heading', suffix = 1;
    while (Object.hasOwn(fields, label)) label = `Account Heading [report context ${suffix++}]`;
    fields[label] = current!.originalHeading;
    return fields;
  }
  for (const row of sheet.rows) {
    if (isBlankRow(row)) { skippedRows.blank++; continue; }
    if (row.sourceRowNumber < header.sourceRowNumber) {
      skippedRows.reportHeader++;
      row.cells.forEach((cell, index) => {
        const text = cellText(cell), colon = text.indexOf(':');
        if (colon >= 0) { const key = text.slice(0, colon).trim(); reportFields[Object.hasOwn(reportFields, key) ? `${key} [row ${row.sourceRowNumber}]` : key] = text.slice(colon + 1).trim() || cellText(cellAt(row, index + 1)); }
      });
      continue;
    }
    if (changedLayout) { skippedRows.review++; continue; }
    if (isHeader(row)) {
      if (ONESITE_COLUMNS.every(name => normalizedHeader(cellText(cellAt(row, c[name]))) === normalizedHeader(name))) { skippedRows.columnHeader++; if (row.sourceRowNumber !== header.sourceRowNumber) repeatedHeaderCount++; }
      else { rejectBoundary(row, 'ONESITE_HEADER_CHANGED', 'Repeated columns changed position. Further rows require review before parsing can continue.', true); changedLayout = true; }
      continue;
    }
    const label = cellText(cellAt(row, c['Posted Dt.']));
    if (onlyColumns(row, [c['Posted Dt.']]) && (/^general ledger report$/i.test(label.trim()) || /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(label.trim()))) { skippedRows.reportFooter++; continue; }
    if (scopeLabel.test(label.trim())) { rejectBoundary(row, 'ONESITE_SCOPE_BOUNDARY', 'Report scope metadata within account activity was not assumed to continue the same account.', false); continue; }
    const account = heading(row, c);
    if (account) {
      finish(); accountHeadingRows.push(row.sourceRowNumber); skippedRows.accountHeading++;
      current = { ...account, headingRow: row.sourceRowNumber, transactionCount: 0, debits: [], credits: [], reliable: true, activityAllowed: account.hasBeginning };
      if (account.hasBeginning) {
        beginningBalanceRows.push(row.sourceRowNumber); // Combined heading/beginning row counts once in skippedRows.
        if (!dateFromCell({ value: account.forwardDate ?? null })) { current.reliable = false; warnings.push(issue('ONESITE_FORWARD_DATE_INVALID', 'Balance Forward date is invalid; account balance controls require review.', row.sourceRowNumber)); }
        current.beginningBalance = amount(row, 'Balance', true, false); current.running = current.beginningBalance;
      }
      continue;
    }
    if (total(row, c)) {
      subtotalRows.push(row.sourceRowNumber); endingBalanceRows.push(row.sourceRowNumber); skippedRows.endingBalance++;
      if (!current || label.slice('Totals for '.length) !== current.base) { rejectBoundary(row, 'ONESITE_TOTAL_CONTEXT', 'Totals for does not identify the unique open account. The balance was not assigned.', false); continue; }
      current.endingRow = row.sourceRowNumber; current.endingBalance = amount(row, 'Balance', true, false);
      const debitControl = amount(row, 'Debit', true, false), creditControl = amount(row, 'Credit', true, false);
      try {
        const debits = fromCents(addCents(current.debits)), credits = fromCents(addCents(current.credits));
        const rolled = current.beginningBalance === undefined ? undefined : fromCents(addCents([toCents(current.beginningBalance), toCents(moneyDifference(debits, credits))]));
        if ((debitControl !== undefined && !balancesAgree(debits, debitControl)) || (creditControl !== undefined && !balancesAgree(credits, creditControl)) ||
          (rolled !== undefined && current.endingBalance !== undefined && !balancesAgree(rolled, current.endingBalance)) ||
          (current.lastReportedRunning !== undefined && current.endingBalance !== undefined && !balancesAgree(current.lastReportedRunning, current.endingBalance))) {
          current.reliable = false; warnings.push(issue('ONESITE_CONTROL_DIFFERENCE', 'Account activity totals or beginning-to-ending controls disagree. Balance validation is unavailable.', row.sourceRowNumber));
        }
      } catch { current.reliable = false; errors.push(issue('ONESITE_AMOUNT_RANGE', 'Account controls cannot retain safe cent precision.', row.sourceRowNumber)); }
      finish(); continue;
    }
    if (/^grand total$/i.test(label.trim()) && onlyColumns(row, [c['Posted Dt.'], c.Debit, c.Credit, c.Balance])) { skippedRows.reportFooter++; if (current) { current.reliable = false; finish(); } continue; }
    const date = dateFromCell(cellAt(row, c['Posted Dt.']));
    if (date) {
      if (!current?.activityAllowed) { rejectBoundary(row, 'ONESITE_ORPHAN_TRANSACTION', 'Dated activity has no reliable Balance Forward account heading. It was not assigned; review the source row.', true); continue; }
      const before = errors.length, debit = amount(row, 'Debit', false, true), credit = amount(row, 'Credit', false, true);
      if (debit === undefined && credit === undefined && before === errors.length) errors.push(issue('ONESITE_MISSING_TRANSACTION_AMOUNT', 'Dated activity has no debit or credit. No amount was guessed.', row.sourceRowNumber));
      if (errors.length > before) { current.reliable = false; skippedRows.review++; continue; }
      const runningBalance = amount(row, 'Balance', false, false);
      let netAmount: number;
      try {
        netAmount = moneyDifference(debit ?? 0, credit ?? 0);
        const expected = current.running === undefined ? undefined : fromCents(addCents([toCents(current.running), toCents(netAmount)]));
        if (expected !== undefined && runningBalance !== undefined && !balancesAgree(expected, runningBalance)) { current.reliable = false; warnings.push(issue('ONESITE_RUNNING_DIFFERENCE', 'Running balance disagrees with debit less credit at cent precision. Balance validation is unavailable.', row.sourceRowNumber)); }
        current.running = expected ?? runningBalance; current.lastReportedRunning = runningBalance;
      } catch { current.reliable = false; errors.push(issue('ONESITE_AMOUNT_RANGE', 'Transaction amounts cannot retain safe cent precision.', row.sourceRowNumber)); skippedRows.review++; continue; }
      const referenceCell = cellAt(row, c.Doc);
      if (typeof referenceCell.value === 'number') { numericIdentifierCount++; firstNumericRow ??= row.sourceRowNumber; }
      const optionalText = (column: Column) => { const value = cellText(cellAt(row, c[column])); return value.trim() ? value : undefined; };
      transactions.push({ accountNumber: current.accountNumber, accountDescription: current.accountDescription, transactionDate: date,
        transactionType: optionalText('JNL'), reference: optionalText('Doc'), description: optionalText('Memo / Description'),
        debit, credit, netAmount, runningBalance, sourceFormat: 'onesite', sourceRowNumber: row.sourceRowNumber, sourceSheetName: sheet.name, sourceFields: sourceFields(row) });
      current.transactionCount++; current.debits.push(toCents(debit ?? 0)); current.credits.push(toCents(credit ?? 0)); continue;
    }
    const shaped = [c['Doc Dt.'], c.Doc, c.JNL, c.Debit, c.Credit].some(index => cellAt(row, index).error || cellText(cellAt(row, index)).trim());
    rejectBoundary(row, shaped ? 'ONESITE_MALFORMED_TRANSACTION' : 'ONESITE_UNRECOGNIZED_BOUNDARY', 'Row cannot be classified safely. Account context was cleared for review.', !!shaped);
  }
  finish();
  if (!accountSummaries.length) errors.push(issue('ONESITE_NO_ACCOUNTS', 'No OneSite account records were found.'));
  if (numericIdentifierCount) warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', `${numericIdentifierCount} numeric references were preserved using displayed text. Leading zeros already lost without source formatting cannot be recovered.`, firstNumericRow));
  const seen = new Set<string>();
  for (const account of accountSummaries) { if (seen.has(account.accountNumber)) warnings.push(issue('ONESITE_DUPLICATE_ACCOUNT', 'Account identifier occurs in multiple sections; exact matching requires review.', account.sourceHeadingRowNumber)); seen.add(account.accountNumber); }
  return { transactions, accountSummaries, warnings, errors, sourceMetadata, diagnostics: { detectedSheet: sheet.name, headerRowNumber: header.sourceRowNumber, accountHeadingRows, beginningBalanceRows, endingBalanceRows, subtotalRows, repeatedHeaderCount, skippedRows,
    transactionCount: transactions.length, endingBalanceCount: accountSummaries.filter(account => account.endingBalance !== undefined).length,
    reliableEndingBalanceCount: accountSummaries.filter(account => account.balanceValidationAvailable).length, warningCount: warnings.length, numericIdentifierCount } };
}
export const onesiteParser: GLParser = { id: 'onesite', displayName: 'OneSite General Ledger', implemented: true, detect: detectOneSite, parse: async workbook => parseOneSiteWorkbook(workbook) };
