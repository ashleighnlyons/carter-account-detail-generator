import type { GLAccountSummary, GLTransaction, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookRow, WorkbookSheet } from '../models/workbook';
import type { GLParser, GLParseResult, ParserDetection, ParserIssue, SkippedRowCategory } from './types';
import { cellAt, cellText, dateFromCell, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';
import { addCents, balancesAgree, fromCents, moneyDifference, toCents } from '../utils/money';
import type { Cents } from '../utils/money';

export const APPFOLIO_COLUMNS = ['Date', 'Payee / Payer', 'Type', 'Reference', 'Debit', 'Credit', 'Balance', 'Description'] as const;
type Column = typeof APPFOLIO_COLUMNS[number];
const headers = APPFOLIO_COLUMNS.map(normalizedHeader);
interface Layout { sheet: WorkbookSheet; header: WorkbookRow; columns: Record<Column, number>; confidence: number; reasons: string[] }
const reportMetadata = /^(?:exported on|portfolios|properties|created by|gl accounts|exclude zero dollar receipts from cash accounts|date range|accounting basis|show reversed transactions|gl account map|project)\s*:/i;

function onlyColumns(row: WorkbookRow, columns: readonly number[]): boolean {
  return row.cells.every((cell, index) => columns.includes(index) || (!cell.error && !cellText(cell).trim()));
}
/** Split the first literal report delimiter; preserve the original identifier prefix, including punctuation/zeros. */
function accountHeading(row: WorkbookRow, c: Record<Column, number>) {
  const cell = cellAt(row, c.Date), text = cellText(cell);
  if (cell.error || typeof cell.value !== 'string' || dateFromCell(cell) || reportMetadata.test(text.trim()) || !onlyColumns(row, [c.Date])) return undefined;
  const separator = text.indexOf(' - ');
  if (separator < 0) return undefined;
  const accountNumber = text.slice(0, separator), accountDescription = text.slice(separator + 3);
  return accountNumber.trim() && accountDescription.trim() ? { accountNumber, accountDescription, originalHeading: text } : undefined;
}
function control(row: WorkbookRow, c: Record<Column, number>, label: string): boolean {
  return !cellAt(row, c.Date).error && cellText(cellAt(row, c.Date)).trim().toLowerCase() === label && onlyColumns(row, [c.Date, c.Balance]);
}
function closingTotal(row: WorkbookRow, c: Record<Column, number>): boolean {
  return !isBlankRow(row) && onlyColumns(row, [c.Debit, c.Credit, c.Balance]) && (!!cellText(cellAt(row, c.Balance)).trim() || !!cellAt(row, c.Balance).error);
}
function isHeader(row: WorkbookRow): boolean {
  const names = row.cells.map(cell => normalizedHeader(cellText(cell)));
  return headers.every(header => names.filter(name => name === header).length === 1);
}

function inspectLayouts(workbook: ParserWorkbook): Layout[] {
  const layouts: Layout[] = [];
  for (const sheet of workbook.sheets) {
    const header = sheet.rows.find(row => row.sourceRowNumber <= 200 && isHeader(row));
    if (!header) continue;
    const names = header.cells.map(cell => normalizedHeader(cellText(cell)));
    const c = Object.fromEntries(APPFOLIO_COLUMNS.map((name, i) => [name, names.indexOf(headers[i])])) as Record<Column, number>;
    const body = sheet.rows.filter(row => row.sourceRowNumber > header.sourceRowNumber && !isBlankRow(row) && !isHeader(row));
    const beginning = body.some((row, i) => !!accountHeading(row, c) && !!body[i + 1] && control(body[i + 1], c, 'starting balance'));
    const ending = body.some((row, i) => control(row, c, 'net change') && !!body[i + 1] && closingTotal(body[i + 1], c));
    const prefix = sheet.rows.filter(row => row.sourceRowNumber < header.sourceRowNumber);
    const metadata = prefix.some(row => row.cells.some(cell => /^gl account map\s*:/i.test(cellText(cell).trim()))) &&
      prefix.some(row => row.cells.some(cell => /^accounting basis\s*:/i.test(cellText(cell).trim())));
    const confidence = Math.round((0.5 + (beginning ? 0.2 : 0) + (ending ? 0.2 : 0) + (metadata ? 0.1 : 0)) * 100) / 100;
    const reasons = ['All eight unique AppFolio columns, including Payee / Payer, Type and Reference.'];
    if (beginning) reasons.push('Composite account-number - description headings followed by Starting Balance controls.');
    if (ending) reasons.push('Net Change controls followed by unlabeled debit/credit/account-balance totals.');
    if (metadata) reasons.push('GL Account Map and Accounting Basis report metadata.');
    layouts.push({ sheet, header, columns: c, confidence, reasons });
  }
  return layouts.sort((a, b) => b.confidence - a.confidence);
}
export function detectAppFolio(workbook: ParserWorkbook): ParserDetection {
  const layouts = inspectLayouts(workbook);
  if (layouts.filter(layout => layout.confidence >= 0.85).length > 1) return { confidence: 0, reasons: ['Multiple AppFolio report sheets require explicit scope review; automatic sheet selection is unavailable.'] };
  return layouts[0] ? { confidence: layouts[0].confidence, reasons: layouts[0].reasons } : { confidence: 0, reasons: ['The complete AppFolio columns and account/balance structure were not found.'] };
}

interface AccountContext {
  accountNumber: string; accountDescription: string; originalHeading: string; headingRow: number;
  beginningBalance?: number; endingBalance?: number; endingRow?: number; netChange?: number; netRow?: number;
  transactionCount: number; debits: Cents[]; credits: Cents[]; running?: number; lastReportedRunning?: number; reliable: boolean;
}
export function parseAppFolioWorkbook(workbook: ParserWorkbook): GLParseResult {
  const transactions: GLTransaction[] = [], accountSummaries: GLAccountSummary[] = [], warnings: ParserIssue[] = [], errors: ParserIssue[] = [];
  const reportFields: Record<string, SourceFieldValue> = Object.create(null);
  const sourceMetadata = { parserId: 'appfolio' as const, workbook: workbook.metadata, parserVersion: '0.3.0', reportFields };
  const detection = detectAppFolio(workbook), layout = inspectLayouts(workbook)[0];
  if (!layout || detection.confidence < 0.85) return { transactions, accountSummaries, warnings, errors: [{ code: 'APPFOLIO_STRUCTURE_UNRECOGNIZED', message: 'No single AppFolio general ledger structure was confidently recognized.' }], sourceMetadata };
  const { sheet, header, columns: c } = layout;
  const accountHeadingRows: number[] = [], endingBalanceRows: number[] = [];
  const skippedRows: Record<SkippedRowCategory, number> = { reportHeader: 0, columnHeader: 0, accountHeading: 0, beginningBalance: 0, endingBalance: 0, subtotal: 0, blank: 0, reportFooter: 0, review: 0 };
  let current: AccountContext | undefined, numericIdentifierCount = 0, firstNumericRow: number | undefined;
  function issue(code: string, message: string, rowNumber?: number): ParserIssue { return { code, message, sourceSheetName: sheet.name, sourceRowNumber: rowNumber }; }
  function finish() {
    if (!current) return;
    if (current.endingBalance === undefined) warnings.push(issue('APPFOLIO_ENDING_UNAVAILABLE', 'No paired Net Change/account-total ending balance was found. Balance validation is unavailable.', current.headingRow));
    accountSummaries.push({ accountNumber: current.accountNumber, accountDescription: current.accountDescription, beginningBalance: current.beginningBalance, endingBalance: current.endingBalance,
      transactionCount: current.transactionCount, balanceValidationAvailable: current.endingBalance !== undefined && current.reliable,
      sourceSheetName: sheet.name, sourceHeadingRowNumber: current.headingRow, sourceEndingRowNumber: current.endingRow });
    current = undefined;
  }
  function amount(row: WorkbookRow, column: Column, required: boolean, blocking: boolean): number | undefined {
    try { const value = monetaryValue(cellAt(row, c[column])); if (required && value === undefined) throw new Error('Missing'); return value; }
    catch { (blocking ? errors : warnings).push(issue('APPFOLIO_INVALID_AMOUNT', `${column} contains a missing, invalid or unsafe amount. Review this source row.`, row.sourceRowNumber)); if (current) current.reliable = false; return undefined; }
  }
  function sourceFields(row: WorkbookRow): Readonly<Record<string, SourceFieldValue>> {
    const fields: Record<string, SourceFieldValue> = Object.create(null);
    row.cells.forEach((cell, index) => {
      const originalLabel = cellText(cellAt(header, index)).trim() || `Source Column ${index + 1}`;
      const label = Object.hasOwn(fields, originalLabel) ? `${originalLabel} [column ${index + 1}]` : originalLabel;
      fields[label] = cell.error ?? (cell.dateValue ? cell.formattedText ?? cell.dateValue : index === c.Reference ? (cell.value === null ? null : cellText(cell)) : cell.value);
    });
    let label = 'Account Heading', suffix = 1;
    while (Object.hasOwn(fields, label)) label = `Account Heading [report context ${suffix++}]`;
    fields[label] = current!.originalHeading;
    return fields;
  }
  function rejectBoundary(row: WorkbookRow, code: string, message: string, blocking: boolean) {
    (blocking ? errors : warnings).push(issue(code, message, row.sourceRowNumber)); skippedRows.review++;
    if (current) current.reliable = false;
    finish(); // Never carry context across a row that could be a new account/scope boundary.
  }
  for (const row of sheet.rows) {
    if (isBlankRow(row)) { skippedRows.blank++; continue; }
    if (row.sourceRowNumber < header.sourceRowNumber) {
      skippedRows.reportHeader++;
      row.cells.forEach(cell => { const text = cellText(cell), colon = text.indexOf(':'); if (colon >= 0) { const name = text.slice(0, colon).trim(); reportFields[Object.hasOwn(reportFields, name) ? `${name} [row ${row.sourceRowNumber}]` : name] = text.slice(colon + 1).trim(); } });
      continue;
    }
    if (isHeader(row)) {
      // Repeated headers may continue an account only if columns have not moved.
      if (APPFOLIO_COLUMNS.every(name => normalizedHeader(cellText(cellAt(row, c[name]))) === normalizedHeader(name))) skippedRows.columnHeader++;
      else rejectBoundary(row, 'APPFOLIO_HEADER_CHANGED', 'Repeated report columns changed position; account scope requires review.', true);
      continue;
    }
    const dateCell = cellAt(row, c.Date), text = cellText(dateCell).trim(), date = dateFromCell(dateCell);
    if (onlyColumns(row, [c.Date]) && (/^general ledger$/i.test(text) || /^page\s+\d+(?:\s+of\s+\d+)?$/i.test(text))) { skippedRows.reportFooter++; continue; }
    if (onlyColumns(row, [c.Date]) && reportMetadata.test(text)) { rejectBoundary(row, 'APPFOLIO_SCOPE_BOUNDARY', 'Report metadata within account activity may indicate a new scope. Account context was cleared.', false); continue; }
    const heading = accountHeading(row, c);
    if (heading) {
      finish(); skippedRows.accountHeading++; accountHeadingRows.push(row.sourceRowNumber);
      current = { ...heading, headingRow: row.sourceRowNumber, transactionCount: 0, debits: [], credits: [], reliable: true };
      continue;
    }
    if (control(row, c, 'starting balance')) {
      skippedRows.beginningBalance++;
      if (!current || current.netRow !== undefined || current.transactionCount || current.beginningBalance !== undefined) { rejectBoundary(row, 'APPFOLIO_STARTING_CONTEXT', 'Starting Balance has no unique new account context; it was not assigned.', false); continue; }
      current.beginningBalance = amount(row, 'Balance', true, false); current.running = current.beginningBalance;
      continue;
    }
    if (control(row, c, 'net change')) {
      skippedRows.subtotal++;
      if (!current || current.netRow !== undefined) { rejectBoundary(row, 'APPFOLIO_NET_CONTEXT', 'Net Change has no unique open account context; review the account boundary.', false); continue; }
      current.netRow = row.sourceRowNumber; current.netChange = amount(row, 'Balance', true, false);
      continue;
    }
    if (closingTotal(row, c)) {
      skippedRows.endingBalance++;
      if (!current || current.netRow === undefined) { rejectBoundary(row, 'APPFOLIO_UNPAIRED_TOTAL', 'An unlabeled balance total has no paired Net Change/account context. It was not assigned.', false); continue; }
      current.endingRow = row.sourceRowNumber;
      current.endingBalance = amount(row, 'Balance', true, false); endingBalanceRows.push(row.sourceRowNumber);
      const expectedDebit = amount(row, 'Debit', true, false), expectedCredit = amount(row, 'Credit', true, false);
      try {
        const debit = fromCents(addCents(current.debits)), credit = fromCents(addCents(current.credits)), net = moneyDifference(debit, credit);
        const rolled = current.beginningBalance === undefined ? undefined : fromCents(addCents([toCents(current.beginningBalance), toCents(net)]));
        if ((expectedDebit !== undefined && !balancesAgree(debit, expectedDebit)) || (expectedCredit !== undefined && !balancesAgree(credit, expectedCredit)) ||
          (current.netChange !== undefined && !balancesAgree(net, current.netChange)) ||
          (rolled !== undefined && current.endingBalance !== undefined && !balancesAgree(rolled, current.endingBalance)) ||
          (current.lastReportedRunning !== undefined && current.endingBalance !== undefined && !balancesAgree(current.lastReportedRunning, current.endingBalance))) {
          current.reliable = false; warnings.push(issue('APPFOLIO_CONTROL_DIFFERENCE', 'Activity, Net Change or starting-to-ending controls disagree. Balance validation is unavailable.', row.sourceRowNumber));
        }
      } catch { current.reliable = false; errors.push(issue('APPFOLIO_AMOUNT_RANGE', 'Account totals cannot retain safe cent precision.', row.sourceRowNumber)); }
      finish(); continue;
    }
    if (/^total$/i.test(text) && onlyColumns(row, [c.Date, c.Debit, c.Credit, c.Balance])) {
      skippedRows.reportFooter++;
      if (current) { current.reliable = false; finish(); }
      continue;
    }
    if (date) {
      if (!current || current.netRow !== undefined) { rejectBoundary(row, 'APPFOLIO_ORPHAN_TRANSACTION', 'Dated activity has no open account heading, or occurs after its Net Change. It was not assigned.', true); continue; }
      const errorsBefore = errors.length;
      const debit = amount(row, 'Debit', false, true), credit = amount(row, 'Credit', false, true);
      if (debit === undefined && credit === undefined && errors.length === errorsBefore) errors.push(issue('APPFOLIO_MISSING_TRANSACTION_AMOUNT', 'Dated activity has no debit or credit; no amount was guessed.', row.sourceRowNumber));
      if (errors.length > errorsBefore) { current.reliable = false; skippedRows.review++; continue; }
      const runningBalance = amount(row, 'Balance', false, false);
      let netAmount: number;
      try {
        netAmount = moneyDifference(debit ?? 0, credit ?? 0);
        const expectedRunning = current.running === undefined ? undefined : fromCents(addCents([toCents(current.running), toCents(netAmount)]));
        if (runningBalance !== undefined && expectedRunning !== undefined && !balancesAgree(runningBalance, expectedRunning)) {
          current.reliable = false; warnings.push(issue('APPFOLIO_RUNNING_DIFFERENCE', 'Running balance does not agree with the account activity at cent precision. Balance validation is unavailable.', row.sourceRowNumber));
        }
        current.running = expectedRunning ?? runningBalance; current.lastReportedRunning = runningBalance;
      } catch { current.reliable = false; errors.push(issue('APPFOLIO_AMOUNT_RANGE', 'Transaction amounts cannot retain safe cent precision.', row.sourceRowNumber)); skippedRows.review++; continue; }
      const referenceCell = cellAt(row, c.Reference);
      if (typeof referenceCell.value === 'number') { numericIdentifierCount++; firstNumericRow ??= row.sourceRowNumber; }
      transactions.push({ accountNumber: current.accountNumber, accountDescription: current.accountDescription, transactionDate: date,
        transactionType: cellText(cellAt(row, c.Type)) || undefined, reference: cellText(referenceCell) || undefined,
        payeeOrName: cellText(cellAt(row, c['Payee / Payer'])) || undefined, description: cellText(cellAt(row, c.Description)) || undefined,
        debit, credit, netAmount, runningBalance, sourceFormat: 'appfolio', sourceRowNumber: row.sourceRowNumber, sourceSheetName: sheet.name, sourceFields: sourceFields(row) });
      current.transactionCount++; current.debits.push(toCents(debit ?? 0)); current.credits.push(toCents(credit ?? 0)); continue;
    }
    const transactionShaped = [c['Payee / Payer'], c.Type, c.Reference, c.Debit, c.Credit].some(index => !!cellText(cellAt(row, index)).trim() || !!cellAt(row, index).error);
    rejectBoundary(row, transactionShaped ? 'APPFOLIO_MALFORMED_TRANSACTION' : 'APPFOLIO_UNRECOGNIZED_BOUNDARY', 'Row cannot be classified safely. Account context was cleared rather than carried across an ambiguous boundary.', transactionShaped);
  }
  finish();
  if (!accountSummaries.length) errors.push(issue('APPFOLIO_NO_ACCOUNTS', 'No AppFolio account records were found.'));
  if (numericIdentifierCount) warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', `${numericIdentifierCount.toLocaleString()} numeric references were preserved using displayed text. Leading zeros already lost without source formatting cannot be recovered.`, firstNumericRow));
  const seen = new Set<string>();
  for (const account of accountSummaries) { if (seen.has(account.accountNumber)) warnings.push(issue('APPFOLIO_DUPLICATE_ACCOUNT', 'Account identifier occurs in multiple blocks; deterministic matching requires review.', account.sourceHeadingRowNumber)); seen.add(account.accountNumber); }
  return { transactions, accountSummaries, warnings, errors, sourceMetadata, diagnostics: { detectedSheet: sheet.name, headerRowNumber: header.sourceRowNumber, accountHeadingRows, endingBalanceRows, skippedRows,
    transactionCount: transactions.length, endingBalanceCount: accountSummaries.filter(a => a.endingBalance !== undefined).length, reliableEndingBalanceCount: accountSummaries.filter(a => a.balanceValidationAvailable).length, warningCount: warnings.length, numericIdentifierCount } };
}
export const appfolioParser: GLParser = { id: 'appfolio', displayName: 'AppFolio General Ledger', implemented: true, detect: detectAppFolio, parse: async workbook => parseAppFolioWorkbook(workbook) };
