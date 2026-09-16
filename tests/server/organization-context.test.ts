import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
import {exerciseContext,newExerciseContext} from '../../src/context/exercise-context';
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function service(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-role-context-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new GameService(dir);cleanup.push(()=>s.close());return s;}

it('binds exact presentation context to new scenarios, leaving unsupported legacy maps without it',async()=>{
  expect(newExerciseContext('constructor')).toBeNull();expect(newExerciseContext(undefined)).toBeNull();
  const s=service(),r=await s.create('Network','world',s.defaultSession().identity,'crosscurrent-objectives/1');
  expect(r.options.organizationPack).toEqual({packId:'crosscurrent-island-network',version:'1.0.0'});
  const session={...s.defaultSession(),activeId:r.id};const ov=await s.overview(session);
  expect(ov.organizationContext?.roleView.role).toBe('commander');
  expect(s.dossier(session).markdown).toContain('crosscurrent-island-network@1.0.0');
  expect(s.dossier(session).markdown).toContain('blank prompts are not learning evidence');
  const analyst={...session,identity:{...session.identity,role:'intelligence' as const}};
  expect((await s.overview(analyst)).organizationContext?.roleView.report.fields.some(f=>f.id==='currency')).toBe(true);
  expect(()=>s.command(r.id,'blue',{type:'attack',targetID:null,troops:1},'unauthorized',analyst.identity)).toThrow('Intelligence seat');
  expect(s.ledger.summary().requestsUsed).toBe(0);
});

it('preserves context through rewind, branch and restart without changing canonical state',async()=>{
  const s=service(),r=await s.create('Context replay','world',undefined,'crosscurrent-maneuver/1'),w=s.world(r.id);
  for(let i=0;i<20;i++)s.tick(w);
  const original=JSON.stringify(s.record(r.id)),fp=w.engine.state().fingerprint;
  const session={...s.defaultSession(),activeId:r.id,playbackTick:5};
  expect((await s.overview(session)).organizationContext?.packId).toBe('crosscurrent-joint-coordination');
  const branch=await s.branch(r.id,5,'red');expect(branch.options.organizationPack).toEqual(r.options.organizationPack);
  expect(JSON.stringify(s.record(r.id))).toBe(original);expect(w.engine.state().fingerprint).toBe(fp);
  s.close();cleanup.pop();const restored=new GameService(s.dataDir);cleanup.push(()=>restored.close());await restored.init(false);
  expect(restored.world(r.id).engine.state().fingerprint).toBe(fp);
  expect((await restored.overview({...session,playbackTick:null})).organizationContext?.version).toBe('1.0.0');
});

it('never backfills old records or substitutes a different retained version',async()=>{
  const s=service(),r=await s.create('Legacy');delete r.options.organizationPack;s.store.putExercise(r);
  const original=JSON.stringify(s.record(r.id));const session={...s.defaultSession(),activeId:r.id};
  expect((await s.overview(session)).organizationContext).toBeNull();
  const branch=await s.branch(r.id,1,'blue');expect(branch.options.organizationPack).toBeUndefined();
  expect(JSON.stringify(s.record(r.id))).toBe(original);
  expect(()=>exerciseContext({...r.options,organizationPack:{packId:'crosscurrent-joint-coordination',version:'latest'}},'commander')).toThrow('version');
  expect(()=>exerciseContext({...r.options,organizationPack:{packId:'crosscurrent-island-network',version:'1.0.0'}},'commander')).toThrow('does not match');
});
