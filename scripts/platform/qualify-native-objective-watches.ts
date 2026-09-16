/** Automated native watch workflow; no paired player, fun or learning assessment. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version));
const artifact=`evidence/poc/native-objective-watches-${version}.json`;assert(!fs.existsSync(artifact));
const c=await nativeAppClient();let id:string|null=null;
const j=async(path:string,body?:unknown)=>(await c.request(path,body)).json() as Promise<any>;
const pause=()=>new Promise(resolve=>setTimeout(resolve,250));
try{
 const build=await j('/replay-build.json');assert.equal(build.version,version);
 await j('/api/overview');const before=(await j('/api/agents/tools')).budget;
 const created=await j('/api/exercises',{name:'Automated configured watch qualification · no player judgment',scenarioId:'crosscurrent-objectives/1'});id=created.id;
 let ov=await j('/api/overview');const readyBy=Date.now()+20000;
 while(ov.state.spawning&&Date.now()<readyBy){await pause();ov=await j('/api/overview');}
 assert.equal(ov.state.spawning,false);
 const blue=ov.state.players.find((p:any)=>p.side==='blue');assert(blue.alive&&blue.troops>10);
 const threshold=Math.floor(blue.troops*.8);
 const reserve=await j('/api/tasks',{title:`Watch available forces below ${threshold}`,side:'blue'});
 const objectives=await j('/api/tasks',{title:'Watch objective changes',side:'blue'});
 const sources=await j('/api/tasks',{title:'Monitor report provenance',side:'blue'});
 for(const task of [reserve,objectives,sources]){assert.equal(task.watchConfig.schema,'replay.watch-config/1');assert.equal(task.modelEnabled,false);assert(task.interpretation);}
 const unsupported=await c.requestRaw('/api/staff',{message:'Monitor everything and tell me how to win',side:'blue'});
 assert.equal(unsupported.status,422);
 ov=await j('/api/overview');const current=ov.state.players.find((p:any)=>p.side==='blue');
 const command=await j('/api/commands',{side:'blue',intent:{type:'attack',targetID:null,troops:Math.floor(current.troops*.9)},idempotencyKey:randomUUID(),observationReceipt:ov.observationReceipt,rationale:'Automated functional check: produce a real reserve-threshold crossing.'});
 const crossBy=Date.now()+10000;let crossing:any;
 do{await pause();ov=await j('/api/overview');crossing=ov.timeline.find((e:any)=>e.kind==='staff_update'&&e.details.taskId===reserve.id&&e.summary.includes('below'));}while(!crossing&&Date.now()<crossBy);
 assert(crossing,'Real commitment must produce a recorded reserve crossing');
 assert.equal(crossing.details.method,'deterministic objective watcher');assert.deepEqual(crossing.details.sourceIds,[]);
 const beforeReports=ov.timeline.filter((e:any)=>e.kind==='staff_update'&&e.details.taskId===sources.id).length;
 await j('/api/reports/inject',{});ov=await j('/api/overview');
 const reportUpdates=ov.timeline.filter((e:any)=>e.kind==='staff_update'&&e.details.taskId===sources.id);
 assert.equal(reportUpdates.length,beforeReports+1);assert(reportUpdates.at(-1).details.sourceIds.length>=2);
 await j('/api/replay',{tick:sources.createdTick,exerciseId:id});const historic=await j('/api/overview');
 const oldTask=historic.tasks.find((t:any)=>t.id===sources.id);assert.equal(oldTask.interpretation,sources.interpretation);assert.equal(oldTask.watchState,undefined);assert.equal(oldTask.lastResult,null);
 await j('/api/replay',{tick:null,exerciseId:id});await j(`/api/exercises/${id}/finish`,{});
 const final=await j('/api/overview'),after=(await j('/api/agents/tools')).budget;assert.equal(after.requestsUsed,before.requestsUsed);
 const proof={at:new Date().toISOString(),build,exerciseId:id,automated:true,humanPlaytest:false,
  taskDefinitions:[reserve,objectives,sources].map(t=>({id:t.id,createdTick:t.createdTick,watchConfig:t.watchConfig,interpretation:t.interpretation})),
  command,crossing,reportUpdate:reportUpdates.at(-1),unsupportedDenied:true,historicalConfigPreserved:true,newPaidRequests:0,budget:after,
  finalTick:final.state.tick,finalFingerprint:final.state.fingerprint,
  limitations:['Reserve/source workflow and objective-watch creation only; no native objective-controller-change assertion.','Automated functional example, not the complete shared/Tomo workflow or a fun/learning playtest.']};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{
 if(id){try{await j('/api/select',{exerciseId:id});await j('/api/replay',{tick:null,exerciseId:id});const ov=await j('/api/overview');if(ov.exercises.find((e:any)=>e.id===id)?.status==='running')await j(`/api/exercises/${id}/finish`,{});}catch{console.error('Watch qualification cleanup requires inspection');}}
 await c.close();
}
