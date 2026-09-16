import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GameService,type Session} from '../../src/server/service';
console.debug=()=>{};
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
async function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-team-assessment-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const service=new GameService(dir);cleanup.push(()=>service.close());await service.init(false);await service.overview(service.defaultSession()); // Explicit participant arrival releases the first-use clock.
 const commander=service.defaultSession('commander'),analyst=service.defaultSession('intelligence');
 return{service,commander,analyst};
}
describe('live team assessment projection',()=>{
 it('keeps an analyst assessment available to its commander after heavy routine traffic, without opposing-side or personal records',async()=>{
  const {service,commander,analyst}=await setup();
  const id=commander.activeId,report=service.store.reports(id)[0];
  const logged=service.assessmentLog(analyst,{exerciseId:id,text:'The current source replaces the initial estimate; this is my interpretation.',sourceIds:[report.id]});
  for(let i=0;i<150;i++)service.store.event(id,1,'noise','engine','routine');
  const red=service.store.event(id,1,'assessment_log','opponent','Other side analysis',{text:'Other side'},'red');
  service.store.db.prepare('INSERT INTO settings VALUES(?,?)').run('learning.debrief:private','{"text":"private coaching"}');
  const ov=await service.overview(commander);
  expect(ov.timeline.find(e=>e.id===logged.id)?.details).toMatchObject({author:analyst.identity.subject,timing:'contemporaneous',sourceIds:[report.id]});
  expect(ov.timeline.some(e=>e.id===red)).toBe(false);
  expect(JSON.stringify(ov.timeline)).not.toContain('private coaching');
 });
 it('hides assessments that were recorded after the displayed position even when their observed tick was earlier',async()=>{
  const {service,commander,analyst}=await setup();const w=service.world(commander.activeId);
  for(let i=0;i<4;i++)service.tick(w);
  const later=service.assessmentLog({...analyst,playbackTick:1},{exerciseId:commander.activeId,text:'A later reflection.',sourceIds:[]});
  const frozen=await service.overview({...commander,playbackTick:1});
  expect(later.timing).toBe('post-hoc');expect(frozen.timeline.some(e=>e.id===later.id)).toBe(false);
  expect((await service.overview(commander)).timeline.some(e=>e.id===later.id)).toBe(true);
 });
 it('refuses a stale assessment composer after exercise selection changes and records nothing in the new game',async()=>{
  const {service,analyst}=await setup();const other=await service.create('Other','plains');
  const changed:Session={...analyst,activeId:other.id};
  expect(()=>service.assessmentLog(changed,{exerciseId:analyst.activeId,text:'Old draft',sourceIds:[]})).toThrow(/exercise changed/);
  expect(service.store.events(other.id).some(e=>e.kind==='assessment_log')).toBe(false);
 });
});
