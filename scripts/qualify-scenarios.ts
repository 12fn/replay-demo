/** Exact candidate deployments, separate from the legacy-position comparison. No inference. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {selectScenario} from '../src/scenarios/catalog';
import {runMatchup,summarizeRun,brief,type Matchup} from './qualify-maneuver';
export async function qualifyScenarios(){
 const runs=[];
 for(const scenarioId of ['crosscurrent-maneuver/1','crosscurrent-crossing/1']){
  const scenario=selectScenario(scenarioId),deployment=scenarioId==='crosscurrent-maneuver/1'?'connected':'sea-separated';
  for(const matchup of ['legacy-vs-legacy','maneuver-vs-legacy','legacy-vs-maneuver','maneuver-vs-maneuver'] as Matchup[]){
   const r=await runMatchup(scenario.map,matchup,{deployment,simulationId:'SCNV0001'});
   console.error(brief(r));runs.push({scenario,comparisonControllers:r.controllers,result:summarizeRun(r)});
  }
 }
 return {at:new Date().toISOString(),schema:'replay.scenario-characterization/1',automated:true,humanPlaytest:false,claim:'Exact candidate terrain/deployment/victory with controller comparisons. Simulated duration is not wall-clock load or engagement evidence.',runs};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file='evidence/pacing/scenario-characterization.json';if(fs.existsSync(file))throw new Error('Refusing to overwrite previous scenario characterization');
 const result=await qualifyScenarios();fs.writeFileSync(file,JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify({file,runs:result.runs.map(r=>({scenario:r.scenario.id,matchup:r.result.matchup,tick:r.result.eliminationTick,eliminated:r.result.eliminated,restore:r.result.restore}))}));
}
