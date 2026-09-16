import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../src/server/service';import {CampaignStore} from '../src/server/campaign-store';
import {CampaignCoordinator,type CampaignMissionFactory} from '../src/server/campaign-coordinator';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-coordinator-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const service=new GameService(dir);cleanup.push(()=>service.close());const repo=new CampaignStore(service.store);
 const scope={ownerSubject:'demo-commander',workroomId:'room'};const state=repo.create({id:'c',name:'Test',...scope,rules:{id:'test',targetTicks:100,maxMissions:2,scenarioIds:['crosscurrent-classic/1']}});
 let creations=0,checks=0,allowed=true;
 const authority={check:async()=>{checks++;if(!allowed)throw new Error('Native write revoked');}};
 // Fixture adapter only: production factory must write metadata atomically at creation.
 const factory:CampaignMissionFactory={create:async(s,r,a)=>{await a.check(scope);creations++;const row=await service.create('Test mission','world',service.defaultSession().identity,r.scenarioId);Object.assign(row.options,{campaignId:s.id,campaignReservation:r.key,workroomId:scope.workroomId});service.store.putExercise(row);return row;}};
 return{service,repo,scope,state,authority,factory,stats:()=>({creations,checks}),revoke:()=>{allowed=false;}};
}
it('starts paused after restart, shares concurrent advancement, and recovers a committed mission without creating another',async()=>{
 const f=fixture(),first=new CampaignCoordinator(f.repo,f.factory);expect((await first.advance('c',f.scope)).missions).toHaveLength(0);expect(f.stats().creations).toBe(0);
 const interrupted:CampaignMissionFactory={create:async(...args)=>{await f.factory.create(...args);throw new Error('Connection lost after commit');}};
 const c=new CampaignCoordinator(f.repo,interrupted);await c.resume('c',f.scope,f.authority);
 const [a,b]=await Promise.all([c.advance('c',f.scope),c.advance('c',f.scope)]);expect(a).toEqual(b);expect(a.missions).toHaveLength(1);expect(f.stats().creations).toBe(1);
 const restarted=new CampaignCoordinator(f.repo,f.factory);expect(restarted.enabled('c')).toBe(false);expect(await restarted.advance('c',f.scope)).toEqual(a);
 expect(()=>restarted.advance('c',{...f.scope,ownerSubject:'other'})).toThrow(/scope/);
});
it('pauses on revoked authority and leaves a created but unattached mission recoverable',async()=>{
 const f=fixture(),factory:CampaignMissionFactory={create:async(...args)=>{const row=await f.factory.create(...args);f.revoke();return row;}},c=new CampaignCoordinator(f.repo,factory);
 await expect(c.resume('c',f.scope,f.authority)).rejects.toThrow(/revoked/);expect(c.enabled('c')).toBe(false);expect(f.repo.load('c',f.scope).missions).toHaveLength(0);expect(f.repo.pendingExercise('c',f.scope)).not.toBeNull();
 await expect(c.resume('c',f.scope,f.authority)).rejects.toThrow(/revoked/);expect(f.stats().creations).toBe(1);
});
it('a pause during async preparation invalidates its authority capability before commit',async()=>{
 const f=fixture();let started!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 const factory:CampaignMissionFactory={create:async(s,r,a)=>{started();await wait;return f.factory.create(s,r,a);}},c=new CampaignCoordinator(f.repo,factory);
 const pending=c.resume('c',f.scope,f.authority);await ready;c.pause('c');release();await expect(pending).rejects.toThrow(/paused/);expect(f.stats().creations).toBe(0);expect(f.repo.pendingExercise('c',f.scope)).toBeNull();
});
