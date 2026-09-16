/** Objectives prototype characterization. Accelerated, scripted and synthetic; no engagement claim. */
import fs from 'node:fs';import assert from 'node:assert/strict';
import {ReplayEngine,CLIENTS} from '../src/engine/engine';
import {advanceNetwork,createNetworkLayout,initialNetwork,networkOutcome,NETWORK_RULES} from '../src/campaign/network';
import {rawStep} from './qualify-pacing';import {runMatchup,type Matchup} from './qualify-maneuver';
import {GameService} from '../src/server/service';import os from 'node:os';import path from 'node:path';

const output='evidence/campaign/network-characterization.json';if(fs.existsSync(output))throw new Error('Preserve the previous characterization; choose a new artifact revision');
const results=[];
for(const matchup of ['legacy-vs-legacy','legacy-vs-maneuver','maneuver-vs-maneuver'] as Matchup[]){
 const source=await runMatchup('world-500',matchup,{deployment:'sea-separated',simulationId:'NETW0001',capTicks:NETWORK_RULES.limitTicks});
 const engine=await ReplayEngine.create(source.record.options),layout=createNetworkLayout(engine),updates:any[]=[],matches:any[]=[];let state=initialNetwork(1);
 for(const turn of source.record.turns){rawStep(engine,turn.intents.map(intent=>({side:intent.clientID===CLIENTS.blue?'blue':'red',intent})));const tick=engine.game.ticks();
  if(tick>1){const a=advanceNetwork(engine,layout,state);state=a.state;if(a.changed)updates.push({tick,scores:state.scores,controllers:state.controllers,priorityId:state.priorityId,award:a.award,fingerprint:engine.state().fingerprint});}
  if(source.record.fingerprints[tick]){const actual=engine.state().fingerprint;assert.equal(actual,source.record.fingerprints[tick]);matches.push({tick,fingerprint:actual});}
 }
 const result={matchup,sourceControllers:source.controllers,automated:true,humanPlaytest:false,rules:NETWORK_RULES,layout,simulatedMinutes:state.tick/600,outcome:networkOutcome(state,{blue:engine.player('blue').isAlive(),red:engine.player('red').isAlive()}),tallies:updates.filter(x=>x.award).length,controlOrPriorityChanges:updates.filter(x=>!x.award).length,updates,engineMatches:matches};results.push(result);
 console.log(JSON.stringify({matchup,simulatedMinutes:result.simulatedMinutes,outcome:result.outcome,tallies:result.tallies,controlOrPriorityChanges:result.controlOrPriorityChanges,matched:matches.length}));
}
// A paired counterfactual at the same source tick changes only a legal commitment. Neither is a human judgment.
// The earlier legacy-controller pair was already below the reserve threshold (failed log retained).
// Use a declared passive source to isolate this choice, without unrecorded resource mutations.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-objective-pair-')),service=new GameService(dir);service.baseline=()=>{};
const row=await service.create('Synthetic passive paired practice','world',undefined,'crosscurrent-network/1'),world=service.world(row.id);
while(world.engine.game.ticks()<298)service.tick(world);const original={record:service.record(row.id)};service.close();fs.rmSync(dir,{recursive:true,force:true});
const alternatives=[];
for(const share of [.1,.98]){
 const e=await ReplayEngine.restore(original.record,298,'checkpoints'),layout=createNetworkLayout(e);let state=initialNetwork(298);
 rawStep(e,[{side:'blue',intent:{type:'attack',targetID:null,troops:Math.floor(e.player('blue').troops()*share)}}]);state=advanceNetwork(e,layout,state).state;
 rawStep(e);const a=advanceNetwork(e,layout,state);alternatives.push({share,sourceTick:298,sourceFingerprint:original.record.fingerprints[298],tick:e.game.ticks(),blueReserve:a.view.reserve.blue,award:a.award,controlledStations:a.view.stations.filter(s=>s.controller==='blue').map(s=>s.id),fingerprint:e.state().fingerprint});
}
assert.deepEqual(alternatives[0].controlledStations,alternatives[1].controlledStations);assert.equal(alternatives[0].award?.blue.reserve,2);assert.equal(alternatives[1].award?.blue.reserve,0);
fs.mkdirSync('evidence/campaign',{recursive:true});fs.writeFileSync(output,JSON.stringify({at:new Date().toISOString(),schema:'replay.network-characterization/1',claim:'A first objectives prototype. Timed passive points are not engaging play. The cap is not a duration promise; outcomes and learning judgments are separate.',results,pairedPracticeSource:{controllers:'none: passive synthetic fixture',record:original.record},pairedPractice:alternatives},null,2),{flag:'wx'});
