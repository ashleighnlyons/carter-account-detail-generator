import type { GLAccountSummary, GLTransaction, SourceFieldValue } from '../models/generalLedger';
import type { ParserWorkbook, WorkbookRow, WorkbookSheet } from '../models/workbook';
import type { GLParseResult, GLParser, ParserDetection, ParserIssue, SkippedRowCategory } from './types';
import { cellAt, cellText, dateFromCell, identifierText, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';
import { addCents, balancesAgree, fromCents, subtractCents, toCents } from '../utils/money';
import type { Cents } from '../utils/money';

export const YARDI_COLUMNS = ['Property', 'Property Name', 'Date', 'Period', 'Person/Description', 'Control', 'Reference', 'Debit', 'Credit', 'Balance', 'Remarks'] as const;
const normalizedColumns = YARDI_COLUMNS.map(normalizedHeader);
type Column = typeof YARDI_COLUMNS[number];
interface Layout { sheet: WorkbookSheet; header: WorkbookRow; columns: Record<Column, number>; confidence: number; reasons: string[] }

function marker(value: string, kind: 'Beginning' | 'Ending'): boolean {
  return new RegExp(`^=?\\s*${kind}\\s+Balance\\s*=?$`, 'i').test(value.trim());
}
function controlMarker(row: WorkbookRow, layout: Pick<Layout, 'columns'>, kind: 'Beginning' | 'Ending'): boolean {
  const c = layout.columns;
  return marker(cellText(cellAt(row, c.Remarks)), kind) &&
    !cellText(cellAt(row, c.Date)).trim() && !cellText(cellAt(row, c.Period)).trim() && !cellText(cellAt(row, c.Control)).trim();
}

/** Evidence from the supplied structures, never filenames or generic Date/Debit headers alone. */
function inspectLayouts(workbook: ParserWorkbook): Layout[] {
  const layouts: Layout[] = [];
  for (const sheet of workbook.sheets) {
    const header = sheet.rows.find(row => row.sourceRowNumber <= 200 && normalizedColumns.every(name => row.cells.some(cell => normalizedHeader(cellText(cell)) === name)));
    if (!header) continue;
    const names = header.cells.map(cell => normalizedHeader(cellText(cell)));
    if (normalizedColumns.some(name => names.filter(value => value === name).length !== 1)) continue;
    const columns = Object.fromEntries(YARDI_COLUMNS.map((name, index) => [name, names.indexOf(normalizedColumns[index])])) as Record<Column, number>;
    const layout = { sheet, header, columns };
    const reportRows = sheet.rows.filter(row => row.sourceRowNumber < header.sourceRowNumber);
    const title = reportRows.some(row => row.cells.some(cell => /^general ledger$/i.test(cellText(cell).trim())));
    const book = reportRows.some(row => row.cells.some(cell => /^book\s*=/i.test(cellText(cell).trim())));
    const beginning = sheet.rows.some(row => controlMarker(row, layout, 'Beginning') &&
      !!cellText(cellAt(row, columns.Property)).trim() && !!cellText(cellAt(row, columns['Person/Description'])).trim());
    const ending = sheet.rows.some(row => controlMarker(row, layout, 'Ending'));
    const confidence = Math.min(1, 0.6 + (beginning ? 0.2 : 0) + (ending ? 0.1 : 0) + (title ? 0.05 : 0) + (book ? 0.05 : 0));
    const reasons = ['All eleven Yardi layout headers are present exactly once.'];
    if (beginning) reasons.push('Account identifier/description headings with an explicit Beginning Balance marker.');
    if (ending) reasons.push('Explicit Ending Balance control rows.');
    if (title) reasons.push('General Ledger report title.');
    if (book) reasons.push('Book = accounting-basis metadata.');
    layouts.push({ ...layout, confidence, reasons });
  }
  return layouts.sort((a, b) => b.confidence - a.confidence);
}

export function detectYardi(workbook: ParserWorkbook): ParserDetection {
  const layouts = inspectLayouts(workbook);
  if (layouts.filter(layout => layout.confidence >= 0.85).length > 1) return { confidence: 0, reasons: ['Multiple Yardi report sheets require explicit scope review; automatic sheet selection is unavailable.'] };
  return layouts[0] ? { confidence: layouts[0].confidence, reasons: layouts[0].reasons } : { confidence: 0, reasons: ['The complete Yardi header and hierarchical balance structure were not found.'] };
}

interface AccountContext {
  accountNumber: string; accountDescription: string; headingRow: number;
  beginningBalance?: number; endingBalance?: number; endingRow?: number;
  transactionCount: number; debits: Cents[]; credits: Cents[]; reliable: boolean;
}

export function parseYardiWorkbook(workbook: ParserWorkbook): GLParseResult {
  const transactions: GLTransaction[] = [], accountSummaries: GLAccountSummary[] = [], warnings: ParserIssue[] = [], errors: ParserIssue[] = [];
  const sourceMetadata = { parserId: 'yardi' as const, workbook: workbook.metadata, parserVersion: '0.2.0' };
  const detection = detectYardi(workbook), layout = inspectLayouts(workbook)[0];
  if (!layout || detection.confidence < 0.85) return { transactions, accountSummaries, warnings, errors: [{ code: 'YARDI_STRUCTURE_UNRECOGNIZED', message: 'The workbook does not contain one confidently recognized Yardi general ledger report.' }], sourceMetadata };
  const { sheet, columns: c, header } = layout;
  const accountHeadingRows: number[] = [], endingBalanceRows: number[] = [];
  const skippedRows: Record<SkippedRowCategory, number> = { reportHeader: 0, columnHeader: 0, accountHeading: 0, beginningBalance: 0, endingBalance: 0, subtotal: 0, blank: 0, reportFooter: 0, review: 0 };
  let current: AccountContext | undefined;
  function issue(code: string, message: string, rowNumber?: number): ParserIssue { return { code, message, sourceSheetName: sheet.name, sourceRowNumber: rowNumber }; }
  function finish() {
    if (!current) return;
    if (current.endingBalance === undefined) warnings.push(issue('YARDI_ENDING_UNAVAILABLE', 'No reliable explicit ending balance was found for this account.', current.headingRow));
    accountSummaries.push({ accountNumber: current.accountNumber, accountDescription: current.accountDescription, beginningBalance: current.beginningBalance, endingBalance: current.endingBalance,
      transactionCount: current.transactionCount, balanceValidationAvailable: current.endingBalance !== undefined && current.reliable,
      sourceSheetName: sheet.name, sourceHeadingRowNumber: current.headingRow, sourceEndingRowNumber: current.endingRow });
    current = undefined;
  }
  function amount(row: WorkbookRow, column: Column, required: boolean, blocking: boolean): number | undefined {
    try {
      const value = monetaryValue(cellAt(row, c[column]));
      if (required && value === undefined) throw new Error('Missing');
      return value;
    } catch {
      (blocking ? errors : warnings).push(issue('YARDI_INVALID_AMOUNT', `${column} contains a missing or invalid amount; review this row.`, row.sourceRowNumber));
      if (current) current.reliable = false;
      return undefined;
    }
  }
  function sourceFields(row: WorkbookRow): Readonly<Record<string, SourceFieldValue>> {
    const fields: Record<string, SourceFieldValue> = Object.create(null);
    row.cells.forEach((cell, index) => {
      const rawLabel = cellText(cellAt(header, index)).trim() || `Source Column ${index + 1}`;
      const label = Object.hasOwn(fields, rawLabel) ? `${rawLabel} [column ${index + 1}]` : rawLabel;
      if (cell.error) fields[label] = cell.error;
      else if (cell.dateValue) fields[label] = cell.formattedText ?? cell.dateValue;
      else if (index === c.Property || index === c.Control || index === c.Reference) fields[label] = cell.value === null ? null : cellText(cell);
      else fields[label] = cell.value;
    });
    return fields;
  }
  for (const row of sheet.rows) {
    if (isBlankRow(row)) { skippedRows.blank++; continue; }
    if (row.sourceRowNumber < header.sourceRowNumber) { skippedRows.reportHeader++; continue; }
    if (normalizedColumns.every(name => row.cells.some(cell => normalizedHeader(cellText(cell)) === name))) { skippedRows.columnHeader++; continue; }
    const beginning = controlMarker(row, layout, 'Beginning'), ending = controlMarker(row, layout, 'Ending');
    const dateCell = cellAt(row, c.Date), date = dateFromCell(dateCell);
    const identifierCell = cellAt(row, c.Property), description = cellText(cellAt(row, c['Person/Description']));
    const standaloneHeading = !date && !cellText(dateCell).trim() && !!cellText(identifierCell).trim() && !!description.trim() &&
      !cellText(cellAt(row, c['Property Name'])).trim() && !cellText(cellAt(row, c.Period)).trim() && !cellText(cellAt(row, c.Control)).trim() &&
      !cellText(cellAt(row, c.Debit)).trim() && !cellText(cellAt(row, c.Credit)).trim() && !ending && !/^(subtotal|total|net change|page)\b/i.test(cellText(identifierCell).trim());
    if (beginning || standaloneHeading) {
      if (beginning && !cellText(identifierCell).trim() && current) {
        skippedRows.beginningBalance++;
        if (current.beginningBalance !== undefined) { current.reliable = false; warnings.push(issue('YARDI_DUPLICATE_BEGINNING', 'More than one beginning balance was found for this account.', row.sourceRowNumber)); }
        else current.beginningBalance = amount(row, 'Balance', true, false);
        continue;
      }
      finish(); skippedRows[beginning ? 'beginningBalance' : 'accountHeading']++;
      let accountNumber: string;
      try { accountNumber = identifierText(identifierCell); }
      catch { errors.push(issue('YARDI_ACCOUNT_IDENTIFIER', 'Account heading has no valid account identifier.', row.sourceRowNumber)); skippedRows.review++; continue; }
      current = { accountNumber, accountDescription: description, headingRow: row.sourceRowNumber, transactionCount: 0, debits: [], credits: [], reliable: true };
      accountHeadingRows.push(row.sourceRowNumber);
      if (!description.trim()) warnings.push(issue('YARDI_DESCRIPTION_MISSING', 'Account heading description is missing.', row.sourceRowNumber));
      if (typeof identifierCell.value === 'number') warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', 'Numeric account identifier was preserved using its displayed text; source formatting limits apply.', row.sourceRowNumber));
      if (beginning) current.beginningBalance = amount(row, 'Balance', true, false);
      continue;
    }
    if (ending) {
      skippedRows.endingBalance++;
      if (!current) { warnings.push(issue('YARDI_ORPHAN_ENDING', 'Ending balance has no open account heading and was not assigned.', row.sourceRowNumber)); skippedRows.review++; continue; }
      current.endingBalance = amount(row, 'Balance', true, false); current.endingRow = row.sourceRowNumber; endingBalanceRows.push(row.sourceRowNumber);
      const expectedDebit = amount(row, 'Debit', false, false), expectedCredit = amount(row, 'Credit', false, false);
      try {
        const debit = fromCents(addCents(current.debits)), credit = fromCents(addCents(current.credits));
        const rollForward = current.beginningBalance === undefined ? undefined : fromCents(addCents([toCents(current.beginningBalance), toCents(debit), -toCents(credit) as Cents]));
        if ((expectedDebit !== undefined && !balancesAgree(debit, expectedDebit)) || (expectedCredit !== undefined && !balancesAgree(credit, expectedCredit)) ||
          (rollForward !== undefined && current.endingBalance !== undefined && !balancesAgree(rollForward, current.endingBalance))) {
          current.reliable = false;
          warnings.push(issue('YARDI_CONTROL_DIFFERENCE', 'Account transaction totals or beginning-to-ending roll-forward differ from explicit controls. Balance validation is unavailable.', row.sourceRowNumber));
        }
      } catch { current.reliable = false; errors.push(issue('YARDI_AMOUNT_RANGE', 'Account totals exceed safe cent precision.', row.sourceRowNumber)); }
      finish(); continue;
    }
    const label = [identifierCell, cellAt(row, c['Person/Description']), cellAt(row, c.Remarks)].map(cellText).join(' ').trim();
    const hasTransactionIdentity = [c.Control, c.Reference, c.Period, c['Property Name']].some(index => !!cellText(cellAt(row, index)).trim());
    if (!date && !cellText(dateCell).trim() && !hasTransactionIdentity && /^(?:subtotal|total|grand total|net change)\b/i.test(label)) { skippedRows.subtotal++; continue; }
    const amountOnly = row.cells.every((cell, index) => [c.Debit, c.Credit].includes(index) || !cellText(cell).trim());
    if (!current && amountOnly) { skippedRows.reportFooter++; continue; }
    if (!date && !cellText(dateCell).trim() && !hasTransactionIdentity && !cellText(cellAt(row, c.Debit)).trim() && !cellText(cellAt(row, c.Credit)).trim() &&
      row.cells.some(cell => /^(?:page\s+\d+|general ledger|book\s*=|period\s*=|sort on\s*=)/i.test(cellText(cell).trim()))) { skippedRows.reportFooter++; continue; }
    if (date) {
      if (!current) { errors.push(issue('YARDI_ORPHAN_TRANSACTION', 'Dated transaction has no open account heading and was not assigned.', row.sourceRowNumber)); skippedRows.review++; continue; }
      const errorCount = errors.length;
      const debit = amount(row, 'Debit', false, true), credit = amount(row, 'Credit', false, true);
      if (debit === undefined && credit === undefined && errors.length === errorCount) errors.push(issue('YARDI_MISSING_TRANSACTION_AMOUNT', 'Dated row has no debit or credit; it requires review rather than a guessed amount.', row.sourceRowNumber));
      if (errors.length > errorCount) { current.reliable = false; skippedRows.review++; continue; }
      const runningBalance = amount(row, 'Balance', false, false);
      let netAmount: number;
      try { netAmount = fromCents(subtractCents(toCents(debit ?? 0), toCents(credit ?? 0))); }
      catch { errors.push(issue('YARDI_AMOUNT_RANGE', 'Transaction net amount exceeds safe cent precision.', row.sourceRowNumber)); current.reliable = false; skippedRows.review++; continue; }
      const referenceCell = cellAt(row, c.Reference), controlCell = cellAt(row, c.Control);
      for (const cell of [referenceCell, controlCell, identifierCell]) if (typeof cell.value === 'number') warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', 'A numeric source identifier was preserved using its displayed text.', row.sourceRowNumber));
      transactions.push({ accountNumber: current.accountNumber, accountDescription: current.accountDescription, transactionDate: date,
        reference: cellText(referenceCell) || undefined, payeeOrName: description || undefined, description: cellText(cellAt(row, c.Remarks)) || undefined,
        debit, credit, netAmount, runningBalance, sourceFormat: 'yardi', sourceRowNumber: row.sourceRowNumber, sourceSheetName: sheet.name, sourceFields: sourceFields(row) });
      current.transactionCount++; current.debits.push(toCents(debit ?? 0)); current.credits.push(toCents(credit ?? 0)); continue;
    }
    const transactionShaped = !!cellText(dateCell).trim() || !!cellText(cellAt(row, c.Control)).trim() || !!cellText(cellAt(row, c.Debit)).trim() || !!cellText(cellAt(row, c.Credit)).trim();
    (transactionShaped ? errors : warnings).push(issue(transactionShaped ? 'YARDI_MALFORMED_TRANSACTION' : 'YARDI_UNRECOGNIZED_ROW', 'Row could not be safely classified. Review the source row; it was not emitted as a transaction.', row.sourceRowNumber));
    if (current) current.reliable = false;
    skippedRows.review++;
  }
  finish();
  if (!accountSummaries.length) errors.push(issue('YARDI_NO_ACCOUNTS', 'No Yardi account records were found.'));
  const seen = new Set<string>();
  for (const summary of accountSummaries) {
    if (seen.has(summary.accountNumber)) warnings.push(issue('YARDI_DUPLICATE_ACCOUNT', 'Account identifier occurs in multiple GL blocks; deterministic TB matching requires review.', summary.sourceHeadingRowNumber));
    seen.add(summary.accountNumber);
  }
  return { transactions, accountSummaries, warnings, errors, sourceMetadata, diagnostics: { detectedSheet: sheet.name, headerRowNumber: header.sourceRowNumber,
    accountHeadingRows, endingBalanceRows, skippedRows, transactionCount: transactions.length,
    endingBalanceCount: accountSummaries.filter(summary => summary.endingBalance !== undefined).length,
    reliableEndingBalanceCount: accountSummaries.filter(summary => summary.balanceValidationAvailable).length, warningCount: warnings.length } };
}

export const yardiParser: GLParser = { id: 'yardi', displayName: 'Yardi General Ledger', implemented: true, detect: detectYardi, parse: async workbook => parseYardiWorkbook(workbook) };
