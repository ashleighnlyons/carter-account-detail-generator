import type { WorkbookProcessingResult } from '../models/processing';
import type { ParserWorkbook } from '../models/workbook';
import { parseTrialBalance } from '../parsers/tbDetection';
import { detectGLParser } from '../parsers/detection';
import type { GLParseResult } from '../parsers/types';
import { extractReportContext } from './reportContext';

export async function processParserWorkbook(workbook: ParserWorkbook, role: 'trialBalance' | 'generalLedger'): Promise<WorkbookProcessingResult> {
  if (role === 'trialBalance') {
    const tb=parseTrialBalance(workbook),context=extractReportContext(workbook,tb.diagnostics.detectedSheet,tb.diagnostics.headerRowNumber,tb.diagnostics.format??'flat');
    return {role,metadata:workbook.metadata,tb:context?{...tb,reportContext:context}:tb};
  }
  const decision = detectGLParser(workbook);
  const selectedScore = decision.scores.find(score => score.parser.id === decision.selectedParser.id);
  const recognized = !decision.requiresCustomMapping;
  let gl: GLParseResult;
  if (recognized) {
    try { gl = await decision.selectedParser.parse(workbook); }
    catch { gl = { transactions: [], accountSummaries: [], warnings: [], errors: [{ code: 'GL_PARSER_FAILURE', message: `${decision.selectedParser.displayName} could not be processed safely. Review the export or choose a fresh unencrypted workbook.` }],
      sourceMetadata: { parserId: decision.selectedParser.id, workbook: workbook.metadata, parserVersion: '0.3.0' } }; }
  } else gl = { transactions: [], accountSummaries: [], warnings: [],
    errors: [{ code: 'GL_FORMAT_UNRECOGNIZED', message: 'No GL structure was confidently recognized. Yardi, AppFolio, OneSite, FirstService, QuickBooks and Vantaca are currently supported; Custom mapping is not implemented.' }],
    sourceMetadata: { parserId: 'custom' as const, workbook: workbook.metadata, parserVersion: '0.3.0' } };
  const context=recognized?extractReportContext(workbook,gl.diagnostics?.detectedSheet,gl.diagnostics?.headerRowNumber,gl.sourceMetadata.parserId):undefined;
  if(context)gl={...gl,sourceMetadata:{...gl.sourceMetadata,reportContext:context}};
  return { role, metadata: workbook.metadata, gl, detection: { parserId: decision.selectedParser.id, displayName: decision.selectedParser.displayName, confidence: selectedScore?.confidence ?? decision.scores[0]?.confidence ?? 0, recognized,
    reasons: recognized ? selectedScore?.reasons ?? [] : decision.scores.flatMap(score => score.reasons) } };
}
