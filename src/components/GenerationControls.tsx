import {useEffect,useRef,useState} from 'react';
import type {SessionState} from '../services/sessionState';
import {generationEligibility} from '../output/generationEligibility';
import {generateWorkbook} from '../excel/workbookGenerator';
import {downloadWorkbook} from '../excel/downloadWorkbook';
import {Icon} from './Icon';
import {assessReportContext} from '../services/reportContext';

export function GenerationControls({state,onReset}:{state:SessionState;onReset:()=>void}) {
  const eligibility=generationEligibility(state),current=useRef(state);current.current=state;
  const job=useRef<AbortController|undefined>(undefined),release=useRef<(()=>void)|undefined>(undefined);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(false);
  function discard(){job.current?.abort();job.current=undefined;release.current?.();release.current=undefined;}
  useEffect(()=>{
    discard();setBusy(false);setMessage('');setError(false);
    const hide=()=>discard();window.addEventListener('pagehide',hide);
    return ()=>{discard();window.removeEventListener('pagehide',hide);};
  },[state.files,state.trialBalance,state.generalLedger,state.analysis,state.selectedLeadcodes]);
  async function generate(){
    if(job.current||!eligibility.eligible)return;
    const snapshot=state,controller=new AbortController(),generatedAt=new Date().toISOString();
    release.current?.();release.current=undefined;job.current=controller;setBusy(true);setError(false);setMessage('Generating locally…');
    try {
      const bytes=await generateWorkbook(snapshot,controller.signal,generatedAt),latest=current.current;
      if(controller.signal.aborted||job.current!==controller||latest.files!==snapshot.files||latest.analysis!==snapshot.analysis||latest.selectedLeadcodes!==snapshot.selectedLeadcodes)return;
      release.current=downloadWorkbook(bytes,generatedAt,assessReportContext(snapshot));setMessage('Workbook download started. Review the workbook’s controls and warnings, then save it to the engagement.');
    }catch(reason){if(!controller.signal.aborted){setError(true);setMessage(reason instanceof Error?reason.message:'Local workbook generation failed.');}}
    finally{if(job.current===controller){job.current=undefined;setBusy(false);}}
  }
  return <div className="generation-bar">
    <button className="secondary-button" onClick={()=>{discard();setBusy(false);setMessage('');setError(false);onReset();}}><Icon kind="reset" size={17}/>Start Over</button>
    <div className="generation-action">
      <div id="generation-note" aria-live="polite" className={error?'generation-error':undefined}>
        <span>{message||eligibility.reasons[0]||'Ready to generate locally. Review account and balance statuses before use.'}</span>
        {eligibility.eligible&&eligibility.warnings.map(w=><span className="generation-warning" key={w}>{w}</span>)}
      </div>
      <button className="primary-button" disabled={!eligibility.eligible||busy} aria-describedby="generation-note" onClick={()=>void generate()}><Icon kind="download" size={18}/>{busy?'Generating Workbook…':'Generate Account Detail Workbook'}</button>
    </div>
  </div>;
}
