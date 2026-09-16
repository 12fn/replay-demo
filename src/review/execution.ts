/** Projection over already-authorized, as-of events. Admission and measured effects stay separate. */
export interface ExecutionEvent {id:string;tick:number;kind:string;summary:string;actor?:string;side?:string|null;details:Record<string,any>;}
export function unwrapEvent(event:ExecutionEvent){
 let kind=event.kind,details=event.details,inherited=false,sourceExerciseId=details.sourceExerciseId as string|undefined;
 for(let depth=0;kind==='inherited_event'&&depth<64;depth++){
  inherited=true;sourceExerciseId=details.parentId;kind=details.originalKind;details=details.originalDetails??{};
 }
 return{...event,kind,details,inherited,sourceExerciseId:details.sourceExerciseId??sourceExerciseId};
}
export const feedbackLabel=(status:string)=>status.replaceAll('-',' ');
export function orderProgress(events:ExecutionEvent[],limit=12,observedIntentsOnly=false){
 const rows=events.map(unwrapEvent),observations=new Map<string,typeof rows>();
 const key=(r:typeof rows[number])=>`${r.sourceExerciseId??''}:${r.details.commandId??r.id}`;
 for(const e of rows)if(e.kind==='execution_feedback'&&e.details.commandId){const k=key(e),list=observations.get(k)??[];list.push(e);observations.set(k,list);}
 return rows.filter(e=>(e.kind==='command'||e.kind==='command_rejected')&&(!observedIntentsOnly||['boat','build_unit'].includes(e.details.intent?.type))).slice(-limit).map(e=>{
  const feedback=observations.get(key(e))??[],last=feedback.at(-1),admission=e.kind==='command'?'accepted':'rejected';
  return{eventId:e.id,tick:e.tick,side:e.side,summary:e.summary,commandId:e.details.commandId??null,intent:e.details.intent??null,origin:e.details.origin??null,reason:e.details.reason??null,
   admission,status:admission==='rejected'?'rejected':last?.details.feedback?.status??(e.details.effectObserved?'awaiting-observation':'effect-unobserved'),
   inherited:e.inherited,sourceExerciseId:e.sourceExerciseId??null,inputKey:e.details.inputKey??null,
   observations:feedback.map(f=>({eventId:f.id,tick:f.tick,status:f.details.feedback.status,observed:f.details.feedback.observed,inherited:f.inherited||f.details.inherited===true}))};
 });
}
export type OrderProgress=ReturnType<typeof orderProgress>[number];
