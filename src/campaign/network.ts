import type {ReplayEngine,Side} from '../engine/engine';

export const NETWORK_RULES={id:'stations-and-reserves/1',limitTicks:12000,awardEveryTicks:300,priorityEveryTicks:1800,controlFraction:.6,reserveFraction:.3,stationPoints:1,priorityBonus:2,reserveBonus:2,
 stations:[{id:'aster',name:'Aster',x:.19,y:.27},{id:'beacon',name:'Beacon',x:.45,y:.24},{id:'cedar',name:'Cedar',x:.55,y:.64},{id:'delta',name:'Delta',x:.72,y:.34},{id:'ember',name:'Ember',x:.85,y:.76}]} as const;
/** Fictional relay sites on the pinned Taiwan Strait terrain; all legacy rules stay unchanged. */
export const STRAIT_NETWORK_RULES={...NETWORK_RULES,id:'strait-stations-and-reserves/1',stations:[
 {id:'cedar',name:'Penghu relay',x:.483,y:.57},
 {id:'aster',name:'Northern relay',x:.83,y:.26},
 {id:'delta',name:'Western relay',x:.335,y:.27},
 {id:'beacon',name:'Central relay',x:.65,y:.49},
 {id:'ember',name:'Southern relay',x:.66,y:.77},
]} as const;
export type NetworkRules=typeof NETWORK_RULES|typeof STRAIT_NETWORK_RULES;
export function networkRulesForMap(map:string):NetworkRules{return map==='taiwan-strait-400'?STRAIT_NETWORK_RULES:NETWORK_RULES;}
export const NETWORK_DESCRIPTION='Hold at least 60% of a station’s marked land tiles to control it. Every 30 seconds, each controlled station earns 1 point; the priority station earns 2 extra. Holding any station with at least 30% of your force capacity in reserve earns 2 more. Priority changes every 3 minutes in the displayed order. At 20 minutes, the higher point total wins; a tie is a draw. Elimination ends play earlier with the surviving side winning. Points describe game outcomes, never learning mastery.';
export interface Station {id:string;name:string;tile:number;tiles:number[];}
export interface NetworkState {schema:'replay.network-state/1';tick:number;scores:Record<Side,number>;lastAwardTick:number;controllers:Record<string,Side|null>;priorityId:string;}
export interface StationView extends Station {controller:Side|null;held:Record<Side,number>;total:number;priority:boolean;}
export interface NetworkView {rules:NetworkRules;description:string;tick:number;stations:StationView[];scores:Record<Side,number>;reserve:Record<Side,{fraction:number;eligible:boolean}>;priorityId:string;nextAwardTick:number|null;nextPriorityTick:number|null;lastAwardTick:number;inherited:boolean;}
export interface NetworkAdvance {state:NetworkState;view:NetworkView;changed:boolean;award:Record<Side,{stations:number;priority:number;reserve:number;total:number}>|null;}
const sides:Side[]=['blue','red'];
export function priorityAt(tick:number,rules:NetworkRules=NETWORK_RULES){return rules.stations[Math.floor(Math.max(0,tick-1)/rules.priorityEveryTicks)%rules.stations.length].id;}
export function createNetworkLayout(engine:ReplayEngine):Station[]{
 const g=engine.game,w=g.width(),h=g.height();return networkRulesForMap(engine.options.map).stations.map(s=>{
  let tile=-1,best=Infinity;const x=Math.floor(s.x*w),y=Math.floor(s.y*h);
  g.forEachTile(t=>{if(g.isLand(t)&&!g.isImpassable(t)){const d=(g.x(t)-x)**2+(g.y(t)-y)**2;if(d<best){best=d;tile=t;}}});
  if(tile<0)throw new Error('No passable land for an objective station');
  const tiles:number[]=[];for(let yy=Math.max(0,g.y(tile)-4);yy<=Math.min(h-1,g.y(tile)+4);yy++)for(let xx=Math.max(0,g.x(tile)-4);xx<=Math.min(w-1,g.x(tile)+4);xx++){const t=yy*w+xx;if(g.isLand(t)&&!g.isImpassable(t))tiles.push(t);}
  return{id:s.id,name:s.name,tile,tiles};
 });
}
export function initialNetwork(tick:number,map='world'):NetworkState{const rules=networkRulesForMap(map);return{schema:'replay.network-state/1',tick,scores:{blue:0,red:0},lastAwardTick:0,controllers:Object.fromEntries(rules.stations.map(s=>[s.id,null])),priorityId:priorityAt(tick,rules)};}
/** Read current possession/reserves; score is the recorded ledger and is never recomputed from future state. */
export function networkView(engine:ReplayEngine,layout:Station[],state:NetworkState,inherited=false):NetworkView{
 const rules=networkRulesForMap(engine.options.map);
 const g=engine.game,tick=g.ticks(),nextPriority=(Math.floor(Math.max(0,tick-1)/NETWORK_RULES.priorityEveryTicks)+1)*NETWORK_RULES.priorityEveryTicks+1,priorityId=priorityAt(tick,rules),ids={blue:engine.player('blue').smallID(),red:engine.player('red').smallID()};
 const stations=layout.map(s=>{const held={blue:0,red:0};for(const tile of s.tiles){const id=g.ownerID(tile);for(const side of sides)if(id===ids[side])held[side]++;}const controller=sides.find(side=>held[side]/s.tiles.length>=NETWORK_RULES.controlFraction)??null;return{...s,held,controller,total:s.tiles.length,priority:s.id===priorityId};});
 const reserve=Object.fromEntries(sides.map(side=>{const p=engine.player(side),cap=g.config().maxTroops(p),fraction=cap>0?p.troops()/cap:0;return[side,{fraction,eligible:p.isAlive()&&fraction>=NETWORK_RULES.reserveFraction&&stations.some(s=>s.controller===side)}];})) as NetworkView['reserve'];
 return{rules,description:NETWORK_DESCRIPTION,tick,stations,scores:{...state.scores},reserve,priorityId,nextAwardTick:tick>=NETWORK_RULES.limitTicks?null:(Math.floor(tick/NETWORK_RULES.awardEveryTicks)+1)*NETWORK_RULES.awardEveryTicks,nextPriorityTick:nextPriority>NETWORK_RULES.limitTicks?null:nextPriority,lastAwardTick:state.lastAwardTick,inherited};
}
/** Exactly one canonical tick at a time. Caller commits this state in the same transaction as its turn. */
export function advanceNetwork(engine:ReplayEngine,layout:Station[],previous:NetworkState):NetworkAdvance{
 const tick=engine.game.ticks();if(tick!==previous.tick+1)throw new Error('Objective accounting requires contiguous canonical ticks');
 const view=networkView(engine,layout,previous),controllers=Object.fromEntries(view.stations.map(s=>[s.id,s.controller]));
 const state:NetworkState={...previous,tick,controllers,priorityId:view.priorityId,scores:{...previous.scores}};
 let award:NetworkAdvance['award']=null;
 if(tick<=NETWORK_RULES.limitTicks&&tick%NETWORK_RULES.awardEveryTicks===0&&tick>previous.lastAwardTick){
  award={blue:{stations:0,priority:0,reserve:0,total:0},red:{stations:0,priority:0,reserve:0,total:0}};
  for(const side of sides){const owned=view.stations.filter(s=>s.controller===side),stations=owned.length*NETWORK_RULES.stationPoints,priority=owned.some(s=>s.priority)?NETWORK_RULES.priorityBonus:0,reserve=view.reserve[side].eligible?NETWORK_RULES.reserveBonus:0;award[side]={stations,priority,reserve,total:stations+priority+reserve};state.scores[side]+=award[side].total;}
  state.lastAwardTick=tick;
 }
 const changed=award!==null||view.priorityId!==previous.priorityId||view.stations.some(s=>previous.controllers[s.id]!==s.controller);
 return{state,view:{...view,scores:{...state.scores},lastAwardTick:state.lastAwardTick},changed,award};
}
export function networkOutcome(state:NetworkState,alive:Record<Side,boolean>):{reason:'elimination'|'time-limit';winner:Side|'draw';scores:Record<Side,number>}|null{
 if(!alive.blue||!alive.red)return{reason:'elimination',winner:alive.blue?'blue':alive.red?'red':'draw',scores:{...state.scores}};
 if(state.tick>=NETWORK_RULES.limitTicks)return{reason:'time-limit',winner:state.scores.blue===state.scores.red?'draw':state.scores.blue>state.scores.red?'blue':'red',scores:{...state.scores}};
 return null;
}
