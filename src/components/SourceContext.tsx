import type {SessionState} from '../services/sessionState';
import {assessReportContext} from '../services/reportContext';
export function SourceContext({state}:{state:SessionState}){
  const context=assessReportContext(state);if(!context.tb&&!context.gl)return null;
  return <div className="source-context">
    {([['TB',context.tb],['GL',context.gl]] as const).map(([label,source])=>source&&<p key={label}><strong>{label} source context:</strong>{source.entity&&<> {source.entity.label}: {source.entity.value}.</>}{source.periodStart&&<> From {source.periodStart.value}.</>}{source.periodEnd&&<> Period end: {source.periodEnd.value}.</>}</p>)}
    {context.warnings.map(w=><p key={w} className="source-context-warning"><strong>Review source scope:</strong> {w}</p>)}
  </div>;
}
