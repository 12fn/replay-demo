import {expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {runMatchup,writeManeuverEvidence} from '../scripts/qualify-maneuver';
import {selectScenario} from '../src/scenarios/catalog';

it('compares the candidate connected deployment with independent reconstruction and actual activity',async()=>{
 const s=selectScenario('crosscurrent-maneuver/1');
 const r=await runMatchup(s.map,'maneuver-vs-maneuver',{deployment:'connected',simulationId:'SCNV0001'});
 expect(r.deployment).toBe('connected');expect(r.geography.landRoute).toBe('full');
 expect(r.restore.every(x=>x.matched)).toBe(true);expect(r.firstContactTick).not.toBeNull();
 expect(r.activity.red.constructionCompletions.length).toBeGreaterThan(0);expect(r.activity.red.tilesGainedFromNeutral).toBeGreaterThan(100);
 expect(r.activity.red.rejectedAtSubmission+r.activity.red.rejectedAtTick).toBe(0);
},60000);

it('refuses to destroy unreadable earlier characterization evidence',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-evidence-'));const file=path.join(dir,'history.json');
 try{fs.writeFileSync(file,'original unreadable evidence');expect(()=>writeManeuverEvidence({runs:[]},file)).toThrow('refusing to overwrite');expect(fs.readFileSync(file,'utf8')).toBe('original unreadable evidence');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
