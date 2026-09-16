/** Short API qualification of human discovery; no surrogate-player or learning claim. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version));
const artifact=`evidence/poc/native-action-preview-${version}.json`;assert(!fs.existsSync(artifact));
const c=await nativeAppClient();const j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
let id:string|null=null;
try{
 const build=await j('/replay-build.json');assert.equal(build.version,version);
 await j('/api/overview');const before=(await j('/api/agents/tools')).budget;
 const created=await j('/api/exercises',{name:'Automated action discovery qualification · no player judgment',scenarioId:'crosscurrent-crossing/1'});id=created.id;
 let overview=await j('/api/overview');const deadline=Date.now()+20000;
 while(overview.state.spawning&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));overview=await j('/api/overview');}
 assert.equal(overview.state.spawning,false,'Deployment must finish within the bounded check');
 const started=performance.now();const options=await j(`/api/action-options?exerciseId=${id}`);const latency=performance.now()-started;
 assert.equal(options.exerciseId,id);assert.equal(options.side,overview.selectedSide);
 assert(options.tick>=overview.state.tick);assert(options.naval.landings.length<=5);
 assert(Object.keys(options.buildCosts).includes('Warship'));
 assert.equal((await c.requestRaw('/api/action-options?exerciseId=wrong-exercise')).status,409);
 await j('/api/replay',{tick:1,exerciseId:id});assert.equal((await c.requestRaw(`/api/action-options?exerciseId=${id}`)).status,409);
 await j('/api/replay',{tick:null,exerciseId:id});await j(`/api/exercises/${id}/finish`,{});
 assert.equal((await c.requestRaw(`/api/action-options?exerciseId=${id}`)).status,409);
 const final=await j('/api/overview'),after=(await j('/api/agents/tools')).budget;assert.equal(after.requestsUsed,before.requestsUsed);
 const proof={at:new Date().toISOString(),build,exerciseId:id,snapshot:options,latencyMs:latency,finalTick:final.state.tick,finalFingerprint:final.state.fingerprint,wrongExerciseDenied:true,frozenDenied:true,completedDenied:true,newPaidRequests:0,budget:after,automated:true,humanPlaytest:false,limitations:['Short API discovery check, not a human naval play session.','Cost and landing options are a dated sample; execution is checked again.']};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify(proof));
}finally{
 if(id){try{await j('/api/select',{exerciseId:id});await j('/api/replay',{tick:null,exerciseId:id});const o=await j('/api/overview');if(o.exercises.find((e:any)=>e.id===id)?.status==='running')await j(`/api/exercises/${id}/finish`,{});}catch{console.error('Action preview cleanup requires inspection');}}
 await c.close();
}
