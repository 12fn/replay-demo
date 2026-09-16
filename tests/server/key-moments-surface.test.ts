import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
async function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-moments-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const service=new GameService(dir);cleanup.push(()=>service.close());await service.init(false);await service.overview(service.defaultSession()); // Explicit participant arrival releases the first-use clock.service.baseline=()=>{};
 return {service,session:service.defaultSession('commander')};
}
describe('key moments in overview',()=>{
 it('surfaces an early own tradeoff after routine order traffic, without other-person orders or excluded record metadata',async()=>{
  const {service,session}=await setup(),id=session.activeId;
  const order=(actor:string,tick:number,amount:number,side='blue')=>service.store.event(id,tick,'command',actor,'Recorded order',{origin:'human',intent:{type:'attack',targetID:null,troops:amount},before:{troops:1000}},side);
  const early=order(session.identity.subject,1,750);
  for(let n=0;n<30;n++)order(session.identity.subject,1,10);
  const peer=order('peer',1,990),opponent=order('opponent',1,999,'red'),future=order(session.identity.subject,100,800);
  const secret=service.store.event(id,1,'model_decision','red-controller','Private controller input',{observation:'SENTINEL OPPONENT INPUT'},'red');
  const ov=await service.overview(session),text=JSON.stringify(ov.keyMoments);
  expect(ov.keyMoments.selected.some(m=>m.evidence.some(e=>e.id===early))).toBe(true);
  for(const excluded of [peer,opponent,future,secret,'SENTINEL OPPONENT INPUT'])expect(text).not.toContain(excluded);
  expect(ov.keyMoments).not.toHaveProperty('excluded');
  expect(ov.keyMoments.scope).toEqual({kind:'own',subject:session.identity.subject});
 });
 it('keeps post-hoc citations out of the sources attributed to an original reason',async()=>{
  const {service,session}=await setup(),id=session.activeId,w=service.world(id);
  const command=service.store.event(id,1,'command',session.identity.subject,'Recorded order',{origin:'human',intent:{type:'attack',targetID:null,troops:700},before:{troops:1000},rationale:'Retain some resources.',rationaleTiming:'contemporaneous',sourceIds:['original-source']},'blue');
  for(let n=0;n<4;n++)service.tick(w);
  service.store.event(id,w.engine.game.ticks(),'decision_log',session.identity.subject,'Later annotation',{commandEventId:command,text:'Later reflection.',timing:'post-hoc',sourceIds:['later-annotation-source']},'blue');
  const moment=(await service.overview(session)).keyMoments.selected.find(m=>m.evidence[0].id===command)!;
  expect(moment.reasons.join(' ')).toContain('original-source');
  expect(moment.reasons.join(' ')).not.toContain('later-annotation-source');
 });
 it('does not turn later execution feedback into evidence available at an earlier rewind position',async()=>{
  const {service,session}=await setup(),id=session.activeId,w=service.world(id);
  const command=service.store.event(id,1,'command',session.identity.subject,'Transport order',{origin:'human',commandId:'boat-command',intent:{type:'boat',target:12,troops:10},before:{troops:1000}},'blue');
  for(let n=0;n<4;n++)service.tick(w);
  const feedback=service.store.event(id,w.engine.game.ticks(),'execution_feedback',session.identity.subject,'Transport did not launch',{commandId:'boat-command',sourceExerciseId:id,feedback:{status:'transport-not-launched'}},'blue');
  const live=await service.overview(session);expect(live.keyMoments.selected.some(m=>m.evidence.some(e=>e.id===feedback))).toBe(true);
  const frozen=await service.overview({...session,playbackTick:1});
  expect(JSON.stringify(frozen.keyMoments)).not.toContain(feedback);
  expect(frozen.keyMoments.selected.some(m=>m.kind==='order-ineffective'&&m.evidence.some(e=>e.id===command))).toBe(false);
 });
});
