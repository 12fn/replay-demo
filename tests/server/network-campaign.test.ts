import {afterEach,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
import {networkAt} from '../../src/server/network-store';
import {exportAssessment} from '../../src/review/assessment';
import {buildDebriefContext} from '../../src/learning/debrief';import {CURRICULUM} from '../../src/server/service';

const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
async function prepared(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-network-'));clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new GameService(dir);const close=()=>s.close();clean.push(close);s.baseline=()=>{};const row=await s.create('Synthetic objective fixture','world',undefined,'crosscurrent-network/1');return{s,row,w:s.world(row.id),close};}
it('commits point accounting with turns, hides future tallies on rewind and preserves branch/restart provenance',async()=>{
 const {s,row,w,close}=await prepared();while(w.engine.game.ticks()<600)s.tick(w);expect(w.row.status).toBe('running');expect(w.campaign?.state.scores).toEqual({blue:10,red:6});
 const source=JSON.stringify(s.record(row.id)),session={...s.defaultSession(),activeId:row.id,playbackTick:299};
 expect((await s.overview(session)).campaign?.scores).toEqual({blue:0,red:0});session.playbackTick=300;expect((await s.overview(session)).campaign?.scores).toEqual({blue:5,red:3});
 const branch=await s.branch(row.id,299,'red');const bw=s.world(branch.id);expect(bw.campaign?.state.scores).toEqual({blue:0,red:0});s.tick(bw);expect(bw.campaign?.state.scores).toEqual({blue:5,red:3});
 expect(networkAt(s.store,bw.row,bw.engine,bw.campaign)?.inherited).toBe(true);expect(JSON.stringify(s.record(row.id))).toBe(source);
 const exported=exportAssessment(s,{...s.defaultSession('instructor'),activeId:row.id});expect(exported.payload.campaign?.scores).toEqual({blue:10,red:6});
 const laterBranch=await s.branch(row.id,450,'blue');expect((await s.overview({...session,activeId:laterBranch.id,playbackTick:300})).campaign?.scores).toEqual({blue:5,red:3});
 const scores=structuredClone(w.campaign?.state),fingerprint=w.engine.state().fingerprint;close();clean.splice(clean.indexOf(close),1);const restarted=new GameService(s.dataDir);clean.push(()=>restarted.close());await restarted.init(false);restarted.baseline=()=>{};
 expect(restarted.world(row.id).campaign?.state).toEqual(scores);expect(restarted.world(row.id).engine.state().fingerprint).toBe(fingerprint);restarted.tick(restarted.world(row.id));expect(restarted.world(row.id).campaign?.state.lastAwardTick).toBe(600);
},30000);

it('rolls back turn and objective accounting together if objective event persistence fails',async()=>{
 const {s,row,w,close}=await prepared();while(w.engine.game.ticks()<299)s.tick(w);
 const event=s.store.event.bind(s.store);s.store.event=(...args)=>{if(args[2]==='objective_update'&&args[1]===300)throw new Error('Synthetic storage failure');return event(...args);};s.tick(w);
 expect(w.row.status).toBe('fault');expect(s.store.turns(row.id).at(-1)?.tick).toBe(299);const saved=JSON.parse((s.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`network-state:${row.id}`) as any).value);expect(saved.state.tick).toBe(299);expect(saved.state.scores).toEqual({blue:0,red:0});
 close();clean.splice(clean.indexOf(close),1);const restored=new GameService(s.dataDir);clean.push(()=>restored.close());await restored.init(false);expect(restored.world(row.id).campaign?.state.tick).toBe(299);
},15000);

it('exposes objective rules to the correct historical agent context without enabling inference',async()=>{
 const {s,row,w}=await prepared();while(w.engine.game.ticks()<300)s.tick(w);const historical=await s.historical(row.id,299);
 const ctx=s.agentContext({...w,engine:historical},'blue','staff');expect(ctx.objectives?.()?.scores).toEqual({blue:0,red:0});expect(ctx.objectives?.()?.rules.id).toBe('stations-and-reserves/1');expect(s.ledger.summary().requestsUsed).toBe(0);
 const session={...s.defaultSession(),activeId:row.id},snapshot=await s.overview(session);while(w.engine.game.ticks()<600)s.tick(w);
 s.command(row.id,'blue',{type:'attack',targetID:null,troops:10},'old-objective-snapshot',session.identity,'human',{observationReceipt:snapshot.observationReceipt});s.tick(w);
 const command=s.store.events(row.id).find(e=>e.kind==='command')!;expect(command.details.objectiveContext.scores).toEqual({blue:5,red:3});expect(command.details.objectiveContext.tick).toBe(300);
 const debrief=buildDebriefContext(s.learningRecord(row.id),command.id,CURRICULUM);expect(debrief.availableThenIds).toContain(command.id+':objectives');expect(debrief.references.find(r=>r.id===command.id+':objectives')?.content).toContain('"blue":5');
},15000);
