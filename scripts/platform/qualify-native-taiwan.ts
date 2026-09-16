/** One native, authenticated Strait Red pulse, normal ledger, at most two completions. Never retries creation or inference. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeAppClient} from './native-app-client';
import {ReplayEngine} from '../../src/engine/engine';

console.debug=()=>{};
const version=process.argv[2];assert.match(version??'',/^0\.23\.\d+$/);
const runId=randomUUID(),file=`evidence/platform/native-taiwan-${version}-${runId.slice(0,8)}.json`;
const proof:any={schema:'replay.native-taiwan-proof/1',at:new Date().toISOString(),version,runId,status:'running',exerciseId:null,checks:{},failures:[]};
fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
const c=await nativeAppClient();let exerciseId:string|null=null,before:any=null;
const j=async(p:string,b?:unknown)=>(await c.request(p,b,{signal:AbortSignal.timeout(20000)})).json() as Promise<any>;
const save=()=>fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n');
try{
 const build=await j('/replay-build.json');assert.equal(build.version,version);proof.build=build;
 before=(await j('/api/agents/tools')).budget;assert(before.requestsUsed<=98);proof.budgetBefore=before;
 const old=await j('/api/overview');assert(old.exercises.every((e:any)=>e.status!=='running'&&!e.agentEnabled));
 const created=await j('/api/exercises',{name:`Taiwan Strait · Red cell qualification ${runId.slice(0,8)}`,scenarioId:'taiwan-strait/1'});
 exerciseId=created.id;assert.equal(typeof exerciseId,'string');proof.exerciseId=exerciseId;save();
 assert.equal(created.options.map,'taiwan-strait-400');assert.equal(created.options.scenario.redCellProfile,'strait-red-cell/1');
 await j('/api/select',{exerciseId});
 await j('/api/agent',{enabled:true,singlePulse:true});
 let endedPulse=false;
 for(let i=0;i<45;i++){
   await delay(2000);const o=await j('/api/overview');assert.equal(o.activeId,exerciseId);
   if(!o.exercises.find((e:any)=>e.id===exerciseId)?.agentEnabled){endedPulse=true;break;}
 }
 assert(endedPulse,'Bounded pulse did not finish within 90 seconds');
 await j(`/api/exercises/${exerciseId}/finish`,{});
 const exported=await j('/api/review/export.json'),events=exported.payload.events;
 const decisions=events.filter((e:any)=>e.kind==='model_decision');
 assert(decisions.length>=1&&decisions.length<=2,'No completed native model decision');
 assert(decisions.every((e:any)=>e.details.redCellProfile==='strait-red-cell/1'));
 const observed=decisions[0].details.observation;assert.equal(observed.redCell.mapId,'taiwan-strait-400');
 assert.equal(observed.objectives.rules.id,'strait-stations-and-reserves/1');
 proof.checks={regionalMap:true,actualModelBrief:true,boundedPulseStopped:true,decisions,
   toolResults:events.filter((e:any)=>e.kind==='tool_result'),errors:events.filter((e:any)=>e.kind==='model_error')};
 const record=await j(`/api/record/${exerciseId}`);assert.equal(record.options.map,'taiwan-strait-400');
 const restored=await ReplayEngine.restore(record,record.turns.length,'every-tick');
 proof.checks.reconstruction={turns:record.turns.length,fingerprint:restored.state().fingerprint,verification:'every-tick'};
 assert.equal(restored.state().fingerprint,exported.payload.engine.fingerprint);
 proof.status='passed';
}catch(e){proof.status='failed';proof.failures.push(e instanceof Error?e.message:'Qualification failed');}
finally{
 if(exerciseId)try{await j('/api/select',{exerciseId});await j('/api/agent',{enabled:false});const row=await j(`/api/exercises/${exerciseId}/finish`,{});assert.equal(row.agentEnabled,false);assert.equal(row.status,'completed');proof.cleanup={ended:true,paidControllerOff:true};}catch(e){proof.status='failed';proof.failures.push('Cleanup not confirmed');}
 try{const after=(await j('/api/agents/tools')).budget;proof.budgetAfter=after;proof.newPaidRequests=before?after.requestsUsed-before.requestsUsed:null;assert(before&&proof.newPaidRequests>=1&&proof.newPaidRequests<=2);assert(after.requestsUsed<=100);}catch{proof.status='failed';proof.failures.push('Budget delta not qualified');}
 try{await c.close();}catch{proof.failures.push('Logout not confirmed');proof.status='failed';}
 proof.finishedAt=new Date().toISOString();save();
}
console.log(JSON.stringify({file,status:proof.status,exerciseId,decisions:proof.checks.decisions?.length,tools:proof.checks.toolResults?.map((e:any)=>({tool:e.details.tool,output:e.details.output})),newPaidRequests:proof.newPaidRequests,cleanup:proof.cleanup,failures:proof.failures}));
if(proof.status!=='passed')process.exitCode=1;
