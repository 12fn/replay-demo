import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GameService} from '../../src/server/service';
import {ReplayEngine} from '../../src/engine/engine';
console.debug=()=>{};
const dirs:string[]=[];const services:GameService[]=[];
function service(dir?:string){const d=dir??fs.mkdtempSync(path.join(os.tmpdir(),'replay-recovery-'));if(!dir)dirs.push(d);const s=new GameService(d);services.push(s);return s;}
function close(s:GameService){s.close();services.splice(services.indexOf(s),1);}
afterEach(()=>{for(const s of services.splice(0))s.close();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
async function prepared(){const s=service();const row=await s.create('Recovery test','plains');const w=s.world(row.id);for(let i=0;i<20;i++)s.tick(w);const identity=s.defaultSession().identity;return{s,row,w,identity};}
describe('durable exercise behavior',()=>{
 it('persists an order before execution; restart and exact retry apply it once',async()=>{
  let {s,row,w,identity}=await prepared();
  const intent={type:'attack',targetID:null,troops:Math.floor(w.engine.player('blue').troops()*.2)};
  const first=s.command(row.id,'blue',intent,'recovery-order-1',identity);
  const tick=w.engine.game.ticks(),dir=s.dataDir;close(s);s=service(dir);await s.init(false);w=s.world(row.id);
  expect(w.engine.game.ticks()).toBe(tick);expect(s.command(row.id,'blue',intent,'recovery-order-1',identity).id).toBe(first.id);
  s.tick(w);s.tick(w);
  expect(s.store.events(row.id).filter(e=>e.details.commandId===first.id&&e.kind==='command')).toHaveLength(1);
  expect(s.command(row.id,'blue',intent,'recovery-order-1',identity).status).toBe('accepted');
  const hash=w.engine.state().fingerprint;close(s);s=service(dir);await s.init(false);
  expect(s.world(row.id).engine.state().fingerprint).toBe(hash);
 });
 it('rejects reused keys with a different actor, side or payload',async()=>{
  const {s,row,w,identity}=await prepared();const intent={type:'attack',targetID:null,troops:100};
  s.command(row.id,'blue',intent,'same-retry-key',identity);
  expect(()=>s.command(row.id,'blue',{...intent,troops:200},'same-retry-key',identity)).toThrow(/different command/);
  expect(()=>s.command(row.id,'blue',intent,'same-retry-key',{...identity,subject:'another-participant'})).toThrow(/different command/);
  expect(()=>s.command(row.id,'red',intent,'same-retry-key',{...identity,role:'instructor'})).toThrow(/different command/);
  expect(s.store.pending(row.id)).toHaveLength(1);
 });
 it('resumes a durable provenance watch without duplicate updates and retains prior as-of results',async()=>{
  let {s,row,w,identity}=await prepared();const task=s.createTask(row.id,identity,'Monitor source changes','blue');
  const initialTick=w.engine.game.ticks(),initialResult=s.store.tasks(row.id)[0].lastResult;
  s.tick(w);s.injectReport(row.id);const updated=s.store.tasks(row.id)[0];expect(updated.sourceIds).toHaveLength(2);
  const dir=s.dataDir,updates=s.store.events(row.id).filter(e=>e.kind==='staff_update').length;close(s);s=service(dir);await s.init(false);s.processTasks(row.id);
  expect(s.store.events(row.id).filter(e=>e.kind==='staff_update')).toHaveLength(updates);
  const overview=await s.overview({...s.defaultSession(),activeId:row.id,playbackTick:initialTick});
  expect(overview.tasks[0].lastResult).toBe(initialResult);
  expect(overview.tasks[0].sourceIds).not.toContain(updated.sourceIds[0]);
 });
 it('forks exact state and pre-fork information; an alternate red order cannot mutate parent',async()=>{
  const {s,row,w,identity}=await prepared();const forkTick=w.engine.game.ticks();const atFork=w.engine.state().fingerprint;
  const beforeReports=s.store.reports(row.id,forkTick).map(r=>r.id);
  for(let i=0;i<10;i++)s.tick(w);s.injectReport(row.id);s.createTask(row.id,identity,'Watch reserves below 1000','blue');
  const parentFingerprint=w.engine.state().fingerprint,parentTurns=s.store.turns(row.id).length;
  const branch=await s.branch(row.id,forkTick,'red');const b=s.world(branch.id);
  expect(b.engine.state().fingerprint).toBe(atFork);expect(branch.humanSide).toBe('red');
  expect(s.store.reports(branch.id).map(r=>r.parentSourceId)).toEqual(beforeReports);expect(s.store.tasks(branch.id)).toHaveLength(0);
  expect(s.store.events(branch.id).every(e=>e.tick<=forkTick)).toBe(true);
  s.command(branch.id,'red',{type:'attack',targetID:null,troops:Math.floor(b.engine.player('red').troops()*.7)},'red-alternate-1',identity);s.tick(b);
  expect(w.engine.state().fingerprint).toBe(parentFingerprint);expect(s.store.turns(row.id)).toHaveLength(parentTurns);
  expect(b.engine.state().fingerprint).not.toBe(s.record(row.id).fingerprints[forkTick+1]);
 });
 it('blocks host actions, unowned units, impossible commitments and undelegated intelligence orders',async()=>{
  const {s,row,w,identity}=await prepared();
  expect(()=>s.command(row.id,'blue',{type:'attack',targetID:null,troops:1e12},'bad-large-order',identity)).toThrow(/available forces/);
  for(const intent of [{type:'kick_player',targetClientID:'redai001'},{type:'toggle_pause',paused:true},{type:'mark_disconnected',isDisconnected:true}])expect(()=>w.engine.validate('blue',intent)).toThrow(/host capability/);
  expect(()=>w.engine.validate('blue',{type:'delete_unit',unitId:9999})).toThrow(/owned/);
  expect(()=>s.command(row.id,'blue',{type:'attack',targetID:null,troops:10},'intel-command-1',{...identity,role:'intelligence'})).toThrow(/delegation/);
 });
 it('does not expose opponent staff records merely by seeking during live play',async()=>{
  const {s,row,w}=await prepared();const session={...s.defaultSession(),activeId:row.id,playbackTick:10};
  const live=await s.overview(session);expect(live.reports.every(r=>r.side==='blue')).toBe(true);
  w.row.status='completed';s.store.putExercise(w.row);const review=await s.overview(session);
  expect(review.reports.some(r=>r.side==='red')).toBe(true);
  await expect(s.staff(session,'Monitor the opponent','blue')).rejects.toThrow(/live exercise/);
 });
 it('lets live ticks progress while a separate reconstruction yields',async()=>{
  const {s,row,w}=await prepared();for(let i=0;i<200;i++)s.tick(w);
  const tick=w.engine.game.ticks();let advanced=false;
  setImmediate(()=>{s.tick(w);advanced=true;});
  const historic=await s.historical(row.id,200);
  expect(advanced).toBe(true);expect(w.engine.game.ticks()).toBe(tick+1);expect(historic.game.ticks()).toBe(200);
 });
});
