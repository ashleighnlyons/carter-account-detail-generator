import type {SessionState} from '../services/sessionState';
import {GenerationError,generationEligibility} from '../output/generationEligibility';

/** Generation owns one short-lived worker; normalized records never leave this computer. */
export function generateWorkbook(state:SessionState,signal:AbortSignal,generatedAt=new Date().toISOString()):Promise<ArrayBuffer> {
  if(signal.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  const eligibility=generationEligibility(state);
  if(!eligibility.eligible)return Promise.reject(new GenerationError(eligibility.reasons[0]));
  return new Promise((resolve,reject)=>{
    let worker:Worker;
    try {worker=new Worker(new URL('./generation.worker.ts',import.meta.url),{type:'module'});}
    catch {reject(new GenerationError('This browser could not start local workbook generation.'));return;}
    const cleanup=()=>{clearTimeout(timeout);signal.removeEventListener('abort',abort);worker.onmessage=worker.onerror=worker.onmessageerror=null;worker.terminate();};
    const abort=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));};
    const timeout=setTimeout(()=>{cleanup();reject(new GenerationError('Workbook generation timed out. Generate smaller groups of leadcodes.'));},180_000);
    signal.addEventListener('abort',abort,{once:true});
    worker.onmessage=(event:MessageEvent<{ok:boolean;bytes?:ArrayBuffer;message?:string}>)=>{cleanup();if(event.data.ok&&event.data.bytes instanceof ArrayBuffer)resolve(event.data.bytes);else reject(new GenerationError(event.data.message??'Local workbook generation failed.'));};
    worker.onerror=event=>{event.preventDefault();cleanup();reject(new GenerationError('Local workbook generation failed. Try selecting fewer leadcodes.'));};
    worker.onmessageerror=()=>{cleanup();reject(new GenerationError('The generated workbook could not be returned locally.'));};
    try{worker.postMessage({state,generatedAt});}catch{cleanup();reject(new GenerationError('The selected records could not be passed to local generation.'));}
  });
}
