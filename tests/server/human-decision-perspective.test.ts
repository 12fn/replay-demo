import {afterEach,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';import {decisionTrace} from '../../src/review/decision-trace';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
it('shows the exact returned human snapshot instead of later admission totals',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'human-perspective-')),s=new GameService(dir);clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}),()=>s.close());const row=await s.create('Human perspective','plains'),w=s.world(row.id);for(let i=0;i<25;i++)s.tick(w);
 const session={...s.defaultSession('commander'),activeId:row.id};const ov=await s.overview(session),own=ov.state.players.find(p=>p.side==='blue')!;
 for(let i=0;i<10;i++)s.tick(w);
 s.command(row.id,'blue',{type:'attack',targetID:null,troops:10},'human-observed-order',session.identity,'human',{observationReceipt:ov.observationReceipt});s.tick(w);
 const events=s.store.events(row.id),command=events.find(e=>e.kind==='command'&&e.actor===session.identity.subject)!;
 const trace=decisionTrace({exerciseId:row.id,eventId:command.id,events,reports:s.store.reports(row.id),side:'blue',cutoffTick:w.engine.game.ticks()});
 expect(trace.controller).toBe('human');expect(trace.observation.value).toMatchObject({tick:ov.state.tick,fingerprint:ov.state.fingerprint,basis:'app-snapshot-returned-with-order',knownState:{self:{troops:own.troops,gold:own.gold,tiles:own.tiles,maxTroops:own.maxTroops},opponent:null}});expect(trace.command.value!.admittedTick).toBeGreaterThan(ov.state.tick);expect(trace.model.status).toBe('not-applicable');expect(JSON.stringify(trace)).not.toContain(ov.observationReceipt!);
});
