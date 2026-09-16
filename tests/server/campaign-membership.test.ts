import {afterEach,describe,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService,type Identity} from '../../src/server/service';
import {CampaignService,type CampaignResolver} from '../../src/server/campaign-service';
import {CampaignMembershipStore,MembershipStoreError} from '../../src/server/campaign-membership-store';
import type {ParticipantAuthority,ParticipantCheck} from '../../src/server/campaign-membership-service';
import {enrollParticipant,setParticipantLimit,missionStart,type MemberIdentity} from '../../src/campaign/enrollment';
import {exerciseScope,type KamiwazaConfig} from '../../src/server/native-http';
import {Store} from '../../src/server/store';

const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
const ROOM='room';
const owner:Identity={subject:'sub-owner',name:'Owner One',role:'commander',organization:'Synthetic',mode:'kamiwaza'};
const intel:Identity={subject:'sub-intel',name:'Analyst Two',role:'intelligence',organization:'Synthetic',mode:'kamiwaza'};
const second:Identity={subject:'sub-second',name:'Commander Three',role:'commander',organization:'Synthetic',mode:'kamiwaza'};
const late:Identity={subject:'sub-late',name:'Late Four',role:'commander',organization:'Synthetic',mode:'kamiwaza'};
const RULES={id:'test/1',targetTicks:400,maxMissions:6,scenarioIds:['crosscurrent-classic/1']};
const scope={ownerSubject:owner.subject,workroomId:ROOM};
const viewer=(i:Identity)=>({ownerSubject:i.subject,workroomId:ROOM});
const fresh=(identity:Identity,workroomId:string|null=ROOM)=>({identity,workroomId});
const seat=(i:Identity):MemberIdentity=>({subject:i.subject,name:i.name,organization:i.organization,roleAtJoin:i.role,workroomId:ROOM});
const CONFIG:KamiwazaConfig={mode:'kamiwaza',apiBase:'https://platform.example/api',workroomId:ROOM,forwardedHost:'platform.example',forwardedProto:'https',allowedOrigins:[],cookieSecure:true,allowLegacyRecordings:false};

function fixture(dir?:string){
 if(!dir){dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-campaign-members-'));const d=dir;clean.push(()=>fs.rmSync(d,{recursive:true,force:true}));}
 const service=new GameService(dir);service.baseline=()=>{};const close=()=>service.close();clean.push(close);
 const campaigns=new CampaignService(service);const auth={allowed:true};
 const resolve:CampaignResolver=async()=>{if(!auth.allowed)throw new Error('Native write revoked');return {identity:owner,workroomId:ROOM};};
 const missions=()=>service.store.exercises().filter(e=>typeof e.options?.campaignId==='string');
 const finishAt=(id:string,tick:number)=>{const w=service.world(id);while(w.engine.game.ticks()<tick)service.tick(w);w.row.status='completed';w.row.kind='recorded';service.store.putExercise(w.row);service.store.event(id,w.engine.game.ticks(),'exercise_ended',owner.subject,'Exercise ended for review');return w;};
 const start=()=>campaigns.create({name:'Shared',identity:owner,workroomId:ROOM,resolve,rules:RULES});
 /** End the running mission by facilitator finish and let progression open the next one. */
 const advance=async(id:string)=>{const v=campaigns.view(id,scope);finishAt(v.activeExerciseId!,21);campaigns.view(id,scope);await campaigns.settled(id);return campaigns.view(id,scope);};
 const seats=(exerciseId:string)=>service.teams.participants(service.store.exercise(exerciseId)!);
 const activeSeats=(exerciseId:string)=>seats(exerciseId).filter(p=>p.active).map(p=>p.subject);
 const scopeFor=(i:Identity)=>exerciseScope(CONFIG,i,row=>service.teams.includes(row,i.subject));
 const join=(id:string,who:Identity)=>{const code=campaigns.members.issueCode(campaigns.owned(id,scope),fresh(owner));return campaigns.members.join(campaigns.members.lookupCode(code.code,ROOM),fresh(who));};
 return {dir,service,campaigns,auth,resolve,missions,finishAt,start,advance,seats,activeSeats,scopeFor,join,close};
}
const table=(t:Record<string,ParticipantCheck>):ParticipantAuthority=>({check:async s=>t[s]??{outcome:'unverified',detail:'not in table'}});

describe('durable membership store',()=>{
 it('compare-and-swaps on its own version, commits audit atomically, survives restart and creates owner-only records idempotently',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-membership-store-'));clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let store=new Store(path.join(dir,'t.sqlite'));clean.push(()=>store.close());
  let repo=new CampaignMembershipStore(store);
  expect(repo.load('c1')).toBeNull();expect(()=>repo.require('c1')).toThrow(MembershipStoreError);
  const m1=repo.ensure({campaignId:'c1',owner:seat(owner)});expect(m1.version).toBe(1);expect(repo.ensure({campaignId:'c1',owner:seat(intel)})).toEqual(m1);
  const m2=repo.mutate('c1',m=>enrollParticipant(m,{identity:seat(intel),actor:intel.subject,at:'2026-09-13T10:00:00.000Z',effective:missionStart(0)}));
  expect(m2.version).toBe(2);expect(repo.mutate('c1',m=>m)).toEqual(m2);
  // Stale expectation loses; the kernel no-op with a stale expectation still loses (the caller reasoned about old state).
  expect(()=>repo.mutate('c1',m=>setParticipantLimit(m,{maxParticipants:3,actor:owner.subject,at:'2026-09-13T10:01:00.000Z'}),1)).toThrow(/changed/);
  const m3=repo.mutate('c1',m=>setParticipantLimit(m,{maxParticipants:3,actor:owner.subject,at:'2026-09-13T10:01:00.000Z'}),2);
  expect(m3.maxParticipants).toBe(3);
  // A failed audit insert rolls the state back; the version is unchanged and history stays contiguous.
  store.db.exec("CREATE TRIGGER reject_membership_audit BEFORE INSERT ON campaign_membership_events WHEN NEW.kind='revoked' BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END;");
  expect(()=>repo.mutate('c1',m=>({...m,version:m.version+1,members:m.members.map(x=>x.subject===intel.subject?{...x,status:'revoked' as const}:x),events:[...m.events,{version:m.version+1,kind:'revoked' as const,subject:intel.subject,actor:owner.subject,at:'2026-09-13T10:02:00.000Z',effective:missionStart(1),details:{}}]}))).toThrow(/Injected/);
  expect(repo.require('c1')).toEqual(m3);store.db.exec('DROP TRIGGER reject_membership_audit');
  // Non-contiguous or foreign transitions are refused before anything is written.
  expect(()=>repo.mutate('c1',m=>({...m,version:m.version+2}))).toThrow(/contiguous/);
  expect(()=>repo.mutate('c1',m=>({...m,version:m.version+1,scope:{...m.scope,ownerSubject:'other'},events:[...m.events,{version:m.version+1,kind:'limit-changed' as const,subject:null,actor:'x',at:'2026-09-13T10:02:00.000Z',effective:null,details:{}}]}))).toThrow(/identity or scope/);
  expect(repo.history('c1').map(h=>[h.version,h.kind])).toEqual([[1,'created'],[2,'enrolled'],[3,'limit-changed']]);
  store.close();clean.splice(clean.findIndex(f=>String(f).includes('store.close')),1);store=new Store(path.join(dir,'t.sqlite'));clean.push(()=>store.close());repo=new CampaignMembershipStore(store);
  expect(repo.require('c1')).toEqual(m3);expect(repo.all().map(m=>m.campaignId)).toEqual(['c1']);
 });
});

describe('atomic membership and mission seats',()=>{
 it.each(['withdraw','revoke'] as const)('%s rolls back membership, seat, invitation and audit together when the final event fails',async action=>{
  const f=fixture(),v=await f.start(),id=v.campaign.id,mission=v.activeExerciseId!;
  f.join(id,intel);
  const state=f.campaigns.owned(id,scope),before=f.campaigns.members.repo.require(id);
  const code=f.campaigns.members.issueCode(state,fresh(owner));
  const beforeEvents=f.service.store.events(mission);
  const kind=action==='withdraw'?'campaign_participant_withdrawn':'campaign_participant_revoked';
  f.service.store.db.exec(`CREATE TRIGGER reject_final_removal BEFORE INSERT ON events WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'Injected final event failure'); END;`);
  const remove=()=>action==='withdraw'?f.campaigns.members.withdraw(state,fresh(intel)):f.campaigns.members.revoke(state,intel.subject,fresh(owner));
  expect(remove).toThrow(/Injected final event failure/);
  expect(f.campaigns.members.repo.require(id)).toEqual(before);
  expect(f.activeSeats(mission)).toContain(intel.subject);
  expect(f.service.store.events(mission)).toEqual(beforeEvents);
  expect(f.campaigns.members.lookupCode(code.code,ROOM).id).toBe(id);
  f.service.store.db.exec('DROP TRIGGER reject_final_removal');
  remove();
  expect(f.activeSeats(mission)).not.toContain(intel.subject);
  expect(f.campaigns.members.repo.require(id).members.find(m=>m.subject===intel.subject)?.status).toBe(action==='withdraw'?'withdrawn':'revoked');
  expect(f.service.store.events(mission).filter(e=>e.kind===kind)).toHaveLength(1);
 });
 it('rolls a join back when its seat/audit cannot commit, then allows an explicit retry',async()=>{
  const f=fixture(),v=await f.start(),id=v.campaign.id,mission=v.activeExerciseId!;
  const before=f.campaigns.members.repo.require(id);
  f.service.store.db.exec("CREATE TRIGGER reject_join BEFORE INSERT ON events WHEN NEW.kind='participant_joined' BEGIN SELECT RAISE(ABORT,'Injected join failure'); END;");
  expect(()=>f.join(id,intel)).toThrow(/Injected join failure/);
  expect(f.campaigns.members.repo.require(id)).toEqual(before);
  expect(f.seats(mission).some(p=>p.subject===intel.subject)).toBe(false);
  f.service.store.db.exec('DROP TRIGGER reject_join');
  expect(f.join(id,intel).joined).toBe(true);
  expect(f.activeSeats(mission)).toContain(intel.subject);
 });
});

describe('carryover between missions',()=>{
 it('seats the consented roster on each new mission from membership terms: join, withdraw, revoke, lift and rejoin all land on the right mission',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;const m0=v0.activeExerciseId!;
  // Version 2: created, then mission 0 recorded in the attach transaction.
  expect(v0.membership).toMatchObject({version:2,maxParticipants:15,activeParticipants:0,viewer:{subject:owner.subject,role:'owner',canManage:true}});
  expect(v0.membership.missions).toEqual([{missionIndex:0,exerciseId:m0,status:'running',carried:[owner.subject],excluded:[],recorded:true,detached:false}]);
  expect(f.seats(m0).map(p=>[p.subject,p.source??null])).toEqual([[owner.subject,null]]);
  // Intel joins mid-mission: seated now with a campaign-join marker; membership effective at the current tick.
  const w0=f.service.world(m0);while(w0.engine.game.ticks()<12)f.service.tick(w0);
  const joined=f.join(id,intel);expect(joined.joined).toBe(true);expect(joined.activeExerciseId).toBe(m0);
  expect(joined.seat).toMatchObject({subject:intel.subject,source:'campaign-join',roleAtJoin:'intelligence',joinedTick:12,active:true,owner:false});
  expect(f.campaigns.members.repo.require(id).members[1].terms[0].from).toEqual({missionIndex:0,tick:12});
  expect(f.service.store.events(m0).filter(e=>e.kind==='participant_joined').map(e=>e.details.source)).toEqual(['campaign-join']);
  expect(f.join(id,intel).joined).toBe(false);
  f.join(id,second);
  // Mission 1: both carried from membership only, marked as carryover; nothing read from mission 0's roster.
  const v1=await f.advance(id);const m1=v1.activeExerciseId!;expect(v1.campaign.missions).toHaveLength(2);
  expect(f.seats(m1).map(p=>[p.subject,p.source??null,p.roleAtJoin])).toEqual([[owner.subject,null,'commander'],[intel.subject,'campaign-carryover','unknown'],[second.subject,'campaign-carryover','unknown']]);
  expect(v1.membership.missions[1]).toMatchObject({missionIndex:1,exerciseId:m1,carried:[owner.subject,intel.subject,second.subject],excluded:[]});
  expect(f.service.store.events(m1).find(e=>e.kind==='campaign_membership_carried')?.details).toMatchObject({carried:[owner.subject,intel.subject,second.subject],excluded:[]});
  // Second withdraws during mission 1: seat deactivated (evidence kept), listed on mission 1, absent from mission 2.
  f.campaigns.members.withdraw(f.campaigns.owned(id,scope),fresh(second));
  expect(f.seats(m1).find(p=>p.subject===second.subject)).toMatchObject({active:false,removedBy:second.subject});
  expect(f.service.store.events(m1).map(e=>e.kind)).toContain('campaign_participant_withdrawn');
  expect(()=>f.campaigns.view(id,viewer(second))).toThrow(/scope/);
  const v2=await f.advance(id);const m2=v2.activeExerciseId!;
  expect(f.activeSeats(m2)).toEqual([owner.subject,intel.subject]);expect(v2.membership.missions[1].carried).toContain(second.subject);expect(v2.membership.missions[2].carried).toEqual([owner.subject,intel.subject]);
  // Owner revokes intel: absent from every later mission, invite code rotated and rejoin refused until lifted.
  const code=f.campaigns.members.issueCode(f.campaigns.owned(id,scope),fresh(owner));
  f.campaigns.members.revoke(f.campaigns.owned(id,scope),intel.subject,fresh(owner));
  expect(f.activeSeats(m2)).toEqual([owner.subject]);expect(()=>f.campaigns.members.lookupCode(code.code,ROOM)).toThrow(/invalid/);
  const again=f.campaigns.members.issueCode(f.campaigns.owned(id,scope),fresh(owner));
  expect(()=>f.campaigns.members.join(f.campaigns.members.lookupCode(again.code,ROOM),fresh(intel))).toThrow(/reinstatement must be explicit/);
  const v3=await f.advance(id);const m3=v3.activeExerciseId!;expect(f.activeSeats(m3)).toEqual([owner.subject]);expect(v3.membership.missions[3].carried).toEqual([owner.subject]);
  // Lift: not re-seated; the subject rejoins with their own fresh identity and is carried from the next mission.
  f.campaigns.members.lift(f.campaigns.owned(id,scope),intel.subject,fresh(owner));
  expect(f.campaigns.view(id,scope).membership.members.find(m=>m.subject===intel.subject)).toMatchObject({status:'withdrawn',rejoinRequired:true});
  expect(f.activeSeats(m3)).toEqual([owner.subject]);
  const rejoined=f.campaigns.members.join(f.campaigns.members.lookupCode(again.code,ROOM),fresh(intel));
  expect(rejoined.seat?.source).toBe('campaign-join');expect(f.activeSeats(m3)).toEqual([owner.subject,intel.subject]);
  const v4=await f.advance(id);expect(f.activeSeats(v4.activeExerciseId!)).toEqual([owner.subject,intel.subject]);
  expect(v4.membership.missions.map(x=>x.carried)).toEqual([[owner.subject],[owner.subject,intel.subject,second.subject],[owner.subject,intel.subject],[owner.subject],[owner.subject,intel.subject]]);
  // Ledger and membership versions are independent and both contiguous.
  expect(f.campaigns.members.repo.history(id).map(h=>h.version)).toEqual(Array.from({length:f.campaigns.members.repo.require(id).version},(_,i)=>i+1));
  expect(f.campaigns.repo.history(id,scope).map(h=>h.kind).filter(k=>k==='mission-attached')).toHaveLength(5);
 },60000);
 it('the participant limit holds across missions and second-mission seats never come from a previous exercise roster',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;
  f.campaigns.members.setLimit(f.campaigns.owned(id,scope),1,fresh(owner));
  f.join(id,intel);expect(()=>f.join(id,second)).toThrow(/already has 1 participants/);
  // A seat written directly on the mission row (not through membership) is not carried anywhere.
  const rogue:Identity={...second,subject:'sub-rogue'};
  f.service.teams.carry(f.service.store.exercise(v0.activeExerciseId!)!,id,{subject:rogue.subject,name:rogue.name,organization:rogue.organization,roleAtJoin:'commander',source:'campaign-join',membershipVersion:0},5);
  expect(f.activeSeats(v0.activeExerciseId!)).toContain(rogue.subject);
  const v1=await f.advance(id);expect(f.activeSeats(v1.activeExerciseId!)).toEqual([owner.subject,intel.subject]);
  expect(()=>f.join(id,second)).toThrow(/already has 1 participants/);
  f.campaigns.members.setLimit(f.campaigns.owned(id,scope),2,fresh(owner));f.join(id,second);
  const v2=await f.advance(id);expect(f.activeSeats(v2.activeExerciseId!)).toEqual([owner.subject,intel.subject,second.subject]);
  expect(()=>f.campaigns.members.setLimit(f.campaigns.owned(id,scope),1,fresh(owner))).toThrow(/below the current active/);
  expect(()=>f.campaigns.members.setLimit(f.campaigns.owned(id,scope),3,fresh(intel))).toThrow(/Only the campaign owner/);
 },40000);
 it('a join or withdrawal during asynchronous mission preparation is recomputed before commit; a removed member is never resurrected',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;f.join(id,intel);
  const plan=f.campaigns.members.plan.bind(f.campaigns.members);let plans=0,act:(()=>void)|null=null;
  f.campaigns.members.plan=async(...a)=>{const p=await plan(...a);plans++;if(act){const fn=act;act=null;fn();}return p;};
  // Late joins after the decisions for mission 1 were computed: the stale plan loses its CAS and is recomputed.
  act=()=>{f.join(id,late);};
  const v1=await f.advance(id);expect(plans).toBe(2);expect(v1.enabled).toBe(true);expect(v1.paused).toBeNull();
  expect(f.activeSeats(v1.activeExerciseId!)).toEqual([owner.subject,intel.subject,late.subject]);
  expect(v1.membership.missions[1].carried).toEqual([owner.subject,intel.subject,late.subject]);
  // Intel is revoked after the plan for mission 2 was computed: the commit must not carry them.
  plans=0;act=()=>{f.campaigns.members.revoke(f.campaigns.owned(id,scope),intel.subject,fresh(owner));};
  const v2=await f.advance(id);expect(plans).toBe(2);
  expect(f.activeSeats(v2.activeExerciseId!)).toEqual([owner.subject,late.subject]);expect(v2.membership.missions[2].carried).toEqual([owner.subject,late.subject]);
  expect(f.seats(v2.activeExerciseId!).some(p=>p.subject===intel.subject)).toBe(false);
  expect(f.campaigns.members.repo.require(id).members.find(m=>m.subject===intel.subject)?.status).toBe('revoked');
 },40000);
 it('restart recovers a created-but-unattached mission and seats members from durable membership, without creating another world',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;f.join(id,intel);
  const original=f.service.create.bind(f.service);
  f.service.create=async(...args:Parameters<GameService['create']>)=>{const row=await original(...args);f.auth.allowed=false;return row;};
  f.finishAt(v0.activeExerciseId!,21);f.campaigns.view(id,scope);await f.campaigns.settled(id);
  expect(f.missions()).toHaveLength(2);expect(f.campaigns.view(id,scope).campaign.missions).toHaveLength(1);
  const reserved=f.missions().find(r=>r.id!==v0.activeExerciseId)!.id;expect(f.seats(reserved).map(p=>p.subject)).toEqual([owner.subject]);
  f.close();clean.splice(clean.indexOf(f.close),1);
  const restarted=new GameService(f.dir);clean.push(()=>restarted.close());await restarted.init(false);restarted.baseline=()=>{};
  const campaigns=new CampaignService(restarted);
  expect(campaigns.view(id,viewer(intel)).membership.viewer).toMatchObject({role:'participant',status:'active',canManage:false});
  f.auth.allowed=true;const view=await campaigns.resume(id,scope,f.resolve);
  expect(view.campaign.missions).toHaveLength(2);expect(view.activeExerciseId).toBe(reserved);expect(restarted.store.exercises().filter(e=>e.options?.campaignId)).toHaveLength(2);
  expect(restarted.teams.participants(restarted.store.exercise(reserved)!).filter(p=>p.active).map(p=>[p.subject,p.source??null])).toEqual([[owner.subject,null],[intel.subject,'campaign-carryover']]);
  expect(view.membership.missions[1]).toMatchObject({exerciseId:reserved,carried:[owner.subject,intel.subject],recorded:true});
  // Idempotent redelivery of the attach records nothing twice.
  expect(campaigns.members.repo.history(id).filter(h=>h.kind==='mission-enrolled')).toHaveLength(2);
 },40000);
 it('campaigns created before shared enrollment get an owner-only membership on first read and later missions are recorded from there',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;
  f.service.store.db.exec('DELETE FROM campaign_memberships; DELETE FROM campaign_membership_events;');
  const legacy=f.campaigns.view(id,scope);
  // No fresh owner identity is available on a read, so the legacy record carries a neutral label, never an invented one.
  expect(legacy.membership).toMatchObject({version:1,members:[{subject:owner.subject,role:'owner',name:'Campaign owner',organization:'Not recorded',roleAtJoin:'unknown'}]});
  expect(legacy.membership.missions[0]).toMatchObject({recorded:false,carried:null,excluded:null});
  expect(legacy.membership.limits.some(l=>/before shared enrollment/.test(l))).toBe(true);
  f.join(id,intel);const v1=await f.advance(id);
  expect(v1.membership.missions.map(m=>m.recorded)).toEqual([false,true]);expect(f.activeSeats(v1.activeExerciseId!)).toEqual([owner.subject,intel.subject]);
 },40000);
});

describe('fresh native authority at mission creation',()=>{
 it('participant decisions come from each subject\'s own fresh check; denied and unavailable exclude without changing membership, and the recorded seat never uses the cached roleAtJoin',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;
  for(const who of [intel,second,late])f.join(id,who);
  const events=(exerciseId:string)=>f.service.store.events(exerciseId).filter(e=>e.kind==='campaign_participant_excluded').map(e=>[e.details.subject,e.details.outcome]);
  // No authority bound: everybody is carried as record-only with an unknown seat label.
  const v1=await f.advance(id);
  expect(f.seats(v1.activeExerciseId!).filter(p=>!p.owner).map(p=>[p.subject,p.roleAtJoin,p.source])).toEqual([[intel.subject,'unknown','campaign-carryover'],[second.subject,'unknown','campaign-carryover'],[late.subject,'unknown','campaign-carryover']]);
  expect(v1.membership.limits.some(l=>/record-only/.test(l))).toBe(true);
  // Live checks: intel now resolves as a commander (native role changed) → seat from the fresh resolution, not the enrolment label.
  f.campaigns.members.useAuthority(table({
   [intel.subject]:{outcome:'verified',identity:{...intel,role:'commander',name:'Analyst Two (promoted)'},workroomId:ROOM},
   [second.subject]:{outcome:'denied',detail:'workroom access archived'},
   [late.subject]:{outcome:'unavailable',detail:'platform timeout'},
  }));
  const v2=await f.advance(id);const m2=v2.activeExerciseId!;
  expect(f.activeSeats(m2)).toEqual([owner.subject,intel.subject]);
  expect(f.seats(m2).find(p=>p.subject===intel.subject)).toMatchObject({roleAtJoin:'commander',name:'Analyst Two (promoted)',source:'campaign-carryover'});
  expect(f.campaigns.members.repo.require(id).members.find(m=>m.subject===intel.subject)?.roleAtJoin).toBe('intelligence');
  expect(v2.membership.missions[2].excluded).toEqual([{subject:second.subject,outcome:'denied',detail:'workroom access archived'},{subject:late.subject,outcome:'unavailable',detail:'platform timeout'}]);
  expect(events(m2)).toEqual([[second.subject,'denied'],[late.subject,'unavailable']]);
  expect(f.campaigns.members.repo.require(id).members.filter(m=>m.role==='participant').map(m=>m.status)).toEqual(['active','active','active']);
  // A verified answer for the wrong workroom, or for a different subject, is never a grant.
  f.campaigns.members.useAuthority(table({
   [intel.subject]:{outcome:'verified',identity:intel,workroomId:'elsewhere'},
   [second.subject]:{outcome:'verified',identity:{...late},workroomId:ROOM},
   [late.subject]:{outcome:'verified',identity:late,workroomId:ROOM},
  }));
  const v3=await f.advance(id);expect(f.activeSeats(v3.activeExerciseId!)).toEqual([owner.subject,second.subject,late.subject]);
  expect(v3.membership.missions[3].excluded).toEqual([{subject:intel.subject,outcome:'denied',detail:'Subject resolved outside the campaign workroom'}]);
  expect(f.seats(v3.activeExerciseId!).find(p=>p.subject===second.subject)?.roleAtJoin).toBe('unknown');
  // A throwing check is `unavailable`; the excluded subject recovers by joining again with a fresh session, which seats them now.
  f.campaigns.members.useAuthority({check:async()=>{throw new Error('resolver crashed');}});
  const v4=await f.advance(id);expect(f.activeSeats(v4.activeExerciseId!)).toEqual([owner.subject]);
  expect(v4.membership.missions[4].excluded?.map(x=>x.outcome)).toEqual(['unavailable','unavailable','unavailable']);
  const back=f.join(id,intel);expect(back.joined).toBe(false);expect(back.seat).toMatchObject({source:'campaign-join',roleAtJoin:'intelligence'});
  expect(f.activeSeats(v4.activeExerciseId!)).toEqual([owner.subject,intel.subject]);
 },60000);
 it('owner authority is checked freshly for every mission and its loss pauses without seating anyone',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;f.join(id,intel);
  f.auth.allowed=false;f.finishAt(v0.activeExerciseId!,21);f.campaigns.view(id,scope);await f.campaigns.settled(id);
  const paused=f.campaigns.view(id,scope);expect(paused.enabled).toBe(false);expect(paused.paused?.reason).toMatch(/revoked/);expect(f.missions()).toHaveLength(1);
  expect(paused.membership.missions).toHaveLength(1);expect(f.campaigns.members.repo.require(id).missions).toHaveLength(1);
  f.auth.allowed=true;const resumed=await f.campaigns.resume(id,scope,f.resolve);
  expect(resumed.campaign.missions).toHaveLength(2);expect(f.activeSeats(resumed.activeExerciseId!)).toEqual([owner.subject,intel.subject]);
 },30000);
});

describe('privacy and scope',()=>{
 it('a carried participant sees campaign missions as shared but no branch, no other campaign, no foreign workroom and no owner controls',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;const m0=v0.activeExerciseId!;
  const other=await f.campaigns.create({name:'Private',identity:owner,workroomId:ROOM,resolve:f.resolve,rules:RULES});
  f.join(id,intel);const v1=await f.advance(id);const m1=v1.activeExerciseId!;
  const branch=await f.service.branch(m0,10,'blue',owner);f.service.teams.enroll(branch,owner,10);
  const s=f.scopeFor(intel);
  expect(s.visible(f.service.store.exercise(m0)!)).toBe(true);expect(s.attribution(f.service.store.exercise(m0)!)).toBe('shared');
  expect(s.visible(f.service.store.exercise(m1)!)).toBe(true);
  expect(s.visible(branch)).toBe(false);expect(branch.options.campaignId).toBeUndefined();
  expect(s.visible(f.service.store.exercise(other.activeExerciseId!)!)).toBe(false);
  expect(s.visible({...f.service.store.exercise(m1)!,options:{...f.service.store.exercise(m1)!.options,workroomId:'other-room'}})).toBe(false);
  expect(f.scopeFor(second).visible(f.service.store.exercise(m1)!)).toBe(false);
  // Campaign reads: member sees its own campaign only; strangers get the scope error (routes map it to 404).
  expect(f.campaigns.list(viewer(intel)).map(c=>[c.id,c.role])).toEqual([[id,'participant']]);
  expect(f.campaigns.list(scope).map(c=>c.role)).toEqual(['owner','owner']);
  expect(f.campaigns.list(viewer(second))).toEqual([]);
  expect(()=>f.campaigns.view(id,viewer(second))).toThrow(/scope/);
  expect(()=>f.campaigns.view(id,{ownerSubject:intel.subject,workroomId:'other-room'})).toThrow(/scope/);
  expect(()=>f.campaigns.view(other.campaign.id,viewer(intel))).toThrow(/scope/);
  const mine=f.campaigns.view(id,viewer(intel));
  expect(mine.membership.viewer).toEqual({subject:intel.subject,role:'participant',status:'active',canManage:false});
  expect(Object.keys(mine.membership.members[0]).sort()).toEqual(['name','organization','rejoinRequired','role','roleAtJoin','since','status','subject','until']);
  expect(JSON.stringify(mine)).not.toMatch(/dossier|priorAttempts|agentEnabled|staff/i);
  expect(()=>f.campaigns.pause(id,viewer(intel))).toThrow(/scope/);expect(()=>f.campaigns.stop(id,viewer(intel))).toThrow(/scope/);
  expect(()=>f.campaigns.members.issueCode(f.campaigns.owned(id,scope),fresh(intel))).toThrow(/Only the campaign owner/);
  expect(()=>f.campaigns.members.revoke(f.campaigns.owned(id,scope),owner.subject,fresh(intel))).toThrow(/Only the campaign owner/);
  // The owner cannot be withdrawn or revoked through the service either.
  expect(()=>f.campaigns.members.withdraw(f.campaigns.owned(id,scope),fresh(owner))).toThrow(/owner cannot/);
  expect(()=>f.campaigns.members.revoke(f.campaigns.owned(id,scope),owner.subject,fresh(owner))).toThrow(/Use withdrawal/);
  // Learning input for the participant lists only exercises they were seated on; the owner's branch is not a candidate.
  const input=f.service.learningInput({identity:intel,activeId:m1,playbackTick:null,selectedSide:'blue'});
  expect(input.candidates.map(c=>c.exercise.id)).toEqual([m0]);
 },40000);
 it('joining requires the joiner to resolve in the campaign workroom and a live invite; standalone exercise codes still work and never apply to missions',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;const state=f.campaigns.owned(id,scope);
  const code=f.campaigns.members.issueCode(state,fresh(owner));
  expect(()=>f.campaigns.members.lookupCode(code.code,'other-room')).toThrow(/invalid/);
  expect(()=>f.campaigns.members.lookupCode('0'.repeat(32),ROOM)).toThrow(/invalid/);
  expect(()=>f.campaigns.members.join(f.campaigns.members.lookupCode(code.code,ROOM),fresh(intel,'other-room'))).toThrow(/outside the campaign workroom/);
  expect(JSON.stringify(f.service.store.db.prepare('SELECT * FROM settings').all())).not.toContain(code.code);
  const mission=f.service.store.exercise(v0.activeExerciseId!)!;
  expect(()=>f.service.teams.issueCode(mission,owner.subject)).toThrow(/campaign invitation/);
  expect(()=>f.service.teams.enroll(mission,intel,3)).toThrow(/campaign invitation/);
  const standalone=await f.service.create('Standalone','world',owner);standalone.options.workroomId=ROOM;f.service.store.putExercise(standalone);
  const ex=f.service.teams.issueCode(standalone,owner.subject);expect(f.service.teams.lookupCode(ex.code,ROOM).id).toBe(standalone.id);
  expect(()=>f.campaigns.members.lookupCode(ex.code,ROOM)).toThrow(/invalid/);
  expect(()=>f.service.teams.carry(standalone,id,{subject:intel.subject,name:'x',organization:'y',roleAtJoin:'unknown',source:'campaign-join',membershipVersion:1},1)).toThrow(/own missions/);
 },30000);
});

describe('stopped campaign and detached mission',()=>{
 it('reports the still-running mission as detached without rewriting the ledger; withdrawal and removal still work, joining does not',async()=>{
  const f=fixture();const v0=await f.start();const id=v0.campaign.id;f.join(id,intel);f.join(id,second);
  const ledgerBefore=JSON.stringify(f.campaigns.owned(id,scope));
  const stopped=f.campaigns.stop(id,scope);expect(stopped.campaign.status).toBe('stopped');
  expect(f.service.world(v0.activeExerciseId!).row.status).toBe('running');
  expect(stopped.membership.detached).toMatchObject({exerciseId:v0.activeExerciseId});expect(stopped.membership.detached?.note).toMatch(/continues as an ordinary exercise/);
  expect(stopped.membership.missions[0]).toMatchObject({detached:true,status:'running',carried:[owner.subject]});
  expect(JSON.stringify({...f.campaigns.owned(id,scope),status:'awaiting-mission',revision:0,endReason:undefined})).toBe(JSON.stringify({...JSON.parse(ledgerBefore),status:'awaiting-mission',revision:0,endReason:undefined}));
  expect(()=>f.campaigns.members.issueCode(f.campaigns.owned(id,scope),fresh(owner))).toThrow(/stopped/);
  expect(()=>f.campaigns.members.join(f.campaigns.owned(id,scope),fresh(late))).toThrow(/stopped/);
  f.campaigns.members.withdraw(f.campaigns.owned(id,scope),fresh(intel));
  f.campaigns.members.revoke(f.campaigns.owned(id,scope),second.subject,fresh(owner));
  expect(f.activeSeats(v0.activeExerciseId!)).toEqual([owner.subject]);
  expect(f.campaigns.view(id,scope).membership.members.map(m=>m.status)).toEqual(['active','withdrawn','revoked']);
  f.finishAt(v0.activeExerciseId!,21);
  expect(f.campaigns.view(id,scope).membership.detached).toBeNull();expect(f.campaigns.view(id,scope).campaign.missions[0].end).toBeUndefined();
 },30000);
});
