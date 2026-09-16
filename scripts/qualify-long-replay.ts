import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ReplayEngine} from '../src/engine/engine';
console.debug=()=>{};
const turns=Number(process.env.REPLAY_SOAK_TICKS??72000);
const engine=await ReplayEngine.create({simulationId:'SOAK0001',map:'world'});
const spawn=(fraction:number)=>{let best=0,d=Infinity;for(let t=0;t<engine.game.width()*engine.game.height();t++)if(engine.game.isLand(t)&&!engine.game.isImpassable(t)){const dist=(engine.game.x(t)-engine.game.width()*fraction)**2+(engine.game.y(t)-engine.game.height()*.34)**2;if(dist<d){best=t;d=dist;}}return best;};
engine.step([{side:'blue',intent:{type:'spawn',tile:spawn(.56)}},{side:'red',intent:{type:'spawn',tile:spawn(.72)}}]);
const start=performance.now();
for(let t=1;t<turns;t++){
 const orders:any[]=[];
 if(t%400===20)for(const side of ['blue','red'] as const){const p=engine.player(side),other=engine.player(side==='blue'?'red':'blue');if(p.isAlive()&&p.troops()>100)orders.push({side,intent:{type:'attack',targetID:p.sharesBorderWith(other)&&p.canAttackPlayer(other)?other.id():null,troops:Math.floor(p.troops()*.2)}});}
 engine.step(orders);
 if(t%10000===0)console.log(JSON.stringify({tick:t,elapsedMs:Math.round(performance.now()-start)}));
}
const record=engine.record(),generationMs=performance.now()-start;
fs.mkdirSync('evidence/soak',{recursive:true});fs.writeFileSync('data/long-soak-record.json',JSON.stringify(record));
const checks=[];
for(const tick of [1,Math.floor(turns*.1),Math.floor(turns*.25),Math.floor(turns*.5),Math.floor(turns*.75),turns]){
 const t=performance.now();const restored=await ReplayEngine.restore(record,tick,'checkpoints');assert.equal(restored.state().fingerprint,record.fingerprints[tick]);checks.push({tick,ms:Math.round(performance.now()-t),matched:true});
}
const forkTick=Math.floor(turns*.25);const left=await ReplayEngine.restore(record,forkTick,'checkpoints'),right=await ReplayEngine.restore(record,forkTick,'every-tick');
for(let i=0;i<50;i++){left.step();right.step();assert.equal(left.state().fingerprint,right.state().fingerprint);}
const receipt={at:new Date().toISOString(),status:'passed',method:'Accelerated deterministic simulation, no human playtest or wall-clock uptime claim',turns,representedSimulationMinutes:turns/600,map:'world 400x200',generationMs:Math.round(generationMs),verification:'Every recorded input is executed; fast seeks compare fingerprint every 1000 ticks and at destination. One quarter-record fully verified every tick; 50 identical continuation ticks match.',checks,fullVsCheckpointContinuationTicks:50,modelRequests:0};
fs.writeFileSync('evidence/soak/long-replay.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
