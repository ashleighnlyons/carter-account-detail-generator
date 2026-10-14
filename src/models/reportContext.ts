/** Display-only source evidence. Never an account key or a transaction inclusion rule. */
export interface ContextEvidence {
  readonly value:string;
  readonly label:string;
  readonly sourceSheetName:string;
  readonly sourceRowNumber:number;
}
export interface ReportContext {
  readonly entity?:ContextEvidence & {readonly kind:'client'|'company'|'entity'|'property'|'portfolio'};
  readonly periodStart?:ContextEvidence;
  readonly periodEnd?:ContextEvidence;
  readonly notes:readonly string[];
}
