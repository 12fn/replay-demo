/** Read-only projection of durable staff updates; never changes the task or invokes inference. */
export interface StaffResultView {
  eventId:string;tick:number;observedTick:number|null;text:string;sourceIds:string[];
  method:string|null;receiptId:string|null;
}
interface Event {id:string;tick:number;kind:string;side?:string|null;summary:string;details:any;}
const result=(e:Event|undefined):StaffResultView|null=>e?{
 eventId:e.id,tick:e.tick,observedTick:Number.isSafeInteger(e.details.observedTick)?e.details.observedTick:null,
 text:e.summary,sourceIds:Array.isArray(e.details.sourceIds)?e.details.sourceIds.filter((id:unknown)=>typeof id==='string'):[],
 method:typeof e.details.method==='string'?e.details.method:null,receiptId:typeof e.details.receiptId==='string'?e.details.receiptId:null,
}:null;

/** Reconstruct retained model and provenance results from accepted updates, including older tasks. */
export function taskView(task:any,events:Event[],at:number|null=null){
 const updates=events.filter(e=>e.kind==='staff_update'&&e.details?.taskId===task.id&&e.side===task.side&&(at===null||e.tick<=at));
 const latest=result(updates.at(-1));
 const modelResult=result(updates.filter(e=>e.details.method==='model staff agent').at(-1));
 // Retain the existing public field name for the latest free result, including objective watches.
 const provenanceResult=result(updates.filter(e=>['deterministic provenance watcher','deterministic objective watcher'].includes(e.details.method)).at(-1));
 // Historical projections explicitly select immutable task fields. Current cursors, baselines,
 // cancellation state, seen reports and paid-controller metadata must not appear in an earlier view.
 // The configuration is fixed at creation. Use that recorded event in a past view rather
 // than copying a mutable current row (which also holds private comparison state).
 const creation=events.find(e=>e.kind==='task_created'&&e.details?.taskId===task.id&&e.side===task.side&&(at===null||e.tick<=at));
 const configured=creation?.details.watchConfig?.schema==='replay.watch-config/1';
 const historicalConfig=configured?{watchConfig:creation!.details.watchConfig,interpretation:typeof creation!.details.interpretation==='string'?creation!.details.interpretation:undefined}:{};
 const base=at===null?task:{id:task.id,owner:task.owner,side:task.side,title:task.title,objective:task.objective??task.title,createdTick:task.createdTick,status:'historical',phase:'historical',kind:'provenance-watch',modelEnabled:false,cursor:latest?.tick??task.createdTick,...historicalConfig};
 return {...base,lastResult:latest?.text??null,sourceIds:latest?.sourceIds??[],lastMethod:latest?.method??null,lastReceiptId:latest?.receiptId??null,lastObservedTick:latest?.observedTick??latest?.tick??task.createdTick,lastModelTick:modelResult?.tick??null,modelResult,provenanceResult};
}
