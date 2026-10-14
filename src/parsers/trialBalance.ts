import { TB_COLUMNS } from '../models/trialBalance';
import type { TBAccount } from '../models/trialBalance';
import type { ParserWorkbook, WorkbookRow } from '../models/workbook';
import type { TBParseResult } from '../models/processing';
import type { ParserIssue } from './types';
import { cellAt, cellText, identifierText, isBlankRow, monetaryValue, normalizedHeader } from '../utils/workbookValues';

const headers = TB_COLUMNS.map(normalizedHeader);
const flatExportHelp = 'This does not appear to be the Carter & Company Account Detail Generator trial balance. Export the flat Account Detail Generator TB from CCH and try again.';
const scientificDisplay = /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]\d+$/;
const controlLabel = /^(?:grand\s+total|sub\s*total|total|leadcode|subgroup|group)(?:\s|:|\[|$)/i;
/** Only the approved flat schema is accepted. Published CCH hierarchies are deliberately incompatible. */
export function parseStandardizedTrialBalance(workbook: ParserWorkbook): TBParseResult {
  const errors: ParserIssue[] = [], warnings: ParserIssue[] = [], accounts: TBAccount[] = [], reviewedRows: number[] = [];
  const candidates = workbook.sheets.flatMap(sheet => sheet.rows.filter(row => row.sourceRowNumber <= 200).map(row => {
    const values = row.cells.map(cell => normalizedHeader(cellText(cell)));
    return { sheet, row, values, score: headers.filter(header => values.includes(header)).length };
  })).sort((a, b) => b.score - a.score);
  const complete = candidates.filter(candidate => candidate.score === headers.length);
  const best = complete[0] ?? candidates.find(candidate => candidate.score >= 2);
  if (!best) return {
    accounts, warnings, errors: [{ code: 'TB_SCHEMA_MISSING', message: flatExportHelp }],
    diagnostics: { accountCount: 0, reviewedRows },
  };
  const { sheet, row: headerRow, values } = best;
  function issue(code: string, message: string, row?: WorkbookRow): ParserIssue {
    if (row) reviewedRows.push(row.sourceRowNumber);
    return { code, message, sourceSheetName: sheet.name, sourceRowNumber: row?.sourceRowNumber };
  }
  const columns = headers.map(header => values.indexOf(header));
  const missing = TB_COLUMNS.filter((_header, index) => columns[index] < 0);
  if (missing.length) errors.push(issue('TB_REQUIRED_COLUMNS', `Missing required TB columns: ${missing.join(', ')}.`, headerRow));
  if (complete.length > 1) errors.push(issue('TB_AMBIGUOUS_TABLE', 'Multiple standardized TB tables were found. Provide one flat account table.'));
  if (values.some((value, index) => value && !headers.includes(value) && index >= 0)) errors.push(issue('TB_UNEXPECTED_COLUMNS', 'The flat TB must contain exactly the seven approved logical fields.', headerRow));
  if (headers.some(header => values.filter(value => value === header).length > 1)) errors.push(issue('TB_DUPLICATE_COLUMNS', 'A required TB column appears more than once.', headerRow));
  if (columns.some(index => index >= 0 && (cellAt(headerRow, index).formula || cellAt(headerRow, index).error))) errors.push(issue('TB_HEADER_VALUE', 'Export the seven column headers as plain text, with no formulas or Excel errors.', headerRow));
  if (sheet.mergedRanges?.length) errors.push(issue('TB_MERGED_CELLS', 'Merged cells are not allowed in the standardized TB.'));
  if (errors.length) return { accounts, warnings, errors, diagnostics: { detectedSheet: sheet.name, headerRowNumber: headerRow.sourceRowNumber, accountCount: 0, reviewedRows } };
  const seen = new Map<string, number>();
  const duplicates = new Set<string>();
  let missingLeadcodes = 0;
  const descriptions = new Map<string, Set<string>>();
  const records = sheet.rows.filter(row => row.sourceRowNumber > headerRow.sourceRowNumber);
  const blankRecord = (row: WorkbookRow) => isBlankRow(row) && !row.cells.some(cell => cell.formula);
  const lastRecord = records.map(blankRecord).lastIndexOf(false);
  for (const row of records.slice(0, lastRecord + 1)) {
    if (blankRecord(row)) { errors.push(issue('TB_BLANK_SPACER', 'Blank spacer rows are not allowed inside the flat account table.', row)); continue; }
    const cells = columns.map(index => cellAt(row, index));
    for (const [index, cell] of cells.entries()) {
      if (cell.formula) {
        if (index === 0 || index === 2 || cell.value === null || cell.error) errors.push(issue('TB_FORMULA_VALUE', `${TB_COLUMNS[index]} uses a formula that cannot provide an authoritative value. Export the account table as values.`, row));
        else warnings.push(issue('TB_CACHED_FORMULA', `${TB_COLUMNS[index]} uses a saved formula value. Verify it in CCH and export values before production use.`, row));
      }
    }
    let accountNumber: string | undefined, leadcode: string | undefined;
    try { accountNumber = identifierText(cells[0]); } catch { errors.push(issue('TB_ACCOUNT_REQUIRED', 'Account Number is missing or invalid.', row)); }
    try { leadcode = identifierText(cells[2]); } catch { missingLeadcodes++; errors.push(issue('TB_LEADCODE_REQUIRED', 'Leadcode is missing or invalid. Assign a leadcode to this posting account in CCH and export again.', row)); }
    const accountDescription = cellText(cells[1]), leadcodeDescription = cellText(cells[3]);
    if (!accountDescription.trim()) warnings.push(issue('TB_ACCOUNT_DESCRIPTION_MISSING', 'Account Description is missing; the account is retained.', row));
    if (!leadcodeDescription.trim()) warnings.push(issue('TB_LEADCODE_DESCRIPTION_MISSING', 'Leadcode Description is missing; the account is retained.', row));
    if (cells[1].error || cells[3].error) errors.push(issue('TB_DESCRIPTION_ERROR', 'A description cell contains an Excel error.', row));
    for (const index of [0, 2]) {
      const cell = cells[index], text = cellText(cell).trim();
      if (scientificDisplay.test(text)) {
        const entry = issue('TB_IDENTIFIER_SCIENTIFIC', `${TB_COLUMNS[index]} appears in scientific notation. Confirm the original text identifier and export it as text; no digits were reconstructed.`, row);
        (typeof cell.value === 'number' ? errors : warnings).push(entry);
      }
      if (typeof cell.value === 'number') {
        if (!Number.isSafeInteger(cell.value) || Math.abs(cell.value) >= 1e15) errors.push(issue('TB_IDENTIFIER_PRECISION', `${TB_COLUMNS[index]} is numeric and may have lost identifier precision. Re-export the original code as text.`, row));
        warnings.push(issue('NUMERIC_IDENTIFIER_DISPLAY', `${TB_COLUMNS[index]} is stored numerically. Its displayed text is preserved; zeros already lost in the source cannot be recovered. Export identifiers as text.`, row));
      }
    }
    if (accountNumber && (controlLabel.test(accountNumber.trim()) || /^(?:grand total|subtotal|total(?:\s*\[[^\]]+\])?)$/i.test(accountDescription.trim()))) errors.push(issue('TB_STRUCTURAL_ROW', 'A total, subtotal or heading appears in the account table. Export posting accounts only, with no control rows.', row));
    if (!accountNumber && leadcode && cells.slice(4).every(cell => cell.value === null)) errors.push(issue('TB_LEADCODE_ONLY_ROW', 'A leadcode heading appears without a posting account. Repeat its leadcode on each account row instead.', row));
    const balances: (number | undefined)[] = [];
    for (let index = 4; index <= 6; index++) {
      try {
        const amount = monetaryValue(cells[index]);
        if (amount === undefined) throw new Error('Missing');
        balances.push(amount);
        const sourceValue = cells[index].value;
        const original = typeof sourceValue === 'number' ? sourceValue : Number(String(sourceValue).replace(/[$,()]/g, ''));
        if (Number.isFinite(original) && Math.abs(Math.abs(original) - Math.abs(amount)) > 1e-9) warnings.push(issue('TB_FRACTIONAL_CENT', `${TB_COLUMNS[index]} has fractional cents and was rounded using the shared cent policy. Verify the source amount.`, row));
      } catch { balances.push(undefined); errors.push(issue('TB_INVALID_AMOUNT', `${TB_COLUMNS[index]} is missing or is not a valid monetary amount.`, row)); }
    }
    if (row.cells.some((cell, index) => !columns.includes(index) && (cell.error || cell.formula || cell.value !== null && cellText(cell).trim()))) errors.push(issue('TB_UNEXPECTED_DATA', 'Data exists outside the seven approved TB columns.', row));
    if (accountNumber && seen.has(accountNumber)) { duplicates.add(accountNumber); errors.push(issue('TB_DUPLICATE_ACCOUNT', `Account Number ${accountNumber} is duplicated; its first occurrence is row ${seen.get(accountNumber)}. Each account must appear only once, with one leadcode.`, row)); }
    if (accountNumber) seen.set(accountNumber, seen.get(accountNumber) ?? row.sourceRowNumber);
    if (accountNumber && leadcode && balances.every(value => value !== undefined)) {
      const existing = descriptions.get(leadcode) ?? new Set<string>();
      if (leadcodeDescription.trim()) existing.add(leadcodeDescription);
      descriptions.set(leadcode, existing);
      accounts.push({ accountNumber, accountDescription, leadcode, leadcodeDescription, unadjustedBalance: balances[0]!, finalAdjustedBalance: balances[1]!, priorYearFinalBalance: balances[2]!, sourceRowNumber: row.sourceRowNumber, sourceSheetName: sheet.name });
    }
  }
  if (!accounts.length) errors.push(issue('TB_NO_ACCOUNTS', 'No valid account records were found.'));
  for (const [code, values] of descriptions) if (values.size > 1) warnings.push(issue('TB_LEADCODE_DESCRIPTION_CONFLICT', `Leadcode ${code} has inconsistent descriptions. Account assignments are retained; confirm the description in CCH.`));
  if (duplicates.size) errors.push(issue('TB_DUPLICATE_ACCOUNT_SUMMARY', `The trial balance contains ${duplicates.size} duplicate account number${duplicates.size === 1 ? '' : 's'}. Each account must appear only once; matching is blocked for this file.`));
  if (missingLeadcodes) errors.push(issue('TB_MISSING_LEADCODES_SUMMARY', `${missingLeadcodes} account${missingLeadcodes === 1 ? ' is' : 's are'} missing a valid leadcode and cannot be assigned to output worksheets.`));
  return { accounts, warnings, errors, diagnostics: { detectedSheet: sheet.name, headerRowNumber: headerRow.sourceRowNumber, accountCount: accounts.length, reviewedRows: [...new Set(reviewedRows)] } };
}
