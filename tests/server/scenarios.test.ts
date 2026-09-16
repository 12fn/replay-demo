import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
import {ReplayEngine} from '../../src/engine/engine';
import {recordedScenario,selectScenario} from '../../src/scenarios/catalog';
import {ownershipOptions} from '../../src/server/native-http';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function service(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-scenario-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new GameService(dir);cleanup.push(()=>s.close());return s;}

it('classic keeps legacy initial terrain, spawn and controller decisions unchanged',async()=>{
  const s=service(),row=await s.create('Classic');const w=s.world(row.id);
  const legacyOptions={...row.options};delete legacyOptions.scenario;
  const legacy=await ReplayEngine.create(legacyOptions);
  const target=(fx:number)=>{const g=legacy.game,x=Math.floor(g.width()*fx),y=Math.floor(g.height()*.34);let best=0,distance=Infinity;g.forEachTile(t=>{if(g.isLand(t)&&!g.isImpassable(t)){const d=(g.x(t)-x)**2+(g.y(t)-y)**2;if(d<distance){distance=d;best=t;}}});return best;};
  legacy.step([{side:'blue',intent:{type:'spawn',tile:target(.56)}},{side:'red',intent:{type:'spawn',tile:target(.72)}}]);
  legacy.step();s.tick(w);expect(legacy.state().fingerprint).toBe(w.engine.state().fingerprint);
  const before=JSON.stringify(row.options);delete w.row.options.scenario;s.store.putExercise(w.row);
  const old=JSON.stringify(s.record(row.id));const branch=await s.branch(row.id,1,'blue');
  expect(recordedScenario(branch.options)).toBeNull();expect(JSON.stringify(s.record(row.id))).toBe(old);
  w.row.options=JSON.parse(before);for(let i=0;i<46;i++)s.tick(w);
  expect(s.store.events(row.id).filter(e=>e.kind==='command').map(e=>e.details.origin)).toContain('deterministic-baseline');
  expect(s.store.events(row.id).some(e=>e.kind==='scripted_decision')).toBe(false);
});

it('records explicit scenario rules, keeps learning comparisons separate, and carries rules through branch and restart',async()=>{
  const s=service(),row=await s.create('Crossing','world',undefined,'crosscurrent-crossing/1');const w=s.world(row.id);
  expect(row.options.map).toBe('world-500');expect(recordedScenario(row.options)?.victory).toBe('last-side-standing/1');
  expect(ownershipOptions({mode:'local-demo',allowedOrigins:[],cookieSecure:false},s.defaultSession().identity,row).scenarioId).toBe('crosscurrent-crossing/1');
  for(let i=0;i<150;i++)s.tick(w);
  const original=JSON.stringify(s.record(row.id));const branch=await s.branch(row.id,120,'red');
  expect(branch.options.scenario).toEqual(row.options.scenario);expect(JSON.stringify(s.record(row.id))).toBe(original);
  const fp=w.engine.state().fingerprint;s.close();cleanup.pop();const restored=new GameService(s.dataDir);cleanup.push(()=>restored.close());await restored.init(false);
  expect(restored.world(row.id).engine.state().fingerprint).toBe(fp);expect(restored.world(row.id).row.options.scenario).toEqual(row.options.scenario);
  expect(restored.store.events(row.id).find(e=>e.kind==='scripted_decision')?.details.controller).toBe('maneuver/1');
});

it('rejects unknown or mismatched versioned rules instead of silently running the old baseline',async()=>{
  const s=service();await expect(s.create('No','world',undefined,'unknown/1')).rejects.toThrow('Unknown exercise scenario');
  const scenario=selectScenario('crosscurrent-maneuver/1');
  expect(()=>recordedScenario({map:'world',scenario})).toThrow('do not match');
  expect(()=>recordedScenario({map:scenario.map,scenario:{...scenario,controller:'unknown/1'}})).toThrow('do not match');
  expect(()=>recordedScenario({map:scenario.map,scenario:{...scenario,victory:'no-elimination'}})).toThrow('do not match');
  expect(()=>recordedScenario({map:scenario.map,scenario:{...scenario,spawn:{...scenario.spawn,blue:[0,0]}}})).toThrow('do not match');
  expect(recordedScenario({map:'world'})).toBeNull();
});

it('runs the new objective opponent on canonical cadence and preserves its continuation across restart and branch',async()=>{
 const s=service(),row=await s.create('Objective integration','world',undefined,'crosscurrent-objectives/1'),w=s.world(row.id);
 expect(recordedScenario(row.options)?.controller).toBe('objectives/1');
 while(w.engine.game.ticks()<151)s.tick(w);
 const decisions=s.store.events(row.id).filter(e=>e.kind==='scripted_decision');
 expect(decisions.length).toBeGreaterThan(0);expect(decisions.every(e=>e.tick%45===0&&e.details.controller==='objectives/1')).toBe(true);
 expect(s.store.events(row.id).some(e=>e.kind==='command'&&e.details.origin==='scripted-objectives')).toBe(true);
 const prefix=JSON.stringify(s.record(row.id)),branch=await s.branch(row.id,91,'blue'),b=s.world(branch.id);
 while(b.engine.game.ticks()<151)s.tick(b);
 expect(b.engine.state().fingerprint).toBe(w.engine.state().fingerprint);expect(JSON.stringify(s.record(row.id))).toBe(prefix);
 s.close();cleanup.pop();const restored=new GameService(s.dataDir);cleanup.push(()=>restored.close());await restored.init(false);
 const rw=restored.world(row.id),rb=restored.world(branch.id);while(rw.engine.game.ticks()<226){restored.tick(rw);restored.tick(rb);}
 expect(rw.engine.state().fingerprint).toBe(rb.engine.state().fingerprint);expect(restored.ledger.summary().requestsUsed).toBe(0);
},30000);
