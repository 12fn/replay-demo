/** Native read-only hindsight check. Keeps the selected historical map and source records unchanged. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version));const output=`evidence/platform/later-outcomes-${version}.json`;assert(!fs.existsSync(output));
const c=await nativeAppClient(),j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
try{
 const build=await j('/replay-build.json');assert.equal(build.version,version);const overview=await j('/api/overview'),budget=(await j('/api/agents/tools')).budget;
 let proof:any=null;
 for(const exercise of [...overview.exercises].reverse()){
  assert.equal(exercise.status,'completed');await j('/api/select',{exerciseId:exercise.id});await j('/api/replay',{tick:null});const bundle=await j('/api/review/export.json'),events=bundle.payload.events;
  const command=events.find((e:any)=>e.kind==='command'&&e.details.origin==='human'&&e.details.observation?.player&&events.some((f:any)=>f.kind==='execution_feedback'&&f.details.commandId===e.details.commandId&&f.tick>e.tick));if(!command)continue;
  await j('/api/replay',{tick:command.tick});const before=await j('/api/overview');
  const query=(includeLater:boolean)=>'/api/review/decision-trace?'+new URLSearchParams({exerciseId:exercise.id,eventId:command.id,side:command.side,cutoffTick:String(command.tick),includeLater:String(includeLater)});
  const asOf=await j(query(false)),later=await j(query(true)),after=await j('/api/overview');
  assert.deepEqual(later.review,{viewTick:command.tick,scope:'later-outcomes'});assert.equal(later.cutoffTick,bundle.payload.engine.tick);assert.equal(asOf.review.scope,'as-of');
  assert.equal(after.playbackTick,before.playbackTick);assert.equal(after.state.fingerprint,before.state.fingerprint);assert.equal(later.observation.value.tick,command.details.observation.tick);assert.equal(later.observation.value.knownState.self.troops,command.details.observation.player.troops);
  assert(later.execution.value.some((e:any)=>e.tick>command.tick));assert((asOf.execution.value??[]).every((e:any)=>e.tick<=command.tick));
  await j('/api/replay',{tick:null});const restored=await j('/api/review/export.json');assert.equal(restored.payload.engine.fingerprint,bundle.payload.engine.fingerprint);assert.deepEqual((await j('/api/agents/tools')).budget,budget);
  proof={at:new Date().toISOString(),version,exerciseId:exercise.id,eventId:command.id,mode:'automated native API over a retained human-browser order',viewTick:before.playbackTick,mapFingerprint:before.state.fingerprint,mapUnchanged:true,sourceFingerprint:bundle.payload.engine.fingerprint,sourceUnchanged:true,asOf,later,budget,newPaidRequests:0,newExercises:0,humanLearningValidated:false};break;
 }
 assert(proof,'Expected a retained participant snapshot with later measured feedback');fs.writeFileSync(output,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({output,exerciseId:proof.exerciseId,eventId:proof.eventId,viewTick:proof.viewTick,laterCutoff:proof.later.cutoffTick,mapUnchanged:true,newPaidRequests:0}));
}finally{await c.close();}
