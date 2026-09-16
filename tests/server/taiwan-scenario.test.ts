import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
import {ReplayEngine} from '../../src/engine/engine';
import {landmasses} from '../../src/agents/scripted-controller';
import {networkView,STRAIT_NETWORK_RULES,priorityAt} from '../../src/campaign/network';
import {recordedScenario,selectScenario} from '../../src/scenarios/catalog';
import {STRAIT_RED_CELL_VERSION} from '../../src/scenarios/strait-red-cell';
import {DeterministicClient} from '../../src/inference/index';

const cleanup:Array<()=>void>=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
async function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-taiwan-')),service=new GameService(dir);cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}),()=>service.close());const row=await service.create('Taiwan Strait qualification','world',undefined,'taiwan-strait/1');return{service,row,world:service.world(row.id)};}

it('uses regional terrain, distinct shores and an initially neutral Penghu objective',async()=>{
  const {row,world:w}=await setup();
  expect([w.engine.game.width(),w.engine.game.height()]).toEqual([400,400]);
  expect(row.options.map).toBe('taiwan-strait-400');
  const board=networkView(w.engine,w.campaign!.layout,w.campaign!.state);
  expect(board.rules.id).toBe('strait-stations-and-reserves/1');expect(board.priorityId).toBe('cedar');
  expect(board.stations.find(s=>s.id==='cedar')?.controller).toBeNull();
  expect(new Set(board.stations.map(s=>s.tile)).size).toBe(5);
  const components=landmasses(w.engine.game),centres=board.stations.map(s=>components.label[s.tile]);
  expect(new Set(centres).size).toBeGreaterThanOrEqual(3);
  expect(priorityAt(1801,STRAIT_NETWORK_RULES)).toBe('aster');
  expect(recordedScenario(row.options)?.redCellProfile).toBe(STRAIT_RED_CELL_VERSION);
  expect(()=>recordedScenario({...row.options,scenario:{...selectScenario('taiwan-strait/1'),redCellProfile:'forged'}})).toThrow();
});

it('retains Taiwan terrain, relay rules and Red profile through replay and branch continuation',async()=>{
  const {service:s,row,world:w}=await setup();
  while(w.engine.game.ticks()<180)s.tick(w);
  expect(w.row.status).toBe('running');
  expect(s.store.events(row.id).some(e=>e.kind==='scripted_decision')).toBe(true);
  const original=JSON.stringify(s.record(row.id));
  const restored=await ReplayEngine.restore(s.record(row.id),180,'checkpoints');
  expect(restored.state().fingerprint).toBe(w.engine.state().fingerprint);
  const branch=await s.branch(row.id,91,'blue'),b=s.world(branch.id);
  while(b.engine.game.ticks()<180)s.tick(b);
  expect(b.engine.state().fingerprint).toBe(w.engine.state().fingerprint);
  expect(b.campaign!.state).toEqual(w.campaign!.state);
  expect(branch.options.scenario.redCellProfile).toBe(STRAIT_RED_CELL_VERSION);
  expect(JSON.stringify(s.record(row.id))).toBe(original);
},30000);

it('actually supplies the specialized brief to model inference and retains its version in decisions',async()=>{
  const {service:s,world:w}=await setup();
  while(w.engine.game.ticks()<46)s.tick(w);
  const client=new DeterministicClient({respond:()=>({summary:'Hold while checking relay status.',sourceIds:[],done:true,calls:[]})});
  s.luna=client;w.row.agentEnabled=true;w.row.options.agentRunMode='single-pulse/1';await s.runOpponent(w);
  expect(w.row.agentEnabled).toBe(false);expect(w.row.options.agentRunMode).toBeUndefined();expect(s.store.exercise(w.row.id)?.agentEnabled).toBe(false);
  expect(client.history).toHaveLength(1);
  expect(client.history[0].instructions).toContain(STRAIT_RED_CELL_VERSION);
  const input=JSON.parse(client.history[0].input);
  expect(input.observation.redCell).toMatchObject({version:STRAIT_RED_CELL_VERSION,mapId:'taiwan-strait-400'});
  expect(input.observation.objectives.rules.id).toBe('strait-stations-and-reserves/1');
  const event=s.store.events(w.row.id).find(e=>e.kind==='model_decision');
  expect(event?.details.redCellProfile).toBe(STRAIT_RED_CELL_VERSION);
  expect(event?.details.observation.redCell).toEqual(input.observation.redCell);
  expect(s.ledger.summary().requestsUsed).toBe(0);
});
