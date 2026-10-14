import type { ParserWorkbook } from '../models/workbook';
import type { GLParser, ParserDetection } from './types';
import { parserRegistry } from './registry';

export const DETECTION_POLICY = { minimumConfidence: 0.85, minimumMargin: 0.1 } as const;
export interface ScoredParser extends ParserDetection { readonly parser: GLParser }
export interface DetectionDecision {
  readonly selectedParser: GLParser;
  readonly requiresCustomMapping: boolean;
  readonly reason: string;
  readonly scores: readonly ScoredParser[];
}

export function detectGLParser(workbook: ParserWorkbook, parsers: readonly GLParser[] = parserRegistry): DetectionDecision {
  const custom = parsers.find(parser => parser.id === 'custom');
  if (!custom) throw new Error('Parser registry must include a Custom / Unknown fallback.');
  const scores = parsers.filter(parser => parser.id !== 'custom').map(parser => {
    try {
      const result = parser.detect(workbook);
      const valid = Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1;
      return {
        parser, confidence: parser.implemented && valid ? result.confidence : 0,
        reasons: valid ? result.reasons : ['Parser returned an invalid confidence score.'],
      };
    } catch {
      return { parser, confidence: 0, reasons: ['Detection failed; no source content was logged.'] };
    }
  }).sort((a, b) => b.confidence - a.confidence);
  const best = scores[0];
  const secondScore = scores[1]?.confidence ?? 0;
  const recognized = !!best && best.confidence >= DETECTION_POLICY.minimumConfidence &&
    // Epsilon handles binary floating-point representation at the exact policy boundary.
    best.confidence - secondScore + Number.EPSILON >= DETECTION_POLICY.minimumMargin;
  return {
    selectedParser: recognized ? best.parser : custom,
    requiresCustomMapping: !recognized,
    reason: recognized ? 'High-confidence format recognition.' : 'Insufficient or ambiguous evidence. Custom mapping is required and is not yet implemented.',
    scores,
  };
}
