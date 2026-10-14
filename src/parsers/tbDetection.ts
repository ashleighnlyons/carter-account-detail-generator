import type {ParserWorkbook} from '../models/workbook';
import type {TBParseResult} from '../models/processing';
import {TB_COLUMNS} from '../models/trialBalance';
import {cellText,normalizedHeader} from '../utils/workbookValues';
import {detectPublishedCCH,parsePublishedCCH} from './publishedCCH';
import {parseStandardizedTrialBalance} from './trialBalance';

export function parseTrialBalance(workbook:ParserWorkbook):TBParseResult {
  const published=detectPublishedCCH(workbook).filter(c=>c.confidence>=.85);
  const keys=TB_COLUMNS.map(normalizedHeader);
  const flatScores=workbook.sheets.flatMap(s=>s.rows.filter(r=>r.sourceRowNumber<=200).map(r=>{const labels=r.cells.map(c=>normalizedHeader(cellText(c)));return keys.filter(k=>labels.includes(k)).length;}));
  const flatScore=Math.max(0,...flatScores);
  if(published.length && flatScore===7)return {accounts:[],warnings:[],errors:[{code:'TB_AMBIGUOUS_FORMAT',message:'Both published CCH and flat account tables were found. Provide one trial balance representation in one workbook.'}],diagnostics:{format:'unknown',accountCount:0,reviewedRows:[]}};
  if(published.length)return parsePublishedCCH(workbook,published[0]);
  if(flatScore>=2){const parsed=parseStandardizedTrialBalance(workbook);return {...parsed,diagnostics:{...parsed.diagnostics,format:'flat',confidence:flatScore/7,detectionReasons:['Carter/CCH seven-field header structure']}};}
  return {accounts:[],warnings:[],errors:[{code:'TB_FORMAT_UNSUPPORTED',message:'This workbook does not appear to be a supported CCH Leadcode Trial Balance or Carter/CCH flat trial balance. Export the original CCH published report with its account/subgroup and balance fields intact, or use the seven-column flat format.'}],diagnostics:{format:'unknown',confidence:0,accountCount:0,reviewedRows:[]}};
}
