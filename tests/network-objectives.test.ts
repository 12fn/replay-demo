import {expect,it} from 'vitest';
import {ReplayEngine} from '../src/engine/engine';
import {rawStep,spawnTarget} from '../scripts/qualify-pacing';
import {advanceNetwork,createNetworkLayout,initialNetwork,networkOutcome,priorityAt,NETWORK_RULES} from '../src/campaign/network';

it('scores actual controlled station footprints and the reserve tradeoff, with no duplicate award',async()=>{
 const e=await ReplayEngine.create({map:'world-500',simulationId:'OBJV0001'}),layout=createNetworkLayout(e);
 e.step([{side:'blue',intent:{type:'spawn',tile:spawnTarget(e.game,.19,.27)}},{side:'red',intent:{type:'spawn',tile:spawnTarget(e.game,.72,.34)}}]);
 let state=initialNetwork(e.game.ticks()),last:ReturnType<typeof advanceNetwork>;
 while(e.game.ticks()<600){const orders=e.game.ticks()===598?[{side:'blue' as const,intent:{type:'attack',targetID:null,troops:Math.floor(e.player('blue').troops()*.98)}}]:[];rawStep(e,orders);last=advanceNetwork(e,layout,state);state=last.state;
  if(e.game.ticks()===300){expect(last.view.stations.find(s=>s.id==='aster')?.controller).toBe('blue');expect(last.view.stations.find(s=>s.id==='delta')?.controller).toBe('red');expect(last.award?.blue).toEqual({stations:1,priority:2,reserve:2,total:5});expect(last.award?.red.total).toBe(3);}
 }
 expect(last!.award?.blue.reserve).toBe(0);expect(last!.view.reserve.blue.eligible).toBe(false);expect(last!.award?.red.reserve).toBe(2);
 expect(()=>advanceNetwork(e,layout,state)).toThrow('contiguous');
});

it('declares exact priority boundaries and keeps elimination ahead of the score cap',()=>{
 expect(priorityAt(1800)).toBe('aster');expect(priorityAt(1801)).toBe('beacon');expect(priorityAt(9001)).toBe('aster');
 const state={...initialNetwork(NETWORK_RULES.limitTicks-1),scores:{blue:100,red:2}};
 expect(networkOutcome(state,{blue:true,red:true})).toBeNull();expect(networkOutcome({...state,tick:12000},{blue:true,red:true})?.winner).toBe('blue');
 expect(networkOutcome(state,{blue:false,red:true})).toMatchObject({reason:'elimination',winner:'red'});
 expect(networkOutcome({...state,tick:12000,scores:{blue:2,red:2}},{blue:true,red:true})?.winner).toBe('draw');
});
