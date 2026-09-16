import {afterEach,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
import {orderProgress} from '../../src/review/execution';
import {recentOrders} from '../../src/agents/tools';
import {buildDebriefContext} from '../../src/learning/debrief';import {CURRICULUM} from '../../src/server/service';
import {UnitType} from '../../vendor/openfront/src/core/game/Game';
const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
async function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-exec-service-'));clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new GameService(dir),close=()=>s.close();clean.push(close);s.baseline=()=>{};const row=await s.create('Synthetic execution receipts','world',undefined,'crosscurrent-crossing/1'),w=s.world(row.id);while(w.engine.game.ticks()<10)s.tick(w);return{s,row,w,close};}
const order=(tile:number)=>({type:'build_unit',unit:UnitType.DefensePost,tile});
it('separates duplicate admission from measured effects, including side privacy, as-of views and an in-flight branch/restart',async()=>{
 const {s,row,w,close}=await fixture(),identity=s.defaultSession().identity,tile=w.engine.player('blue').spawnTile()!;
 const a=s.command(row.id,'blue',order(tile),'first',identity),b=s.command(row.id,'blue',order(tile),'second',identity);
 s.tick(w);const admitted=w.engine.game.ticks(),prefix=JSON.stringify(s.record(row.id));
 expect(orderProgress(s.store.events(row.id)).map(o=>[o.admission,o.status])).toEqual([['accepted','awaiting-observation'],['accepted','awaiting-observation']]);
 const branch=await s.branch(row.id,admitted,'red'),bw=s.world(branch.id);expect(bw.execution?.origins.size).toBe(2);
 s.tick(w);s.tick(bw);expect(w.engine.state().fingerprint).toBe(bw.engine.state().fingerprint);
 const progress=orderProgress(s.store.events(row.id));expect(progress.map(o=>[o.commandId,o.status])).toEqual([[a.id,'construction-started'],[b.id,'construction-not-started']]);
 expect(progress[0].observations[0].observed.unitId).toBe(w.engine.player('blue').units(UnitType.DefensePost)[0].id());
 expect(progress[1].observations[0].observed.affordableAtAttempt).toBe(false);
 const debrief=buildDebriefContext(s.learningRecord(row.id),progress[1].eventId,CURRICULUM);expect(debrief.prompt.input).toContain('construction-not-started');expect(debrief.hindsightIds).toContain(progress[1].observations[0].eventId);expect(debrief.prompt.input).not.toContain('construction-started');
 expect(orderProgress(s.store.events(branch.id)).every(o=>o.inherited&&o.observations.every(f=>f.inherited))).toBe(true);
 const events=s.store.events(row.id),startEvent=events.find(e=>e.kind==='execution_feedback'&&e.details.commandId===a.id)!;
 expect(startEvent.tick).toBe(startEvent.details.feedback.tick+1);expect(startEvent.details.feedback.key.intentIndex).toBe(0);
 const then=await s.historical(row.id,admitted),blueCtx=s.agentContext({...w,engine:then},'blue','staff');
 expect(recentOrders(blueCtx,12).orders.map(o=>o.status)).toEqual(['awaiting-observation','awaiting-observation']);
 expect(recentOrders(s.agentContext(w,'red','staff'),12).orders).toEqual([]);
 const hist=await s.overview({...s.defaultSession(),activeId:row.id,playbackTick:admitted});expect(hist.executionOrders.every(o=>o.observations.length===0)).toBe(true);
 expect(JSON.stringify({...s.record(row.id),turns:s.record(row.id).turns.slice(0,admitted),fingerprints:JSON.parse(prefix).fingerprints})).toBe(prefix);
 close();clean.splice(clean.indexOf(close),1);const restarted=new GameService(s.dataDir);clean.push(()=>restarted.close());await restarted.init(false);restarted.baseline=()=>{};
 const rw=restarted.world(row.id),rb=restarted.world(branch.id);expect(rw.execution?.origins.size).toBe(1);
 for(let n=0;n<65;n++){restarted.tick(rw);restarted.tick(rb);}
 expect(rw.engine.state().fingerprint).toBe(rb.engine.state().fingerprint);expect(rw.execution?.origins.size).toBe(0);
 expect(orderProgress(restarted.store.events(row.id)).map(o=>o.status)).toEqual(['construction-completed','construction-not-started']);
 const final=orderProgress(restarted.store.events(branch.id));expect(final[0].observations).toHaveLength(2);expect(final[0].observations.every(f=>f.inherited)).toBe(true);
 const secondBranch=await restarted.branch(branch.id,admitted+1,'blue');const sb=restarted.world(secondBranch.id);for(let n=0;n<65;n++)restarted.tick(sb);
 expect(orderProgress(restarted.store.events(secondBranch.id))[0].observations.at(-1)).toMatchObject({status:'construction-completed',inherited:true});
 expect(restarted.ledger.summary().requestsUsed).toBe(0);
},30000);
it('rolls back an observed effect and its canonical turn together on storage failure',async()=>{
 const {s,row,w,close}=await fixture();s.command(row.id,'blue',order(w.engine.player('blue').spawnTile()!),'fault',s.defaultSession().identity);s.tick(w);const tick=w.engine.game.ticks();
 const event=s.store.event.bind(s.store);s.store.event=(...a)=>{if(a[2]==='execution_feedback')throw new Error('Injected receipt write failure');return event(...a);};s.tick(w);
 expect(w.row.status).toBe('fault');expect(s.store.turns(row.id).at(-1)?.tick).toBe(tick);expect(s.store.events(row.id).filter(e=>e.kind==='execution_feedback')).toEqual([]);
 close();clean.splice(clean.indexOf(close),1);const restarted=new GameService(s.dataDir);clean.push(()=>restarted.close());await restarted.init(false);const rw=restarted.world(row.id);expect(rw.engine.game.ticks()).toBe(tick);expect(rw.execution?.origins.size).toBe(1);
},15000);
it('does not fabricate historical feedback when a legacy record continues',async()=>{
 const {s,row,w}=await fixture();delete row.options.executionFeedback;w.execution=undefined;s.store.putExercise(row);
 s.command(row.id,'blue',order(w.engine.player('blue').spawnTile()!),'legacy',s.defaultSession().identity);for(let n=0;n<65;n++)s.tick(w);
 expect(s.store.events(row.id).some(e=>e.kind==='execution_feedback')).toBe(false);expect(orderProgress(s.store.events(row.id))[0].status).toBe('effect-unobserved');
},15000);
it('keeps an older measured construction visible despite a burst of newer attack orders',async()=>{
 const {s,row,w}=await fixture();const a=s.command(row.id,'blue',order(w.engine.player('blue').spawnTile()!),'build',s.defaultSession().identity);
 for(let n=0;n<65;n++)s.tick(w);
 for(let n=0;n<15;n++)s.store.event(row.id,w.engine.game.ticks(),'command','test','Synthetic admitted attack',{intent:{type:'attack'},commandId:`attack-${n}`},'blue');
 expect(orderProgress(s.store.events(row.id),12).some(o=>o.commandId===a.id)).toBe(false);
 const overview=await s.overview({...s.defaultSession(),activeId:row.id});expect(overview.executionOrders.find(o=>o.commandId===a.id)?.status).toBe('construction-completed');
});
