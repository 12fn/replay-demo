import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GameService} from '../../src/server/service';
import {buildDebriefContext} from '../../src/learning/debrief';
import {commitmentRatio} from '../../src/learning/evidence';
import {CURRICULUM} from '../../src/server/service';

const dirs:string[]=[],services:GameService[]=[];
function service(dir?:string){const d=dir??fs.mkdtempSync(path.join(os.tmpdir(),'replay-observation-'));if(!dir)dirs.push(d);const s=new GameService(d);services.push(s);return s;}
function close(s:GameService){s.close();services.splice(services.indexOf(s),1);}
afterEach(()=>{for(const s of services.splice(0))s.close();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
async function ready(){const s=service(),identity=s.defaultSession().identity,row=await s.create('Observation provenance','plains',identity),w=s.world(row.id);for(let n=0;n<20;n++)s.tick(w);const session={...s.defaultSession(),identity,activeId:row.id};return {s,row,w,identity,session};}

describe('client snapshot provenance',()=>{
  it('retains distinct client, admission and execution states through restart; excludes in-transit reports from available-then evidence',async()=>{
    let {s,row,w,identity,session}=await ready();
    const overview=await s.overview(session),observed=overview.state.players.find(p=>p.side==='blue')!;
    expect(overview.observationReceipt).toBeTruthy();
    for(let n=0;n<10;n++)s.tick(w);
    s.injectReport(row.id);
    const late=s.store.reports(row.id).filter(r=>r.side==='blue').at(-1)!;
    const intent={type:'attack',targetID:null,troops:Math.floor(observed.troops*.5)};
    const evidence={observationReceipt:overview.observationReceipt,rationale:'Keep half of the displayed forces in reserve.'};
    expect(()=>s.command(row.id,'blue',intent,'late-source',identity,'human',{...evidence,sourceIds:[late.id]})).toThrow(/available at tick/);
    const admissionTick=w.engine.game.ticks(),admissionForces=w.engine.player('blue').troops();
    expect(admissionForces).not.toBe(observed.troops);
    const accepted=s.command(row.id,'blue',intent,'snapshot-order',identity,'human',evidence),dir=s.dataDir;
    close(s);s=service(dir);await s.init(false);w=s.world(row.id);
    // Pending evidence and the signing key survive process restart. An exact retry cannot rewrite it.
    expect(s.command(row.id,'blue',intent,'snapshot-order',identity,'human').id).toBe(accepted.id);
    s.tick(w);
    const event=s.store.events(row.id).find(e=>e.details.commandId===accepted.id)!;
    expect(event.tick).toBe(admissionTick+1);
    expect(event.details).toMatchObject({observedTick:overview.state.tick,admittedTick:admissionTick,before:{troops:admissionForces},observation:{basis:'app-snapshot-returned-with-order',tick:overview.state.tick,fingerprint:overview.state.fingerprint,player:{troops:observed.troops}}});
    expect(JSON.stringify(event)).not.toContain(overview.observationReceipt!);
    expect(commitmentRatio(event)).toBeCloseTo(intent.troops/observed.troops);
    const ctx=buildDebriefContext({exercise:{id:row.id,humanSide:'blue',kind:'live'},events:s.store.events(row.id),reports:s.store.reports(row.id)},event.id,CURRICULUM);
    expect(ctx.availableThenIds).toContain(`${event.id}:observation`);
    expect(ctx.hindsightIds).toEqual(expect.arrayContaining([late.id,`${event.id}:before`]));
    expect(ctx.availableThenIds).not.toContain(late.id);
    // The original snapshot also remains verifiable after restart.
    expect(()=>s.command(row.id,'blue',{...intent,troops:1},'after-restart',identity,'human',evidence)).not.toThrow();
  });

  it('rejects forged snapshots, other participants, opposite sides and another exercise without queuing',async()=>{
    const {s,row,w,identity,session}=await ready();
    const receipt=(await s.overview(session)).observationReceipt!,intent={type:'attack',targetID:null,troops:1};
    const [body,signature]=receipt.split('.');
    const forged=JSON.parse(Buffer.from(body,'base64url').toString());forged.player.troops=1e9;
    const tampered=`${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    for(const invalid of [tampered,'junk',`${body}.AA`,`${receipt}.extra`])expect(()=>s.command(row.id,'blue',intent,'tampered',identity,'human',{observationReceipt:invalid})).toThrow(/snapshot is invalid/);
    expect(()=>s.command(row.id,'blue',intent,'wrong-subject',{...identity,subject:'another-learner'},'human',{observationReceipt:receipt})).toThrow(/another participant/);
    expect(()=>s.command(row.id,'red',intent,'wrong-side',{...identity,role:'instructor'},'human',{observationReceipt:receipt})).toThrow(/another participant/);
    const branch=await s.branch(row.id,w.engine.game.ticks(),'blue',identity);
    expect(()=>s.command(branch.id,'blue',intent,'wrong-exercise',identity,'human',{observationReceipt:receipt})).toThrow(/another participant/);
    expect(s.store.pending(row.id)).toHaveLength(0);expect(s.store.pending(branch.id)).toHaveLength(0);
  });

  it('does not mint historical receipts or backfill legacy observation claims',async()=>{
    const {s,row,w,identity,session}=await ready();
    expect((await s.overview({...session,playbackTick:10})).observationReceipt).toBeUndefined();
    const receipt=s.command(row.id,'blue',{type:'attack',targetID:null,troops:1},'legacy-client',identity);
    s.tick(w);const event=s.store.events(row.id).find(e=>e.details.commandId===receipt.id)!;
    expect(event.details.observation).toBeUndefined();expect(event.details.observationBasis).toBe('server-admission');
    const ctx=buildDebriefContext({exercise:{id:row.id,humanSide:'blue',kind:'live'},events:s.store.events(row.id),reports:[]},event.id,CURRICULUM);
    expect(ctx.references.find(r=>r.id===event.id)?.content).toContain('No client snapshot was recorded');
    expect(ctx.prompt.instructions).toContain('do not claim the participant saw that state');
  });
});
