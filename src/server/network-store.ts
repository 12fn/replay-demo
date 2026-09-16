import {isDeepStrictEqual} from 'node:util';
import {createNetworkLayout,initialNetwork,networkView,type NetworkAdvance,type NetworkState,type Station} from '../campaign/network';
import type {ReplayEngine} from '../engine/engine';
import type {Store,ExerciseRow} from './store';
export interface NetworkRuntime {layout:Station[];state:NetworkState;}
const key=(id:string)=>`network-state:${id}`;
export function newNetwork(row:ExerciseRow,engine:ReplayEngine):NetworkRuntime|undefined{
 if(row.options.scenario?.victory!=='network-score/1')return;
 const layout=createNetworkLayout(engine);row.options.networkLayout=layout;return{layout,state:initialNetwork(engine.game.ticks(),engine.options.map)};
}
/** Must run inside the canonical turn's transaction. History reads never call this. */
export function saveNetwork(store:Store,id:string,runtime:NetworkRuntime,fingerprint:string,change?:{award:NetworkAdvance['award'];inherited?:boolean}){
 store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(id),JSON.stringify({state:runtime.state,fingerprint}));
 if(change)store.event(id,runtime.state.tick,'objective_update','exercise-director',change.inherited?'Objective points inherited at the branch point':change.award?`Station tally · Blue ${runtime.state.scores.blue} / Red ${runtime.state.scores.red}`:'Station control or priority changed',{schema:'replay.objective-update/1',state:runtime.state,award:change.award,inherited:change.inherited??false,fingerprint,basis:'Deterministic game rules and canonical engine state; not a learning assessment'});
}
export function loadNetwork(store:Store,row:ExerciseRow,engine:ReplayEngine):NetworkRuntime|undefined{
 if(row.options.scenario?.victory!=='network-score/1')return;
 const layout=createNetworkLayout(engine);if(!isDeepStrictEqual(layout,row.options.networkLayout))throw new Error('Recorded station layout does not match the scenario terrain');
 const raw=store.db.prepare('SELECT value FROM settings WHERE key=?').get(key(row.id)) as {value:string}|undefined;
 if(!raw)throw new Error('Objective accounting state is missing');const saved=JSON.parse(raw.value);
 if(saved.state?.schema!=='replay.network-state/1'||saved.state.tick!==engine.game.ticks()||saved.fingerprint!==engine.state().fingerprint)throw new Error('Objective accounting is not at the recorded engine tick');
 return{layout,state:saved.state};
}
export function historicalNetworkState(store:Store,id:string,tick:number):NetworkState{
 const raw=store.db.prepare("SELECT details FROM events WHERE exercise_id=? AND kind='objective_update' AND tick<=? ORDER BY tick DESC,sequence DESC LIMIT 1").get(id,tick) as {details:string}|undefined;
 const row=store.exercise(id);
 const state=raw?JSON.parse(raw.details).state:row?.parentId&&tick<(row.forkTick??0)?historicalNetworkState(store,row.parentId,tick):initialNetwork(tick,row?.options?.map??'world');
 return{...state,tick,scores:{...state.scores},controllers:{...state.controllers}};
}
export function networkAt(store:Store,row:ExerciseRow,engine:ReplayEngine,runtime?:NetworkRuntime){
 if(!runtime)return null;const tick=engine.game.ticks(),state=tick===runtime.state.tick?runtime.state:historicalNetworkState(store,row.id,tick);
 return networkView(engine,runtime.layout,state,row.kind==='branch');
}
