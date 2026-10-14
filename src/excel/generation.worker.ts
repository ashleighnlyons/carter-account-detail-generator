import type {SessionState} from '../services/sessionState';
import {buildWorkbookPlan} from '../output/buildWorkbookPlan';
import {GenerationError} from '../output/generationEligibility';
import {serializeWorkbook} from './workbookWriter';
self.onmessage=(event:MessageEvent<{state:SessionState;generatedAt:string}>)=>{
  try {
    const bytes=serializeWorkbook(buildWorkbookPlan(event.data.state,event.data.generatedAt));
    (self as unknown as {postMessage:(message:unknown,transfer:Transferable[])=>void}).postMessage({ok:true,bytes},[bytes]);
  }catch(error){self.postMessage({ok:false,message:error instanceof GenerationError?error.message:'Local workbook generation failed. Review the source data or select fewer leadcodes.'});}
};
