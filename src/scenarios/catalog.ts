import {NETWORK_RULES,STRAIT_NETWORK_RULES,NETWORK_DESCRIPTION,type NetworkRules} from '../campaign/network';
import type { EngineMap, Side } from '../engine/engine';

/** Scenario rules are recorded at creation. Versioned entries must never be changed in place. */
export interface ExerciseScenario {
  schema: 'replay.scenario/1';
  id: string;
  title: string;
  description: string;
  map: EngineMap;
  spawn: Record<Side, [number, number]>;
  controller: 'legacy-baseline/1' | 'maneuver/1' | 'objectives/1';
  victory: 'last-side-standing/1'|'network-score/1';
  objectiveRules?:NetworkRules;
  redCellProfile?:'strait-red-cell/1';
  evidencePacketId?:'crosscurrent-changing-evidence/1';
  learningScenarioId: string;
  status: 'demonstration' | 'experimental';
}

export const DEFAULT_SCENARIO_ID='taiwan-strait/1';

export const SCENARIOS: readonly ExerciseScenario[] = [
  {schema:'replay.scenario/1', id:'crosscurrent-classic/1', title:'Crosscurrent · classic',
    description:'The original shared-map exercise. Red expands and contests adjacent territory. This is the scenario used in the recorded demonstration.',
    map:'world', spawn:{blue:[0.56,0.34],red:[0.72,0.34]}, controller:'legacy-baseline/1',
    victory:'last-side-standing/1',learningScenarioId:'crosscurrent',status:'demonstration'},
  {schema:'replay.scenario/1', id:'crosscurrent-maneuver/1', title:'Crosscurrent · maneuver',
    description:'An experimental opponent combines expansion, reserve management, construction and transport orders. Both sides start on connected land. Sustained human play is still being evaluated.',
    map:'world-500', spawn:{blue:[0.58,0.28],red:[0.72,0.34]},controller:'maneuver/1',
    victory:'last-side-standing/1',learningScenarioId:'crosscurrent-maneuver/1',status:'experimental'},
  {schema:'replay.scenario/1', id:'crosscurrent-crossing/1', title:'Crosscurrent · crossing',
    description:'An experimental overseas start makes transport and continued expansion consequential. The opponent uses the same player orders available to you; this is an abstract game, not a model of a real force.',
    map:'world-500', spawn:{blue:[0.19,0.27],red:[0.72,0.34]},controller:'maneuver/1',
    victory:'last-side-standing/1',learningScenarioId:'crosscurrent-crossing/1',status:'experimental'},
  {schema:'replay.scenario/1',id:'crosscurrent-network/1',title:'Crosscurrent · stations and reserves',
    description:'An objectives experiment: control five marked stations, keep reserves and adapt as the priority changes. Uses the maneuver reference opponent. The20-minute limit is a cap; elimination can end play sooner.',
    map:'world-500',spawn:{blue:[0.19,0.27],red:[0.72,0.34]},controller:'maneuver/1',victory:'network-score/1',objectiveRules:NETWORK_RULES,learningScenarioId:'crosscurrent-network/1',status:'experimental'},
  {schema:'replay.scenario/1',id:'crosscurrent-objectives/1',title:'Crosscurrent · objective-aware opponent',
    description:'The opponent allocates forces around stations, changing priority and reserve bonuses. The overseas layout is asymmetric: Red starts on the landmass containing three stations. This is a challenging experiment, not a calibrated difficulty level.',
    map:'world-500',spawn:{blue:[0.19,0.27],red:[0.72,0.34]},controller:'objectives/1',victory:'network-score/1',objectiveRules:NETWORK_RULES,learningScenarioId:'crosscurrent-objectives/1',status:'experimental'},
  {schema:'replay.scenario/1',id:'crosscurrent-evidence/1',title:'Crosscurrent · changing intelligence',
    description:'Continuous station-and-reserve play with a separate fictional source desk: corrections, conflicting accounts and repeated claims arrive over the first two minutes. These authored reports are not measured map state. Trace sources, delegate monitoring and explain what would change your assessment.',
    map:'world-500',spawn:{blue:[0.19,0.27],red:[0.72,0.34]},controller:'objectives/1',victory:'network-score/1',objectiveRules:NETWORK_RULES,evidencePacketId:'crosscurrent-changing-evidence/1',learningScenarioId:'crosscurrent-evidence/1',status:'experimental'},
  {schema:'replay.scenario/1',id:'taiwan-strait/1',title:'Taiwan Strait · relay contest',
    description:'A regional exercise on the Taiwan Strait map. Contest five fictional relay sites across mainland, island and islet terrain. The Strait Red Cell receives a dedicated maritime game brief; reserve choices and transport delays matter. Continuous play, recorded decisions and branch review.',
    map:'taiwan-strait-400',spawn:{blue:[.82,.28],red:[.28,.25]},controller:'objectives/1',victory:'network-score/1',objectiveRules:STRAIT_NETWORK_RULES,redCellProfile:'strait-red-cell/1',learningScenarioId:'taiwan-strait/1',status:'experimental'},
];

export const VICTORY_DESCRIPTION = 'The contest ends when one side has no territory remaining. The facilitator may end it earlier for review. There is no hidden protection from elimination or time-based score; game outcome is separate from learning assessment.';

export function selectScenario(id: unknown): ExerciseScenario {
  const s=SCENARIOS.find(x=>x.id===id);
  if(!s)throw new Error('Unknown exercise scenario');
  return structuredClone(s);
}

/** Validate simulation-relevant fields before running a saved scenario. Old untagged rows stay legacy. */
export function recordedScenario(options: Record<string,any>): ExerciseScenario|null {
  if(options.scenario===undefined)return null;
  const raw=options.scenario;
  if(!raw||typeof raw!=='object')throw new Error('Invalid recorded exercise scenario');
  const expected=selectScenario(raw.id);
  if(raw.schema!==expected.schema||raw.map!==expected.map||options.map!==expected.map||
     raw.redCellProfile!==expected.redCellProfile||raw.controller!==expected.controller||raw.victory!==expected.victory||raw.evidencePacketId!==expected.evidencePacketId||JSON.stringify(raw.objectiveRules)!==JSON.stringify(expected.objectiveRules)||
     (['blue','red'] as const).some(side=>!Array.isArray(raw.spawn?.[side])||raw.spawn[side].length!==2||raw.spawn[side][0]!==expected.spawn[side][0]||raw.spawn[side][1]!==expected.spawn[side][1]))throw new Error('Recorded scenario rules do not match their version');
  return structuredClone(expected);
}

export function controllerLabel(options: Record<string,any>): string {
  const controller=recordedScenario(options)?.controller;
  return controller==='objectives/1'?'Objective-aware reference opponent':controller==='maneuver/1'?'Scripted maneuver opponent':'Deterministic baseline';
}

export function victoryDescription(scenario?:ExerciseScenario|null){return scenario?.victory==='network-score/1'?NETWORK_DESCRIPTION:VICTORY_DESCRIPTION;}
