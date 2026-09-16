/** Read-only native staff history qualification; normal sign-in, no inference or exercise changes. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {nativeAppClient} from './native-app-client';
const baseline=process.argv.includes('--observe-baseline');const c=await nativeAppClient();const j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
try{
 const build=await j('/replay-build.json');const overview=await j('/api/overview');const budget=(await j('/api/agents/tools')).budget;
 let sample:any=null;
 for(const exercise of overview.exercises){
  if(exercise.status!=='completed')continue;
  await j('/api/select',{exerciseId:exercise.id});const bundle=await j('/api/review/export.json');
  const events=bundle.payload.events;
  const models=events.filter((e:any)=>e.kind==='staff_update'&&e.details.method==='model staff agent');
  for(const model of models){
   const free=events.find((e:any)=>e.kind==='staff_update'&&e.details.taskId===model.details.taskId&&e.details.method==='deterministic provenance watcher'&&e.tick>model.tick);
   if(free){const last=models.filter((e:any)=>e.details.taskId===model.details.taskId).at(-1);sample={exerciseId:exercise.id,taskId:model.details.taskId,model,last,free,bundle,events};break;}
  }
  if(sample)break;
 }
 assert(sample,'No native retained model/free-update fixture available; do not synthesize paid evidence');
 const {exerciseId,taskId,model,last,free,bundle,events}=sample;
 await j('/api/replay',{tick:null});
 const live=await j(`/api/agents/tasks/${taskId}`);
 const liveMatched=live.task.modelResult?.eventId===last.id&&live.task.modelResult?.text===last.summary;
 await j('/api/replay',{tick:model.tick-1});
 const historic=await j(`/api/agents/tasks/${taskId}`);
 const expected=events.filter((e:any)=>e.kind==='staff_update'&&e.details.taskId===taskId&&e.details.method==='model staff agent'&&e.tick<model.tick).at(-1);
 const historicalMatched=(historic.task.modelResult?.eventId??null)===(expected?.id??null)&&historic.trace.every((e:any)=>e.tick<model.tick)&&historic.task.status==='historical';
 await j('/api/replay',{tick:free.tick});const afterFree=(await j('/api/overview')).tasks.find((t:any)=>t.id===taskId);
 const expectedAtFree=events.filter((e:any)=>e.kind==='staff_update'&&e.details.taskId===taskId&&e.details.method==='model staff agent'&&e.tick<=free.tick).at(-1);
 const retainedAfterFree=afterFree?.modelResult?.eventId===expectedAtFree?.id&&afterFree?.modelResult?.text===expectedAtFree?.summary;
 await j('/api/replay',{tick:null});const after=await j('/api/review/export.json'),budgetAfter=(await j('/api/agents/tools')).budget;
 assert.equal(after.payload.engine.fingerprint,bundle.payload.engine.fingerprint);assert.equal(budgetAfter.requestsUsed,budget.requestsUsed);
 const proof={at:new Date().toISOString(),build,baselineObservationOnly:baseline,automated:true,humanValidated:false,exerciseId,taskId,modelEventId:model.id,modelTick:model.tick,modelTextSha256:digest(model.summary),laterFreeEventId:free.id,laterFreeTick:free.tick,liveMatched,historicalMatched,retainedAfterFree,originalFingerprint:bundle.payload.engine.fingerprint,sourceRecordUnchanged:true,newPaidRequests:0,budget:budgetAfter};
 fs.writeFileSync(`evidence/poc/native-staff-retention${baseline?'-baseline':''}.json`,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
 if(!baseline){assert(liveMatched,'Latest accepted model analysis missing');assert(historicalMatched,'Historical task view includes later state');assert(retainedAfterFree,'Free update hid prior model analysis');}
}finally{await c.close();}
