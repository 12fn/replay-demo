/** New native original/branch option persistence and old-record preservation; no inference. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
import {ReplayEngine,TRANSPORT_ADMISSION} from '../../src/engine/engine';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version));
const artifact=`evidence/platform/transport-release-${version}-${randomUUID()}.json`;
const proof:any={startedAt:new Date().toISOString(),version,status:'started',automated:true,newModelCalls:0,created:[],cleanup:[]};
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const nativeFetch=globalThis.fetch;
const active=AbortSignal.timeout(60000);let cleaning=false;
globalThis.fetch=(input,init)=>nativeFetch(input,{...init,signal:AbortSignal.any([AbortSignal.timeout(15000),...(cleaning?[]:[active]),...(init?.signal?[init.signal]:[])]),redirect:'error'});
let c:Awaited<ReturnType<typeof nativeAppClient>>|undefined;
const j=async(p:string,b?:unknown)=>(await c!.request(p,b)).json() as Promise<any>;
let budget:any;
try{
 c=await nativeAppClient();const build=await j('/replay-build.json');assert.equal(build.version,version);proof.sourceSha256=build.sourceArchive.sha256;
 budget=(await j('/api/agents/tools')).budget;
 const oldId='70d107e2-f0e3-414c-bdc8-33e2cc6a9852';
 const old=await j(`/api/record/${oldId}`);assert.equal(old.options.transportAdmission,undefined);proof.oldRecordSha256=sha(old);
 const original=await j('/api/exercises',{name:`Automated transport option qualification ${version}`,scenarioId:'crosscurrent-objectives/1'});
 proof.created.push(original.id);assert.equal(original.options.transportAdmission,TRANSPORT_ADMISSION);assert.equal(original.agentEnabled,false);
 const originalRecord=await j(`/api/record/${original.id}`);assert.equal(originalRecord.options.transportAdmission,TRANSPORT_ADMISSION);
 const tick=originalRecord.turns.length;const restored=await ReplayEngine.restore(originalRecord,tick,'every-tick');
 proof.original={id:original.id,tick,option:restored.options.transportAdmission,fingerprint:restored.state().fingerprint};
 assert.equal(restored.options.transportAdmission,TRANSPORT_ADMISSION);
 const branch=await j('/api/branches',{tick,side:'blue'});proof.created.push(branch.id);
 assert.equal(branch.parentId,original.id);assert.equal(branch.options.transportAdmission,TRANSPORT_ADMISSION);assert.equal(branch.agentEnabled,false);
 const branchRecord=await j(`/api/record/${branch.id}`);assert.equal(branchRecord.options.transportAdmission,TRANSPORT_ADMISSION);
 const restoredBranch=await ReplayEngine.restore(branchRecord,branchRecord.turns.length,'every-tick');
 proof.branch={id:branch.id,parentId:original.id,forkTick:tick,option:restoredBranch.options.transportAdmission};
 assert.equal(sha(await j(`/api/record/${oldId}`)),proof.oldRecordSha256);proof.oldRecordUnchanged=true;
 proof.status='qualified';
}catch(e){proof.status='failed';proof.failure=e instanceof Error?e.message:'unknown';process.exitCode=1;}
finally{
 cleaning=true;
 if(c){
  for(const id of [...proof.created].reverse())try{await j('/api/select',{exerciseId:id});const row=await j(`/api/exercises/${id}/finish`,{});assert.equal(row.status,'completed');proof.cleanup.push({id,ended:true});}catch{proof.cleanup.push({id,ended:false});process.exitCode=1;}
  try{const after=(await j('/api/agents/tools')).budget;assert.equal(after.requestsUsed,budget.requestsUsed);assert.equal(after.committedUsd,budget.committedUsd);proof.budget=after;proof.newModelCalls=after.requestsUsed-budget.requestsUsed;}catch{proof.budgetCheckFailed=true;process.exitCode=1;}
  try{await c.close();proof.loggedOut=true;}catch{proof.loggedOut=false;process.exitCode=1;}
 }
 globalThis.fetch=nativeFetch;
 if(process.exitCode)proof.status='failed';proof.finishedAt=new Date().toISOString();
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({artifact,...proof}));
}
