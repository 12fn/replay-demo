import {afterEach,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';import {CampaignStore} from '../../src/server/campaign-store';import {stopCampaign} from '../../src/campaign/session';
const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
const scope={ownerSubject:'demo-commander',workroomId:'room-one'};
async function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-campaign-store-'));clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const service=new GameService(dir),close=()=>service.close();clean.push(close);service.baseline=()=>{};const repo=new CampaignStore(service.store),state=repo.create({id:'c1',name:'Synthetic campaign',...scope,rules:{id:'test/1',targetTicks:100,maxMissions:3,scenarioIds:['crosscurrent-classic/1']}});const row=await service.create('Reserved source','world',service.defaultSession().identity);Object.assign(row.options,{workroomId:scope.workroomId,campaignId:state.id,campaignReservation:state.reservation!.key});service.store.putExercise(row);return{service,repo,state,row,close};}
it('recovers created-but-unattached canonical missions after restart without duplicate creation, with immutable source fingerprints',async()=>{
 const {service,repo,state,row,close}=await fixture();expect(repo.pendingExercise(state.id,scope)?.id).toBe(row.id);const source=JSON.stringify(service.record(row.id));
 close();clean.splice(clean.indexOf(close),1);const restarted=new GameService(service.dataDir);clean.push(()=>restarted.close());await restarted.init(false);const r=new CampaignStore(restarted.store),recovered=r.pendingExercise(state.id,scope)!;
 const attached=r.attach(state.id,scope,state.revision,recovered.id);expect(attached.missions[0].startFingerprint).toBe(JSON.parse(source).fingerprints[1]);expect(r.attach(state.id,scope,attached.revision,row.id)).toEqual(attached);expect(r.history(state.id,scope)).toHaveLength(2);
 const world=restarted.world(row.id);while(world.engine.game.ticks()<21)restarted.tick(world);world.row.status='completed';restarted.store.putExercise(world.row);restarted.store.event(row.id,21,'exercise_ended','test-runner','Synthetic facilitator end');
 const sourceEnd=JSON.stringify(restarted.record(row.id)),ended=r.complete(state.id,scope,attached.revision,row.id);expect(ended.playedTicks).toBe(20);expect(ended.reservation?.remainingTicks).toBe(80);expect(ended.missions[0].end?.fingerprint).toBe(world.engine.state().fingerprint);
 expect(r.complete(state.id,scope,ended.revision,row.id)).toEqual(ended);expect(r.history(state.id,scope)).toHaveLength(3);expect(JSON.stringify(restarted.record(row.id))).toBe(sourceEnd);
});
it('rejects duplicate reservations, scope crossing and stale completion; a failed ledger audit rolls back its update',async()=>{
 const {service,repo,state,row}=await fixture();expect(()=>repo.load(state.id,{...scope,ownerSubject:'other'})).toThrow(/scope/);expect(()=>repo.load(state.id,{...scope,workroomId:'other'})).toThrow(/scope/);
 const clone={...row,id:'duplicate'};expect(()=>service.store.putExercise(clone)).toThrow(/UNIQUE/);
 const linked=repo.attach(state.id,scope,state.revision,row.id);expect(()=>repo.transition(state.id,scope,state.revision,'stale',s=>stopCampaign(s))).toThrow(/changed/);
 expect(()=>repo.complete(state.id,scope,linked.revision,row.id)).toThrow(/completed/);
 service.store.db.exec("CREATE TRIGGER reject_campaign_audit BEFORE INSERT ON campaign_events WHEN NEW.kind='stop-test' BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END;");
 expect(()=>repo.transition(state.id,scope,linked.revision,'stop-test',s=>stopCampaign(s))).toThrow(/Injected/);expect(repo.load(state.id,scope)).toEqual(linked);expect(repo.history(state.id,scope)).toHaveLength(2);
});
it('refuses forged ownership, branches and a completion ahead of durable history',async()=>{
 const {service,repo,state,row}=await fixture();row.options.ownerSubject='other';service.store.putExercise(row);expect(()=>repo.attach(state.id,scope,state.revision,row.id)).toThrow(/owner/);
 row.options.ownerSubject=scope.ownerSubject;row.kind='branch';service.store.putExercise(row);expect(()=>repo.attach(state.id,scope,state.revision,row.id)).toThrow(/owner/);
 row.kind='live';service.store.putExercise(row);const a=repo.attach(state.id,scope,state.revision,row.id);row.status='completed';service.store.putExercise(row);service.store.event(row.id,9,'exercise_ended','test','Uncommitted end');expect(()=>repo.complete(state.id,scope,a.revision,row.id)).toThrow(/durable/);
});
