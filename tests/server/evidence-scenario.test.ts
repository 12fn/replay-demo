import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';
import {recordedScenario,selectScenario} from '../../src/scenarios/catalog';
const services:GameService[]=[];const dirs:string[]=[];
afterEach(()=>{services.splice(0).forEach(s=>s.close());dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true}));});
function open(dir?:string){if(!dir){dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-packet-'));dirs.push(dir);}const s=new GameService(dir);services.push(s);return s;}
function advance(s:GameService,id:string,tick:number){const w=s.world(id);while(w.engine.game.ticks()<tick){s.tick(w);if(w.row.status!=='running')throw new Error('Unexpected exercise end '+w.row.status);}}
async function setup(){const s=open();s.baseline=()=>{};const identity=s.defaultSession().identity;const row=await s.create('Fictional evidence qualification','world',identity,'crosscurrent-evidence/1');return{s,row,identity};}
describe('continuous changing-evidence scenario',()=>{
 it('releases exactly once, scopes both sides, permits citations and reconstructs source status at a past tick',async()=>{
  const {s,row,identity}=await setup();const id=row.id;
  expect(s.store.reports(id)).toHaveLength(2);
  const watch=s.createTask(id,identity,'Monitor report provenance','blue');
  advance(s,id,300);expect(s.store.reports(id)).toHaveLength(5);
  const before=s.store.reports(id,300);const original=before.find(r=>r.packet.reportId==='blue-r02');
  expect(original.evidenceStatus).toBe('current');
  advance(s,id,900);expect(s.store.reports(id)).toHaveLength(12);
  const after=s.store.reports(id),copy=after.find(r=>r.packet.reportId==='blue-r03');
  expect(copy.evidenceStatus).toBe('superseded');
  expect(after.find(r=>r.packet.reportId==='blue-r05').evidenceStatus).toBe('disputed');
  expect(s.store.reports(id,300)).toEqual(before);
  const ov=await s.overview({...s.defaultSession(),activeId:id,playbackTick:300});
  expect(ov.reports.every(r=>r.side==='blue'&&r.tick<=300)).toBe(true);
  expect(ov.reports.find(r=>r.id===original.id).evidenceStatus).toBe('current');
  expect(ov.sourceDesk?.focus).toBeTruthy();
  expect(()=>s.command(id,'blue',{type:'attack',targetID:null,troops:10},'packet-citation',identity,'human',{sourceIds:[original.id],rationale:'A dated claim; inspect its correction.'})).not.toThrow();
  const red=after.find(r=>r.side==='red');
  expect(()=>s.command(id,'blue',{type:'attack',targetID:null,troops:10},'cross-side',identity,'human',{sourceIds:[red.id]})).toThrow();
  const n=after.length;s.injectReport(id);expect(s.store.reports(id)).toHaveLength(n);
  expect(s.store.tasks(id).find(t=>t.id===watch.id).lastResult).toContain('authored scenario claims');
  expect(s.ledger.summary().requestsUsed).toBe(0);
 });
 it('remaps inherited links, releases later branch reports and restores without duplicating or changing the parent',async()=>{
  let {s,row,identity}=await setup();advance(s,row.id,600);
  const parentReports=s.store.reports(row.id),parentHash=s.world(row.id).engine.state().fingerprint;
  const branch=await s.branch(row.id,300,'blue',identity);advance(s,branch.id,1200);
  const reports=s.store.reports(branch.id),ids=new Set(reports.map(r=>r.id));
  expect(reports).toHaveLength(15);
  for(const r of reports){expect(ids.has(r.packet.lineageRootId)).toBe(true);for(const link of r.packet.links)expect(ids.has(link.reportId)).toBe(true);}
  expect(reports.find(r=>r.packet.reportId==='blue-r03').evidenceStatus).toBe('superseded');
  expect(s.store.reports(row.id)).toEqual(parentReports);expect(s.world(row.id).engine.state().fingerprint).toBe(parentHash);
  const dir=s.dataDir;s.close();services.splice(services.indexOf(s),1);s=open(dir);await s.init(false);
  expect(s.store.reports(branch.id)).toEqual(reports);s.injectReport(branch.id);expect(s.store.reports(branch.id)).toEqual(reports);
  expect(s.store.events(branch.id).filter(e=>e.kind==='report')).toHaveLength(10);
  expect(s.ledger.summary().requestsUsed).toBe(0);
 });
 it('rejects a recorded packet-version mismatch and leaves the classic scenario untagged',()=>{
  const scenario=selectScenario('crosscurrent-evidence/1');expect(()=>recordedScenario({map:scenario.map,scenario:{...scenario,evidencePacketId:'unknown/9'}})).toThrow();
  expect(selectScenario('crosscurrent-classic/1').evidencePacketId).toBeUndefined();
 });
});
