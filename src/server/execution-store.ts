import {CLIENTS,type ReplayEngine} from '../engine/engine';
import {EXECUTION_FEEDBACK_VERSION,OBSERVED_STRUCTURES,inputKeyString,type InputKey,type ExecutionFeedbackEvent} from '../engine/execution-feedback';
import {unwrapEvent,feedbackLabel} from '../review/execution';
import type {Store,ExerciseRow} from './store';

export const FEEDBACK_PROFILE='execution-feedback/1';
interface Origin {commandId:string;actor:string;side:'blue'|'red';sourceExerciseId:string;inherited:boolean;}
export interface ExecutionRuntime {origins:Map<string,Origin>;dropped:number;failures:number;}
export function observesIntent(intent:any){return intent.type==='boat'||intent.type==='build_unit'&&OBSERVED_STRUCTURES.includes(intent.unit);}
export function commandOccurrence(row:ExerciseRow,key:InputKey,intent:any){
 return row.options.executionFeedback===FEEDBACK_PROFILE?{inputKey:key,inputKeyString:inputKeyString(key),sourceExerciseId:row.id,effectObserved:observesIntent(intent)}:{};
}
/** Restore only in-flight correlations. Historical observations themselves are never regenerated. */
export function loadExecution(store:Store,row:ExerciseRow,engine:ReplayEngine):ExecutionRuntime|undefined{
 if(row.options.executionFeedback!==FEEDBACK_PROFILE)return;
 const needed=new Set(engine.feedback.inFlight().map(inputKeyString)),origins=new Map<string,Origin>();
 if(needed.size)for(const raw of store.events(row.id)){
  const e=unwrapEvent(raw),key=e.details.inputKeyString;
  if(e.kind==='command'&&needed.has(key)&&e.details.commandId&&(e.side==='blue'||e.side==='red'))origins.set(key,{commandId:e.details.commandId,actor:e.actor!,side:e.side,sourceExerciseId:e.sourceExerciseId??row.id,inherited:e.inherited});
 }
 return{origins,dropped:engine.feedback.dropped(),failures:engine.feedback.observerFailures().count};
}
export function rememberExecution(runtime:ExecutionRuntime|undefined,row:ExerciseRow,key:InputKey,command:any){
 if(runtime&&observesIntent(command.intent))runtime.origins.set(inputKeyString(key),{commandId:command.id,actor:command.actor,side:command.side,sourceExerciseId:row.id,inherited:false});
}
/** Caller commits these measured facts in the same transaction as the observed canonical turn. */
export function saveExecution(store:Store,row:ExerciseRow,engine:ReplayEngine,runtime:ExecutionRuntime|undefined,events:ExecutionFeedbackEvent[],fingerprint:string){
 if(!runtime)return;
 const tick=engine.game.ticks();
 for(const feedback of events){
  const origin=runtime.origins.get(feedback.keyString),side=feedback.key.clientID===CLIENTS.blue?'blue':feedback.key.clientID===CLIENTS.red?'red':undefined;
  store.event(row.id,tick,'execution_feedback',origin?.actor??'engine-observer',feedbackLabel(feedback.status),{
   schema:'replay.execution-receipt/1',version:EXECUTION_FEEDBACK_VERSION,feedback,fingerprint,commandId:origin?.commandId??null,sourceExerciseId:origin?.sourceExerciseId??null,inherited:origin?.inherited??false,
   attribution:origin?'canonical input occurrence':'unresolved: no recorded command correlation',basis:'Facts observed inside this engine execution. Admission is separate from completion; unconfirmed means no conclusive observation.'},side);
 }
 const dropped=engine.feedback.dropped(),failures=engine.feedback.observerFailures().count;
 if(dropped>runtime.dropped||failures>runtime.failures)store.event(row.id,tick,'execution_observation_notice','engine-observer','Some execution observations were unavailable',{dropped:dropped-runtime.dropped,observerFailures:failures-runtime.failures,basis:'Observer counters; no missing effect is inferred'});
 runtime.dropped=dropped;runtime.failures=failures;
}
export function pruneExecution(runtime:ExecutionRuntime|undefined,engine:ReplayEngine){
 if(!runtime)return;const needed=new Set(engine.feedback.inFlight().map(inputKeyString));for(const key of runtime.origins.keys())if(!needed.has(key))runtime.origins.delete(key);
}
