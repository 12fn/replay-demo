import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ReplayEngine } from '../src/engine/engine';
console.debug=()=>{};
const started=performance.now();
const original=await ReplayEngine.create();
original.step([{side:'blue',intent:{type:'spawn',tile:2525}},{side:'red',intent:{type:'spawn',tile:7575}}]);
for(let t=1;t<450;t++){
  const orders:any[]=[];
  if(t%40===5){for(const side of ['blue','red'] as const){const p=original.player(side);orders.push({side,intent:{type:'attack',targetID:null,troops:Math.floor(p.troops()*0.2)}});}}
  original.step(orders);
}
const record=original.record();
const comparisons=[];
for(const tick of [1,17,41,83,149,227,301,359,410,450]){
  const restored=await ReplayEngine.restore(record,tick);
  assert.equal(restored.state().fingerprint,record.fingerprints[tick]);
  comparisons.push({tick,match:true,fingerprint:restored.state().fingerprint});
}
const forkTick=227;
const left=await ReplayEngine.restore(record,forkTick);
const right=await ReplayEngine.restore(record,forkTick);
for(let i=0;i<70;i++){left.step();right.step();assert.equal(left.state().fingerprint,right.state().fingerprint);}
const alternate=await ReplayEngine.restore(record,forkTick);
alternate.step([{side:'red',intent:{type:'attack',targetID:null,troops:Math.floor(alternate.player('red').troops()*0.7)}}]);
for(let i=0;i<69;i++)alternate.step();
assert.notEqual(left.state().fingerprint,alternate.state().fingerprint);
assert.equal(original.state().fingerprint,record.fingerprints[450]);
assert.throws(()=>original.step([{side:'blue',intent:{type:'attack',targetID:null,troops:1e12}}]),/available forces/);
fs.mkdirSync('evidence/poc',{recursive:true});
fs.writeFileSync('evidence/poc/engine-record.json',JSON.stringify(record));
const report={stage:'engine_poc',status:'passed',engine:'OpenFront',upstreamCommit:record.upstreamCommit,simulationId:record.options.simulationId,turns:450,controllers:['scripted-human-input','deterministic-external-controller'],liveHumanUI:false,paidInference:false,comparisons,identicalContinuationTicks:70,alternateSide:'red',alternateDiverged:true,originalPreserved:true,invalidOrderRejected:true,durationMs:Math.round(performance.now()-started),finalPlayers:original.state().players};
fs.writeFileSync('evidence/poc/qualification.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
