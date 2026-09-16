/** Read-only qualification of retained actual native decisions. No model calls or new exercises. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version));
const effects=process.argv[3]==='effects';
const output=`evidence/platform/decision-perspective-${effects?'effects-':''}${version}.json`;assert(!fs.existsSync(output),'Preserve existing qualification');
const client=await nativeAppClient();const j=async(p:string,b?:unknown)=>(await client.request(p,b)).json() as Promise<any>;
try{
 const build=await j('/replay-build.json');assert.equal(build.version,version);const overview=await j('/api/overview');const before=(await j('/api/agents/tools')).budget;
 const checks:any[]=[];
 for(const exercise of (effects?[...overview.exercises].reverse():overview.exercises)){
  assert.equal(exercise.status,'completed','Read-only proof requires ended records');await j('/api/select',{exerciseId:exercise.id});await j('/api/replay',{tick:null});
  const bundle=await j('/api/review/export.json'),events=bundle.payload.events;
  const command=events.find((e:any)=>e.kind==='command'&&e.details.commandId&&(effects?events.some((f:any)=>f.kind==='execution_feedback'&&f.details.commandId===e.details.commandId):e.details.origin==='luna'&&events.some((tool:any)=>tool.kind==='tool_result'&&tool.details.tool==='submit_order'&&tool.details.output?.id===e.details.commandId)));
  if(!command)continue;
  const cutoffTick=bundle.payload.engine.tick;
  const query=new URLSearchParams({exerciseId:exercise.id,eventId:command.id,side:command.side,cutoffTick:String(cutoffTick)});
  const trace=await j('/api/review/decision-trace?'+query);assert.equal(trace.command.value.commandId,command.details.commandId);
  if(effects){assert.equal(trace.execution.status,'recorded');for(const effect of trace.execution.value){const row=events.find((e:any)=>e.id===effect.eventId);assert.equal(row.details.commandId,command.details.commandId);assert.equal(effect.status,row.details.feedback.status);}}
  else{assert.equal(trace.submission.status,'recorded');assert.equal(trace.model.status,'recorded');
  const tool=events.find((e:any)=>e.id===trace.submission.value.eventId);assert.equal(tool.details.receiptId,trace.model.value.receipt.id);
  const model=events.find((e:any)=>e.id===trace.model.value.eventId);assert.equal(model.details.receipt.id,tool.details.receiptId);assert.equal(trace.model.value.externalSummary,model.summary.slice(0,2000));
  if(model.details.observation?.tick!==undefined){assert.equal(trace.observation.status,'recorded');assert.equal(trace.observation.value.tick,model.details.observation.tick);assert.equal(trace.observation.value.fingerprint,model.details.observation.fingerprint);}}
  assert(trace.sources.every((s:any)=>!s.report||s.report.releaseTick<=cutoffTick));assert(!JSON.stringify(trace).includes('providerDiagnostics'));
  await j('/api/replay',{tick:Math.max(1,command.tick-1)});
  const hidden=await j('/api/review/decision-trace?'+new URLSearchParams({exerciseId:exercise.id,eventId:command.id,side:command.side,cutoffTick:String(Math.max(1,command.tick-1))}));assert.equal(hidden.command.status,'unavailable');
  await j('/api/replay',{tick:null});const unchanged=await j('/api/review/export.json');assert.equal(unchanged.payload.engine.fingerprint,bundle.payload.engine.fingerprint);
  checks.push({exerciseId:exercise.id,eventId:command.id,commandId:command.details.commandId,side:command.side,cutoffTick,fingerprint:bundle.payload.engine.fingerprint,trace,selectionBeforeCommand:'unavailable',sourceFingerprintUnchanged:true});
  if(checks.length===2)break;
 }
 assert(checks.length>=1,'At least one actual retained order must join');
 const after=(await j('/api/agents/tools')).budget;assert.deepEqual(after,before);
 const proof={at:new Date().toISOString(),version,mode:effects?'automated native API qualification over retained measured execution feedback':'automated native API qualification over retained actual model decisions',checks,budget:after,newPaidRequests:0,newExercises:0,humanValidation:false};fs.writeFileSync(output,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({output,qualified:checks.map(c=>({exerciseId:c.exerciseId,eventId:c.eventId,observation:c.trace.observation.status,receiptId:c.trace.model.value?.receipt.id??null,execution:c.trace.execution.status})),newPaidRequests:0}));
}finally{await client.close();}
