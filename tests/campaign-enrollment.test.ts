import {describe,expect,it} from 'vitest';
import {
 newMembership,enrollParticipant,withdrawParticipant,revokeParticipant,reinstateParticipant,liftRevocation,setParticipantLimit,
 projectMissionEnrollment,recordMissionEnrollment,assertCarryoverTarget,isMemberAt,mayRead,latestRecordedPoint,missionStart,comparePoints,termCovers,
 MembershipError,PARTICIPANT_CEILING,type CampaignMembership,type MemberIdentity,
} from '../src/campaign/enrollment';

const T0='2026-09-13T10:00:00.000Z',T1='2026-09-13T10:05:00.000Z',T2='2026-09-13T10:10:00.000Z',T3='2026-09-13T10:15:00.000Z';
const owner:MemberIdentity={subject:'owner',name:'Owner',organization:'Org',roleAtJoin:'commander',workroomId:'room'};
const intel:MemberIdentity={subject:'intel',name:'Intel',organization:'Org',roleAtJoin:'intelligence',workroomId:'room'};
const second:MemberIdentity={subject:'second',name:'Second',organization:'Org',roleAtJoin:'commander',workroomId:'room'};
const start=()=>newMembership({campaignId:'campaign-a',owner,at:T0});
const withIntel=(effective={missionIndex:0,tick:40})=>enrollParticipant(start(),{identity:intel,actor:'intel',at:T1,effective});
const subjects=(s:CampaignMembership,index:number)=>projectMissionEnrollment(s,missionStart(index)).members.map(m=>m.subject);

describe('membership creation and scope',()=>{
 it('creates an owner-only membership with an independent version and dated audit',()=>{
  const s=start();
  expect(s).toMatchObject({schema:'replay.campaign-membership/1',campaignId:'campaign-a',scope:{ownerSubject:'owner',workroomId:'room'},version:1,maxParticipants:PARTICIPANT_CEILING});
  expect(s.members).toEqual([{subject:'owner',role:'owner',name:'Owner',organization:'Org',roleAtJoin:'commander',status:'active',terms:[{from:{missionIndex:0,tick:1},startedAt:T0,startedBy:'owner'}]}]);
  expect(s.events).toEqual([{version:1,kind:'created',subject:'owner',actor:'owner',at:T0,effective:{missionIndex:0,tick:1},details:{maxParticipants:15}}]);
  expect(()=>newMembership({campaignId:'',owner,at:T0})).toThrow(MembershipError);
  expect(()=>newMembership({campaignId:'c',owner:{...owner,subject:''},at:T0})).toThrow(/Owner identity/);
  expect(()=>newMembership({campaignId:'c',owner,at:'yesterday'})).toThrow(/ISO/);
  expect(()=>newMembership({campaignId:'c',owner,at:T0,maxParticipants:PARTICIPANT_CEILING+1})).toThrow(/limit/i);
 });
 it('refuses subjects resolved in another workroom and the owner enrolling as a participant',()=>{
  const s=start();
  expect(()=>enrollParticipant(s,{identity:{...intel,workroomId:'other'},actor:'intel',at:T1,effective:missionStart(1)})).toThrow(/outside the campaign workroom/);
  expect(()=>enrollParticipant(s,{identity:{...intel,workroomId:null},actor:'intel',at:T1,effective:missionStart(1)})).toThrow(/outside the campaign workroom/);
  expect(()=>enrollParticipant(s,{identity:owner,actor:'owner',at:T1,effective:missionStart(1)})).toThrow(/owner is already a member/);
  const local=newMembership({campaignId:'local',owner:{...owner,workroomId:null},at:T0});
  expect(enrollParticipant(local,{identity:{...intel,workroomId:null},actor:'intel',at:T1,effective:missionStart(0)}).members).toHaveLength(2);
  expect(()=>enrollParticipant(local,{identity:intel,actor:'intel',at:T1,effective:missionStart(0)})).toThrow(/outside the campaign workroom/);
 });
});

describe('enrollment, withdrawal, revocation and rejoin',()=>{
 it('enrolls explicitly with a dated effective point and treats re-enrollment of an active member as a no-op',()=>{
  const s=withIntel();
  expect(s.version).toBe(2);expect(s.events.at(-1)).toMatchObject({version:2,kind:'enrolled',subject:'intel',actor:'intel',effective:{missionIndex:0,tick:40}});
  expect(s.members[1]).toMatchObject({role:'participant',roleAtJoin:'intelligence',status:'active',terms:[{from:{missionIndex:0,tick:40},startedAt:T1,startedBy:'intel'}]});
  const again=enrollParticipant(s,{identity:{...intel,roleAtJoin:'commander',name:'Renamed'},actor:'owner',at:T2,effective:missionStart(3)});
  expect(again).toBe(s);
  expect(again.members[1].roleAtJoin).toBe('intelligence');
  expect(isMemberAt(s,'intel',{missionIndex:0,tick:39})).toBe(false);
  expect(isMemberAt(s,'intel',{missionIndex:0,tick:40})).toBe(true);
  expect(isMemberAt(s,'intel',missionStart(7))).toBe(true);
  expect(isMemberAt(s,'stranger',missionStart(0))).toBe(false);
 });
 it('withdrawal keeps the current mission history and excludes the subject from later missions; rejoin opens a new term',()=>{
  const s=withIntel(missionStart(0));
  const left=withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:1,tick:250}});
  expect(left.version).toBe(3);expect(left.members[1].status).toBe('withdrawn');
  expect(left.members[1].terms).toEqual([{from:{missionIndex:0,tick:1},startedAt:T1,startedBy:'intel',to:{missionIndex:1,tick:250},endedAt:T2,endedBy:'intel',endReason:'withdrawn'}]);
  expect(withdrawParticipant(left,{subject:'intel',at:T3,effective:missionStart(4)})).toBe(left);
  expect(isMemberAt(left,'intel',{missionIndex:1,tick:249})).toBe(true);
  expect(isMemberAt(left,'intel',{missionIndex:1,tick:250})).toBe(false);
  expect(subjects(left,1)).toEqual(['owner','intel']);
  expect(subjects(left,2)).toEqual(['owner']);
  expect(projectMissionEnrollment(left,missionStart(2)).absent).toEqual([{subject:'intel',status:'withdrawn',until:null}]);
  expect(()=>enrollParticipant(left,{identity:intel,actor:'intel',at:T3,effective:{missionIndex:1,tick:100}})).toThrow(/before the member's latest recorded point/);
  const back=enrollParticipant(left,{identity:intel,actor:'intel',at:T3,effective:missionStart(3)});
  expect(back.version).toBe(4);expect(back.events.at(-1)).toMatchObject({kind:'rejoined',details:{term:2}});
  expect(back.members[1].status).toBe('active');expect(back.members[1].terms).toHaveLength(2);
  expect(subjects(back,2)).toEqual(['owner']);
  expect(subjects(back,3)).toEqual(['owner','intel']);
  expect(projectMissionEnrollment(back,missionStart(2)).absent).toEqual([{subject:'intel',status:'active',until:{missionIndex:3,tick:1}}]);
  expect(projectMissionEnrollment(back,missionStart(3)).members[1].since).toEqual({missionIndex:3,tick:1});
 });
 it('revocation is another actor\'s decision, is idempotent, blocks rejoin and requires explicit reinstatement',()=>{
  const s=withIntel(missionStart(0));
  expect(()=>revokeParticipant(s,{subject:'intel',actor:'intel',at:T2,effective:missionStart(1)})).toThrow(/Use withdrawal/);
  expect(()=>revokeParticipant(s,{subject:'owner',actor:'intel',at:T2,effective:missionStart(1)})).toThrow(/owner cannot be withdrawn or revoked/);
  expect(()=>withdrawParticipant(s,{subject:'owner',at:T2,effective:missionStart(1)})).toThrow(/owner cannot/);
  expect(()=>revokeParticipant(s,{subject:'ghost',actor:'owner',at:T2,effective:missionStart(1)})).toThrow(/not found/);
  const removed=revokeParticipant(s,{subject:'intel',actor:'owner',at:T2,effective:{missionIndex:1,tick:90}});
  expect(removed.members[1]).toMatchObject({status:'revoked',terms:[{to:{missionIndex:1,tick:90},endedBy:'owner',endReason:'revoked'}]});
  expect(revokeParticipant(removed,{subject:'intel',actor:'owner',at:T3,effective:missionStart(5)})).toBe(removed);
  expect(()=>withdrawParticipant(removed,{subject:'intel',at:T3,effective:missionStart(2)})).toThrow(/removed member cannot withdraw/);
  expect(()=>enrollParticipant(removed,{identity:intel,actor:'intel',at:T3,effective:missionStart(2)})).toThrow(/reinstatement must be explicit/);
  expect(()=>enrollParticipant(removed,{identity:intel,actor:'owner',at:T3,effective:missionStart(2)})).toThrow(/reinstatement must be explicit/);
  for(let i=1;i<=6;i++)expect(subjects(removed,i+1)).toEqual(['owner']);
  expect(subjects(removed,1)).toEqual(['owner','intel']);
  expect(()=>reinstateParticipant(removed,{identity:intel,actor:'intel',at:T3,effective:missionStart(2)})).toThrow(/cannot reinstate themselves/);
  expect(()=>reinstateParticipant(removed,{identity:{...intel,workroomId:'elsewhere'},actor:'owner',at:T3,effective:missionStart(2)})).toThrow(/outside the campaign workroom/);
  expect(()=>reinstateParticipant(removed,{identity:intel,actor:'owner',at:T3,effective:{missionIndex:1,tick:10}})).toThrow(/before the member's latest recorded point/);
  const back=reinstateParticipant(removed,{identity:intel,actor:'owner',at:T3,effective:missionStart(2)});
  expect(back.events.at(-1)).toMatchObject({kind:'reinstated',actor:'owner',effective:{missionIndex:2,tick:1}});
  expect(reinstateParticipant(back,{identity:intel,actor:'owner',at:T3,effective:missionStart(3)})).toBe(back);
  expect(subjects(back,2)).toEqual(['owner','intel']);
  const withdrawn=withdrawParticipant(back,{subject:'intel',at:T3,effective:missionStart(3)});
  expect(()=>reinstateParticipant(withdrawn,{identity:intel,actor:'owner',at:T3,effective:missionStart(4)})).toThrow(/Only a removed member/);
  const revokedWhileOut=revokeParticipant(withdrawn,{subject:'intel',actor:'owner',at:T3,effective:missionStart(4)});
  expect(revokedWhileOut.members[1]).toMatchObject({status:'revoked'});expect(revokedWhileOut.members[1].terms).toHaveLength(2);
  expect(revokedWhileOut.events.at(-1)).toMatchObject({kind:'revoked',details:{previousStatus:'withdrawn'}});
 });
 it('rejects non-monotonic and invalid effective points',()=>{
  const s=withIntel({missionIndex:2,tick:30});
  expect(()=>withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:2,tick:29}})).toThrow(/before the member's latest/);
  expect(withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:2,tick:30}}).members[1].status).toBe('withdrawn');
  expect(()=>withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:-1,tick:1}})).toThrow(/nonnegative/);
  expect(()=>withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:1,tick:1.5}})).toThrow(/nonnegative/);
  expect(()=>withdrawParticipant(s,{subject:'intel',at:'',effective:missionStart(3)})).toThrow(/ISO/);
  expect(comparePoints({missionIndex:1,tick:900},{missionIndex:2,tick:0})).toBeLessThan(0);
  expect(termCovers({from:missionStart(1),startedAt:T0,startedBy:'x',to:missionStart(3)},missionStart(3))).toBe(false);
 });
 it('enforces a finite participant limit that counts active participants only',()=>{
  let s=newMembership({campaignId:'small',owner,at:T0,maxParticipants:1});
  s=enrollParticipant(s,{identity:intel,actor:'intel',at:T1,effective:missionStart(0)});
  expect(()=>enrollParticipant(s,{identity:second,actor:'second',at:T1,effective:missionStart(0)})).toThrow(/already has 1 participants/);
  expect(enrollParticipant(s,{identity:intel,actor:'intel',at:T1,effective:missionStart(0)})).toBe(s);
  const left=withdrawParticipant(s,{subject:'intel',at:T2,effective:missionStart(1)});
  const withSecond=enrollParticipant(left,{identity:second,actor:'second',at:T2,effective:missionStart(1)});
  expect(withSecond.members.map(m=>m.subject)).toEqual(['owner','intel','second']);
  expect(()=>enrollParticipant(withSecond,{identity:intel,actor:'intel',at:T3,effective:missionStart(2)})).toThrow(/already has 1/);
  expect(setParticipantLimit(withSecond,{maxParticipants:1,actor:'owner',at:T3})).toBe(withSecond);
  expect(()=>setParticipantLimit(withSecond,{maxParticipants:0,actor:'owner',at:T3})).toThrow(/below the current active/);
  expect(()=>setParticipantLimit(withSecond,{maxParticipants:PARTICIPANT_CEILING+1,actor:'owner',at:T3})).toThrow(/0 to 15/);
  const wider=setParticipantLimit(withSecond,{maxParticipants:2,actor:'owner',at:T3});
  expect(wider.events.at(-1)).toMatchObject({kind:'limit-changed',subject:null,effective:null,details:{from:1,to:2}});
  const revoked=revokeParticipant(wider,{subject:'second',actor:'owner',at:T3,effective:missionStart(2)});
  expect(()=>reinstateParticipant(setParticipantLimit(enrollParticipant(revoked,{identity:intel,actor:'intel',at:T3,effective:missionStart(2)}),{maxParticipants:1,actor:'owner',at:T3}),{identity:second,actor:'owner',at:T3,effective:missionStart(3)})).toThrow(/already has 1/);
 });
});

describe('review defects: limit state and retroactive removal ordering',()=>{
 it('changing the participant limit changes the seats actually available, not only the audit',()=>{
  let s=newMembership({campaignId:'seats',owner,at:T0,maxParticipants:1});
  s=enrollParticipant(s,{identity:intel,actor:'intel',at:T1,effective:missionStart(0)});
  expect(()=>enrollParticipant(s,{identity:second,actor:'second',at:T1,effective:missionStart(0)})).toThrow(/already has 1 participants/);
  const wider=setParticipantLimit(s,{maxParticipants:2,actor:'owner',at:T2});
  expect(wider.maxParticipants).toBe(2);expect(wider.version).toBe(s.version+1);
  expect(wider.events.at(-1)).toMatchObject({kind:'limit-changed',details:{from:1,to:2}});
  const full=enrollParticipant(wider,{identity:second,actor:'second',at:T2,effective:missionStart(0)});
  expect(full.members.filter(m=>m.status==='active'&&m.role==='participant')).toHaveLength(2);
  expect(()=>enrollParticipant(full,{identity:{...second,subject:'third'},actor:'third',at:T2,effective:missionStart(0)})).toThrow(/already has 2 participants/);
  // Narrowing to the current count is allowed and then blocks the next seat; narrowing below it is refused.
  const left=withdrawParticipant(full,{subject:'second',at:T3,effective:missionStart(1)});
  const narrow=setParticipantLimit(left,{maxParticipants:1,actor:'owner',at:T3});
  expect(narrow.maxParticipants).toBe(1);
  expect(()=>enrollParticipant(narrow,{identity:second,actor:'second',at:T3,effective:missionStart(1)})).toThrow(/already has 1 participants/);
  expect(()=>setParticipantLimit(narrow,{maxParticipants:0,actor:'owner',at:T3})).toThrow(/below the current active/);
  expect(setParticipantLimit(narrow,{maxParticipants:1,actor:'owner',at:T3})).toBe(narrow);
  // Zero seats is a valid closed campaign once nobody is active.
  const closed=setParticipantLimit(withdrawParticipant(narrow,{subject:'intel',at:T3,effective:missionStart(1)}),{maxParticipants:0,actor:'owner',at:T3});
  expect(closed.maxParticipants).toBe(0);
  expect(()=>enrollParticipant(closed,{identity:intel,actor:'intel',at:T3,effective:missionStart(1)})).toThrow(/already has 0 participants/);
 });
 it('revoking a withdrawn member cannot be backdated and later reinstatement or rejoin cannot precede the removal',()=>{
  const s=withIntel(missionStart(0));
  const left=withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:1,tick:250}});
  expect(latestRecordedPoint(left,'intel')).toEqual({missionIndex:1,tick:250});
  expect(()=>revokeParticipant(left,{subject:'intel',actor:'owner',at:T3,effective:{missionIndex:1,tick:100}})).toThrow(/before the member's latest recorded point/);
  const removed=revokeParticipant(left,{subject:'intel',actor:'owner',at:T3,effective:{missionIndex:3,tick:20}});
  expect(removed.members[1]).toMatchObject({status:'revoked',terms:[{to:{missionIndex:1,tick:250},endReason:'withdrawn'}]});
  expect(latestRecordedPoint(removed,'intel')).toEqual({missionIndex:3,tick:20});
  // Reinstatement is measured against the revocation point, not the earlier term end.
  expect(()=>reinstateParticipant(removed,{identity:intel,actor:'owner',at:T3,effective:{missionIndex:2,tick:1}})).toThrow(/before the member's latest recorded point/);
  expect(()=>reinstateParticipant(removed,{identity:intel,actor:'owner',at:T3,effective:{missionIndex:3,tick:19}})).toThrow(/before the member's latest recorded point/);
  const back=reinstateParticipant(removed,{identity:intel,actor:'owner',at:T3,effective:{missionIndex:3,tick:20}});
  expect(back.members[1].terms.at(-1)?.from).toEqual({missionIndex:3,tick:20});
  expect(isMemberAt(back,'intel',{missionIndex:2,tick:500})).toBe(false);
  expect(isMemberAt(back,'intel',{missionIndex:3,tick:20})).toBe(true);
  // Lifting instead of reinstating: the member becomes withdrawn and must rejoin at or after the lift point.
  expect(()=>liftRevocation(removed,{subject:'intel',actor:'intel',at:T3,effective:missionStart(4)})).toThrow(/cannot lift their own/);
  expect(()=>liftRevocation(removed,{subject:'ghost',actor:'owner',at:T3,effective:missionStart(4)})).toThrow(/not found/);
  expect(()=>liftRevocation(removed,{subject:'intel',actor:'owner',at:T3,effective:{missionIndex:3,tick:5}})).toThrow(/before the member's latest recorded point/);
  const lifted=liftRevocation(removed,{subject:'intel',actor:'owner',at:T3,effective:missionStart(4)});
  expect(lifted.members[1].status).toBe('withdrawn');expect(lifted.members[1].terms).toHaveLength(1);
  expect(lifted.events.at(-1)).toMatchObject({kind:'revocation-lifted',subject:'intel',actor:'owner',effective:{missionIndex:4,tick:1},details:{rejoinRequired:true}});
  expect(liftRevocation(lifted,{subject:'intel',actor:'owner',at:T3,effective:missionStart(5)})).toBe(lifted);
  expect(()=>enrollParticipant(lifted,{identity:intel,actor:'intel',at:T3,effective:{missionIndex:3,tick:900}})).toThrow(/before the member's latest recorded point/);
  const rejoined=enrollParticipant(lifted,{identity:intel,actor:'intel',at:T3,effective:missionStart(4)});
  expect(rejoined.events.at(-1)).toMatchObject({kind:'rejoined',details:{term:2}});
  expect(subjects(rejoined,3)).toEqual(['owner']);expect(subjects(rejoined,4)).toEqual(['owner','intel']);
  expect(rejoined.events.map(e=>e.version)).toEqual([1,2,3,4,5,6]);
 });
 it('read access follows active membership at or after the point; withdrawn and removed subjects lose it at once',()=>{
  const s=withIntel({missionIndex:1,tick:1});
  expect(mayRead(s,'owner',missionStart(0))).toBe(true);
  expect(mayRead(s,'intel',{missionIndex:0,tick:300})).toBe(true);
  expect(mayRead(s,'intel',missionStart(4))).toBe(true);
  expect(mayRead(s,'stranger',missionStart(1))).toBe(false);
  const left=withdrawParticipant(s,{subject:'intel',at:T2,effective:{missionIndex:1,tick:250}});
  expect(mayRead(left,'intel',{missionIndex:1,tick:100})).toBe(false);
  expect(mayRead(revokeParticipant(s,{subject:'intel',actor:'owner',at:T2,effective:missionStart(2)}),'intel',missionStart(1))).toBe(false);
 });
});

describe('mission enrollment projection and dated records',()=>{
 it('carries only verified/unverified participants, requires the owner verified and excludes without changing membership',()=>{
  const s=enrollParticipant(withIntel(missionStart(0)),{identity:second,actor:'second',at:T1,effective:missionStart(0)});
  expect(()=>recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',decisions:[{subject:'owner',outcome:'unverified'},{subject:'intel',outcome:'verified'},{subject:'second',outcome:'verified'}]})).toThrow(/owner's fresh native write authority/);
  expect(()=>recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'verified'}]})).toThrow(/missing second/);
  expect(()=>recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'verified'},{subject:'second',outcome:'verified'},{subject:'stranger',outcome:'verified'}]})).toThrow(/does not match a projected member/);
  expect(()=>recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'verified'},{subject:'intel',outcome:'denied'},{subject:'second',outcome:'verified'}]})).toThrow(/Duplicate/);
  const r=recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'unverified'},{subject:'second',outcome:'denied',detail:'workroom access revoked'}]});
  expect(r.version).toBe(s.version+1);
  expect(r.missions).toEqual([{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',carried:['owner','intel'],excluded:[{subject:'second',outcome:'denied',detail:'workroom access revoked'}]}]);
  expect(r.events.at(-1)).toMatchObject({kind:'mission-enrolled',effective:{missionIndex:0,tick:1},details:{exerciseId:'e0',carried:['owner','intel']}});
  expect(r.members.find(m=>m.subject==='second')?.status).toBe('active');
  expect(subjects(r,1)).toEqual(['owner','intel','second']);
  const later=recordMissionEnrollment(r,{missionIndex:1,exerciseId:'e1',at:T3,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'verified'},{subject:'second',outcome:'unavailable'}]});
  expect(later.missions[1]).toMatchObject({carried:['owner','intel'],excluded:[{subject:'second',outcome:'unavailable',detail:null}]});
 });
 it('is idempotent for the same record, rejects conflicting redelivery and out-of-order missions',()=>{
  const s=withIntel(missionStart(0)),decisions=[{subject:'owner',outcome:'verified' as const},{subject:'intel',outcome:'verified' as const}];
  const r=recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T2,actor:'owner',decisions});
  expect(recordMissionEnrollment(r,{missionIndex:0,exerciseId:'e0',at:T3,actor:'owner',decisions:[...decisions].reverse()})).toBe(r);
  expect(()=>recordMissionEnrollment(r,{missionIndex:0,exerciseId:'e0-dup',at:T3,actor:'owner',decisions})).toThrow(/Conflicting mission enrollment/);
  expect(()=>recordMissionEnrollment(r,{missionIndex:1,exerciseId:'e0',at:T3,actor:'owner',decisions})).toThrow(/Conflicting mission enrollment/);
  expect(()=>recordMissionEnrollment(r,{missionIndex:0,exerciseId:'e0',at:T3,actor:'owner',decisions:[decisions[0],{subject:'intel',outcome:'denied'}]})).toThrow(/Conflicting mission enrollment/);
  const r2=recordMissionEnrollment(r,{missionIndex:2,exerciseId:'e2',at:T3,actor:'owner',decisions});
  expect(()=>recordMissionEnrollment(r2,{missionIndex:1,exerciseId:'e1',at:T3,actor:'owner',decisions})).toThrow(/mission order/);
  expect(()=>recordMissionEnrollment(r2,{missionIndex:3,exerciseId:'',at:T3,actor:'owner',decisions})).toThrow(/Exercise identity/);
 });
 it('a removed member never reappears in later mission projections while earlier records stay intact',()=>{
  let s=withIntel(missionStart(0));
  s=recordMissionEnrollment(s,{missionIndex:0,exerciseId:'e0',at:T1,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'verified'}]});
  s=revokeParticipant(s,{subject:'intel',actor:'owner',at:T2,effective:{missionIndex:0,tick:400}});
  expect(s.missions[0].carried).toEqual(['owner','intel']);
  expect(projectMissionEnrollment(s,missionStart(1)).members.map(m=>m.subject)).toEqual(['owner']);
  expect(()=>recordMissionEnrollment(s,{missionIndex:1,exerciseId:'e1',at:T3,actor:'owner',decisions:[{subject:'owner',outcome:'verified'},{subject:'intel',outcome:'verified'}]})).toThrow(/does not match a projected member/);
  s=recordMissionEnrollment(s,{missionIndex:1,exerciseId:'e1',at:T3,actor:'owner',decisions:[{subject:'owner',outcome:'verified'}]});
  expect(s.missions.map(m=>m.carried)).toEqual([['owner','intel'],['owner']]);
  expect(s.members[1].terms[0].to).toEqual({missionIndex:0,tick:400});
 });
 it('projection never derives from a prior exercise and refuses branch, fork or foreign-scope targets',()=>{
  const s=start();
  const ok={id:'e1',kind:'world',parentId:null,options:{campaignId:'campaign-a',ownerSubject:'owner',workroomId:'room'}};
  expect(()=>assertCarryoverTarget(s,ok)).not.toThrow();
  expect(()=>assertCarryoverTarget(s,{...ok,kind:'branch'})).toThrow(/private branch/);
  expect(()=>assertCarryoverTarget(s,{...ok,parentId:'e0'})).toThrow(/private branch/);
  expect(()=>assertCarryoverTarget(s,{...ok,options:{...ok.options,campaignId:'campaign-b'}})).toThrow(/does not belong/);
  expect(()=>assertCarryoverTarget(s,{...ok,options:{...ok.options,ownerSubject:'intel'}})).toThrow(/outside the campaign owner\/workroom/);
  expect(()=>assertCarryoverTarget(s,{...ok,options:{...ok.options,workroomId:'other'}})).toThrow(/outside the campaign owner\/workroom/);
  expect(()=>assertCarryoverTarget(s,{...ok,options:null})).toThrow(/does not belong/);
  const p=projectMissionEnrollment(s,missionStart(4));
  expect(Object.keys(p.members[0]).sort()).toEqual(['name','organization','role','roleAtJoin','since','subject']);
 });
 it('mutations never alias prior state and keep a contiguous audit version sequence',()=>{
  const s0=start(),s1=withIntel(missionStart(0)),s2=withdrawParticipant(s1,{subject:'intel',at:T2,effective:missionStart(1)}),s3=enrollParticipant(s2,{identity:intel,actor:'intel',at:T3,effective:missionStart(2)});
  expect(s0.members).toHaveLength(1);expect(s1.members[1].status).toBe('active');expect(s2.members[1].status).toBe('withdrawn');expect(s1.members[1].terms).toHaveLength(1);
  expect(s3.events.map(e=>e.version)).toEqual([1,2,3,4]);expect(s3.events.map(e=>e.kind)).toEqual(['created','enrolled','withdrawn','rejoined']);
 });
});
