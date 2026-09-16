import {expect,it} from 'vitest';
import {newCampaign,attachCampaignMission,completeCampaignMission,campaignProgress,stopCampaign} from '../src/campaign/session';
const start=()=>newCampaign({id:'campaign-a',name:'Synthetic campaign',ownerSubject:'learner',workroomId:'room',rules:{id:'fixture/1',targetTicks:100,maxMissions:3,scenarioIds:['one','two']}});
it('accounts for actual canonical intervals across missions, preserving source identities and no-op retries',()=>{
 const initial=start(),a={reservationKey:initial.reservation!.key,exerciseId:'first',scenarioId:'one',startTick:1,startFingerprint:'first-start'},running=attachCampaignMission(initial,a);
 expect(attachCampaignMission(running,a)).toBe(running);expect(initial.missions).toEqual([]);expect(campaignProgress(running,{exerciseId:'first',tick:31})).toMatchObject({elapsedTicks:30,remainingTicks:70});
 const end={exerciseId:'first',tick:31,fingerprint:'first-end',reason:'elimination' as const},next=completeCampaignMission(running,end);
 expect(completeCampaignMission(next,end)).toBe(next);expect(next.playedTicks).toBe(30);expect(next.reservation).toMatchObject({index:1,scenarioId:'two',remainingTicks:70});
 const b=attachCampaignMission(next,{reservationKey:next.reservation!.key,exerciseId:'second',scenarioId:'two',startTick:1,startFingerprint:'second-start'}),done=completeCampaignMission(b,{exerciseId:'second',tick:71,fingerprint:'second-end',reason:'campaign-budget'});
 expect(done).toMatchObject({status:'completed',endReason:'tick-budget',playedTicks:100,reservation:null});expect(done.missions[0]).toEqual(next.missions[0]);expect(done.missions[1].end?.elapsedTicks).toBe(70);
 expect(attachCampaignMission(done,a)).toBe(done);expect(completeCampaignMission(done,end)).toBe(done);
});
it('refuses conflicting redelivery, reused exercise identity, backwards time and unrecorded excess time',()=>{
 const s=start(),a={reservationKey:s.reservation!.key,exerciseId:'first',scenarioId:'one',startTick:1,startFingerprint:'start'},r=attachCampaignMission(s,a);
 expect(()=>attachCampaignMission(r,{...a,startFingerprint:'changed'})).toThrow(/Conflicting/);
 expect(()=>completeCampaignMission(r,{exerciseId:'other',tick:2,fingerprint:'end',reason:'elimination'})).toThrow(/canonical/);
 expect(()=>completeCampaignMission(r,{exerciseId:'first',tick:0,fingerprint:'end',reason:'elimination'})).toThrow(/canonical/);
 expect(()=>completeCampaignMission(r,{exerciseId:'first',tick:102,fingerprint:'end',reason:'time-limit'})).toThrow(/exceeded/);
 const end={exerciseId:'first',tick:21,fingerprint:'end',reason:'elimination' as const},n=completeCampaignMission(r,end);
 expect(()=>completeCampaignMission(n,{...end,fingerprint:'changed'})).toThrow(/Conflicting/);
 expect(()=>attachCampaignMission(n,{...a,reservationKey:n.reservation!.key,scenarioId:'two'})).toThrow(/twice/);
 expect(()=>campaignProgress(r,{exerciseId:'first',tick:-1})).toThrow(/tick/);
});
it('discloses the mission cap as early completion and does not count stopped/faulted time',()=>{
 let s=start();for(let i=0;i<3;i++){const res=s.reservation!;s=attachCampaignMission(s,{reservationKey:res.key,scenarioId:res.scenarioId,exerciseId:`e${i}`,startTick:1,startFingerprint:`start${i}`});s=completeCampaignMission(s,{exerciseId:`e${i}`,tick:2,fingerprint:`end${i}`,reason:'elimination'});}
 expect(s).toMatchObject({status:'completed',playedTicks:3,endReason:'mission-limit'});const stopped=stopCampaign(start());expect(stopped).toMatchObject({status:'stopped',playedTicks:0,reservation:null});expect(stopCampaign(stopped)).toBe(stopped);
 const fault=stopCampaign(start(),true);expect(fault).toMatchObject({status:'fault',endReason:'fault',playedTicks:0});
 expect(()=>attachCampaignMission(fault,{reservationKey:'campaign-a:mission:0',exerciseId:'late',scenarioId:'one',startTick:1,startFingerprint:'late'})).toThrow(/reservation/);
});
