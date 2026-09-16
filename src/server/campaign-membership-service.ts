/**
 * Shared campaign membership service. Bridges the pure membership kernel, its durable store, the exercise
 * team table and the campaign ledger. Authorization inputs always come from the caller's fresh resolution:
 * routes pass the identity and workroom they resolved for this request; nothing here reads a cached role.
 *
 * What membership carries between missions: the consented, active membership roster only. It never reads a
 * previous exercise's participant table, a branch, a dossier, staff history or controller settings.
 *
 * Per-participant fresh checks at mission creation depend on a live session for that subject in this
 * process (`ParticipantAuthority`, bound by the routes). Without one the participant is carried as
 * `unverified`: the seat is a record, and every access they make is still gated by their own native
 * resolution in `native-http` (`exerciseScope.visible`). Owner authority is never used on their behalf.
 */
import {createHash,randomBytes} from 'node:crypto';
import {
 enrollParticipant,withdrawParticipant,revokeParticipant,liftRevocation,setParticipantLimit,recordMissionEnrollment,projectMissionEnrollment,
 assertCarryoverTarget,mayRead,missionStart,comparePoints,MembershipError,
 type AccessDecision,type AccessOutcome,type CampaignMembership,type MemberIdentity,type MissionPoint,type MembershipSeat,
} from '../campaign/enrollment';
import {CampaignMembershipStore,MembershipStoreError} from './campaign-membership-store';
import {AttachRaceError,type CampaignAuthority} from './campaign-coordinator';
import type {CampaignStore} from './campaign-store';
import type {CampaignSession} from '../campaign/session';
import {ServiceError,type GameService,type Identity} from './service';
import {type ExerciseParticipant} from './exercise-teams';
import type {ExerciseRow} from './store';

/** Result of a fresh per-subject check performed now, by that subject's own live session. */
export interface ParticipantCheck {outcome:AccessOutcome;detail?:string;identity?:Identity;workroomId?:string|null;}
/** Bound by the routes layer; absent in tests or before mount, in which case every participant is `unverified`. */
export interface ParticipantAuthority {check(subject:string):Promise<ParticipantCheck>;}
export interface Viewer {subject:string;workroomId:string|null;}
/** Fresh identity plus the workroom it was resolved in. Routes build it per request; never from a body. */
export interface FreshIdentity {identity:Identity;workroomId:string|null;}
export interface MembershipMemberView {subject:string;name:string;organization:string;role:'owner'|'participant';roleAtJoin:MembershipSeat;status:'active'|'withdrawn'|'revoked';since:MissionPoint|null;until:MissionPoint|null;rejoinRequired:boolean;}
export interface MembershipMissionView {missionIndex:number;exerciseId:string;status:string|null;carried:string[]|null;excluded:{subject:string;outcome:'denied'|'unavailable';detail:string|null}[]|null;recorded:boolean;detached:boolean;}
export interface MembershipView {
 version:number;maxParticipants:number;activeParticipants:number;currentPoint:MissionPoint;
 viewer:{subject:string;role:'owner'|'participant';status:'active'|'withdrawn'|'revoked';canManage:boolean};
 members:MembershipMemberView[];missions:MembershipMissionView[];
 /** Present when the campaign is stopped/completed/faulted while its last mission still runs as an ordinary exercise. */
 detached:{exerciseId:string;note:string}|null;
 limits:string[];
}
/** Output of the asynchronous decision phase; consumed once inside the attach transaction. */
export interface MissionPlan {campaignId:string;missionIndex:number;version:number;decisions:AccessDecision[];identities:Map<string,Identity>;owner:Identity;}

const TERMINAL=new Set(['completed','stopped','fault']);
const CODE_TTL_MS=24*60*60*1000;
const now=()=>new Date().toISOString();
const seatOf=(identity:Identity,workroomId:string|null):MemberIdentity=>({subject:identity.subject,name:identity.name,organization:identity.organization,roleAtJoin:identity.role,workroomId});

export class CampaignMembershipService {
 readonly repo:CampaignMembershipStore;
 private authority:ParticipantAuthority|null=null;
 /** Runtime only: last session id seen for a subject on a campaign route in this process. Lost on restart. */
 private sessions=new Map<string,string>();
 constructor(readonly service:GameService,readonly ledger:CampaignStore){this.repo=new CampaignMembershipStore(service.store);}
 useAuthority(authority:ParticipantAuthority){this.authority=authority;}
 touch(subject:string,sessionId:string){if(subject&&sessionId)this.sessions.set(subject,sessionId);}
 sessionFor(subject:string):string|null{return this.sessions.get(subject)??null;}
 forgetSession(subject:string){this.sessions.delete(subject);}

 /** Membership for a campaign, creating the owner-only record for campaigns that predate shared enrollment. */
 ensure(state:CampaignSession,owner?:Identity):CampaignMembership{
  const identity:MemberIdentity=owner&&owner.subject===state.ownerSubject?seatOf(owner,state.workroomId):{subject:state.ownerSubject,name:'Campaign owner',organization:'Not recorded',roleAtJoin:'unknown',workroomId:state.workroomId};
  return this.repo.ensure({campaignId:state.id,owner:identity});
 }
 /** The dated point "now" for this campaign: the running mission's canonical tick, or the start of the next mission. */
 currentPoint(state:CampaignSession):MissionPoint{
  const last=state.missions.at(-1);
  if(last&&!last.end){
   const tick=this.service.worlds.get(last.exerciseId)?.engine.game.ticks()??this.service.store.turns(last.exerciseId).at(-1)?.tick??last.startTick;
   return {missionIndex:last.reservation.index,tick:Math.max(last.startTick,tick)};
  }
  return missionStart(state.missions.length);
 }
 /** Read rule used by the ledger's `loadFor`/`listFor`: owner or active member at/after the current point. */
 canRead(state:CampaignSession,subject:string):boolean{
  if(state.ownerSubject===subject)return true;
  const m=this.repo.load(state.id);return !!m&&mayRead(m,subject,this.currentPoint(state));
 }
 isOwner(state:CampaignSession,viewer:Viewer){return state.ownerSubject===viewer.subject&&state.workroomId===viewer.workroomId;}
 private requireOwner(state:CampaignSession,actor:FreshIdentity){
  if(actor.identity.subject!==state.ownerSubject||actor.workroomId!==state.workroomId)throw new ServiceError(403,'Only the campaign owner in its workroom can change campaign membership');
 }
 private activeMission(state:CampaignSession):ExerciseRow|null{
  const last=state.missions.at(-1);if(!last||last.end)return null;
  const row=this.service.store.exercise(last.exerciseId);return row&&row.status==='running'?row:null;
 }

 // ---- invitations -------------------------------------------------------------------------------
 /** Opaque campaign invite. Owner only, non-terminal campaign, rotates any earlier code. */
 issueCode(state:CampaignSession,issuer:FreshIdentity):{code:string;expiresAt:string}{
  this.requireOwner(state,issuer);
  if(TERMINAL.has(state.status))throw new ServiceError(409,`Campaign is ${state.status}; it no longer accepts participants`);
  const code=randomBytes(16).toString('hex'),expiresAt=new Date(Date.now()+CODE_TTL_MS).toISOString();
  this.service.store.transaction(()=>{
   this.revokeCodes(state.id);
   this.service.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(this.codeKey(code),JSON.stringify({campaignId:state.id,workroomId:state.workroomId,issuer:issuer.identity.subject,expiresAt}));
   const row=this.activeMission(state);if(row)this.service.store.event(row.id,this.tickOf(row),'campaign_enrollment_opened',issuer.identity.subject,'Campaign invite code created',{campaignId:state.id,expiresAt});
  });
  return {code,expiresAt};
 }
 /** Resolve an invite to its campaign for a joiner resolved in `workroomId`. Anything else is one 404. */
 lookupCode(code:string,workroomId:string|null):CampaignSession{
  const entry=this.service.store.db.prepare('SELECT value FROM settings WHERE key=?').get(this.codeKey(code.trim().toLowerCase())) as {value:string}|undefined;
  const body=entry?JSON.parse(entry.value) as {campaignId:string;workroomId:string|null;expiresAt:string}:null;
  const fail=()=>new ServiceError(404,'Campaign code is invalid, expired, or unavailable in this workroom');
  if(!body||body.workroomId!==workroomId||Date.parse(body.expiresAt)<=Date.now())throw fail();
  // The code itself is the admission; the workroom must still match the joiner's own fresh resolution.
  let state:CampaignSession;try{state=this.ledger.loadFor(body.campaignId,{subject:'',workroomId},()=>true);}catch{throw fail();}
  if(TERMINAL.has(state.status))throw fail();
  return state;
 }

 // ---- membership mutations ----------------------------------------------------------------------
 /**
  * Explicit join by the resolved subject. Membership is written first (durable roster), then a seat on the
  * running mission if there is one. Re-joining while active is a no-op on membership but still restores a
  * missing seat, which is the recovery path after an `unavailable`/`denied` exclusion.
  */
 join(state:CampaignSession,joiner:FreshIdentity):{membership:CampaignMembership;seat:ExerciseParticipant|null;activeExerciseId:string|null;joined:boolean}{
  if(TERMINAL.has(state.status))throw new ServiceError(409,`Campaign is ${state.status}; it no longer accepts participants`);
  if(!joiner.identity.subject)throw new ServiceError(401,'Sign in to join a campaign');
  this.ensure(state);
  const point=this.currentPoint(state),at=now(),subject=joiner.identity.subject;
  const before=this.repo.require(state.id);
  return this.service.store.transaction(()=>{
  const membership=this.repo.write(state.id,m=>enrollParticipant(m,{identity:seatOf(joiner.identity,joiner.workroomId),actor:subject,at,effective:point}));
  const joined=membership.version!==before.version;
  const row=this.activeMission(state);let seat:ExerciseParticipant|null=null;
  if(row){
   const already=this.service.teams.includes(row,subject),tick=this.tickOf(row);
   seat=this.service.teams.carry(row,state.id,{subject,name:joiner.identity.name,organization:joiner.identity.organization,roleAtJoin:joiner.identity.role,source:'campaign-join',membershipVersion:membership.version},tick);
   if(!already)this.service.store.event(row.id,tick,'participant_joined',subject,'Participant joined the campaign mission',{subject,roleAtJoin:seat.roleAtJoin,joinedTick:seat.joinedTick,source:'campaign-join',campaignId:state.id,membershipVersion:membership.version},row.humanSide);
  }
  return {membership,seat,activeExerciseId:row?.id??null,joined};
  });
 }
 /** Self-withdrawal: membership, current seat and their audit commit together. */
 withdraw(state:CampaignSession,actor:FreshIdentity):CampaignMembership{
  const subject=actor.identity.subject;this.ensure(state);
  let removedFrom:string|null=null;
  const membership=this.service.store.transaction(()=>{
   const m=this.repo.write(state.id,x=>withdrawParticipant(x,{subject,at:now(),effective:this.currentPoint(state)}));
   removedFrom=this.unseat(state,subject,subject,'campaign_participant_withdrawn','Participant withdrew from the campaign; prior evidence retained');
   return m;
  });
  if(removedFrom)this.service.dropParticipantAuthorities(removedFrom,subject);
  return membership;
 }
 /** Owner removal also rotates invitations in the same transaction. */
 revoke(state:CampaignSession,subject:string,actor:FreshIdentity):CampaignMembership{
  this.requireOwner(state,actor);this.ensure(state);
  let removedFrom:string|null=null;
  const membership=this.service.store.transaction(()=>{
   const m=this.repo.write(state.id,x=>revokeParticipant(x,{subject,actor:actor.identity.subject,at:now(),effective:this.currentPoint(state)}));
   this.revokeCodes(state.id);
   removedFrom=this.unseat(state,subject,actor.identity.subject,'campaign_participant_revoked','Participant removed from the campaign by its owner; prior evidence retained');
   return m;
  });
  if(removedFrom)this.service.dropParticipantAuthorities(removedFrom,subject);
  return membership;
 }
 /**
  * Owner lifts a removal. The subject is not re-seated: they rejoin with a current invite code and their own
  * fresh identity, which is the only consented, freshly-resolved way back in without a per-subject resolver.
  */
 lift(state:CampaignSession,subject:string,actor:FreshIdentity):CampaignMembership{
  this.requireOwner(state,actor);this.ensure(state);
  return this.repo.mutate(state.id,m=>liftRevocation(m,{subject,actor:actor.identity.subject,at:now(),effective:this.currentPoint(state)}));
 }
 setLimit(state:CampaignSession,maxParticipants:number,actor:FreshIdentity):CampaignMembership{
  this.requireOwner(state,actor);this.ensure(state);
  return this.repo.mutate(state.id,m=>setParticipantLimit(m,{maxParticipants,actor:actor.identity.subject,at:now()}));
 }
 private unseat(state:CampaignSession,subject:string,removedBy:string,kind:string,summary:string){
  const row=this.activeMission(state)??(()=>{const last=state.missions.at(-1);return last?this.service.store.exercise(last.exerciseId)??null:null;})();
  if(!row||!this.service.teams.participants(row).some(p=>p.subject===subject&&p.active&&!p.owner))return null;
  this.service.teams.remove(row,subject,removedBy,true);
  this.service.store.event(row.id,this.tickOf(row),kind,removedBy,summary,{subject,campaignId:state.id},row.humanSide);
  return row.id;
 }

 // ---- mission creation ----------------------------------------------------------------------------
 /**
  * Asynchronous decision phase before a mission is attached. Owner: `verified` only through the coordinator's
  * fresh authority check performed here. Participants: their own live session if this process has one,
  * otherwise `unverified`. Nothing about the owner's authority is applied to a participant.
  */
 async plan(state:CampaignSession,owner:Identity,authority:CampaignAuthority):Promise<MissionPlan>{
  const index=state.reservation?.index??state.missions.length;
  const membership=this.ensure(state,owner);
  await authority.check({ownerSubject:state.ownerSubject,workroomId:state.workroomId});
  const projection=projectMissionEnrollment(membership,missionStart(index));
  const decisions:AccessDecision[]=[],identities=new Map<string,Identity>();
  for(const m of projection.members){
   if(m.subject===state.ownerSubject){decisions.push({subject:m.subject,outcome:'verified',detail:'fresh owner authority check'});identities.set(m.subject,owner);continue;}
   const d=await this.checkParticipant(m.subject,membership);
   decisions.push({subject:m.subject,outcome:d.outcome,detail:d.detail});if(d.identity)identities.set(m.subject,d.identity);
  }
  return {campaignId:state.id,missionIndex:index,version:membership.version,decisions,identities,owner};
 }
 private async checkParticipant(subject:string,membership:CampaignMembership):Promise<ParticipantCheck>{
  if(!this.authority)return {outcome:'unverified',detail:'No per-participant fresh check is available in this process; seat is record-only and gated at access time'};
  try{
   const r=await this.authority.check(subject);
   if(r.outcome==='verified'){
    if(!r.identity||r.identity.subject!==subject)return {outcome:'unverified',detail:'Live session no longer belongs to this subject'};
    if((r.workroomId??null)!==membership.scope.workroomId)return {outcome:'denied',detail:'Subject resolved outside the campaign workroom'};
   }
   return r;
  }catch(e){return {outcome:'unavailable',detail:`Fresh check failed: ${String((e as Error).message).slice(0,120)}`};}
 }
 /**
  * Runs inside the attach transaction. Compare-and-swap on the membership version the plan reasoned about;
  * a changed roster is an `AttachRaceError` so the coordinator recomputes instead of carrying a stale set.
  * Seats are written for carried subjects only; excluded subjects get a durable exercise event and no seat.
  */
 commitMission(attached:CampaignSession,row:ExerciseRow,plan:MissionPlan):void{
  const mission=attached.missions.at(-1);if(!mission||mission.exerciseId!==row.id||mission.reservation.index!==plan.missionIndex)throw new AttachRaceError('Mission plan does not match the attached mission');
  const before=this.repo.require(attached.id);assertCarryoverTarget(before,row);
  let next:CampaignMembership;
  try{next=this.repo.write(attached.id,m=>recordMissionEnrollment(m,{missionIndex:plan.missionIndex,exerciseId:row.id,at:now(),actor:plan.owner.subject,decisions:plan.decisions}),plan.version);}
  catch(e){if(e instanceof MembershipStoreError&&e.status===409)throw new AttachRaceError('Campaign membership changed during mission preparation');if(e instanceof MembershipError&&e.status===409)throw new AttachRaceError(e.message);throw e;}
  const record=next.missions.find(m=>m.exerciseId===row.id)!;
  this.service.teams.enroll(row,plan.owner,mission.startTick);
  for(const subject of record.carried){
   if(subject===attached.ownerSubject)continue;
   const member=next.members.find(m=>m.subject===subject)!,fresh=plan.identities.get(subject);
   this.service.teams.carry(row,attached.id,{subject,name:fresh?.name??member.name,organization:fresh?.organization??member.organization,roleAtJoin:fresh?.role??'unknown',source:'campaign-carryover',membershipVersion:next.version},mission.startTick);
  }
  for(const x of record.excluded)this.service.store.event(row.id,mission.startTick,'campaign_participant_excluded','campaign','Campaign participant not seated on this mission after a fresh access check',{campaignId:attached.id,subject:x.subject,outcome:x.outcome,detail:x.detail,membershipUnchanged:true});
  const carriedParticipants=record.carried.filter(s=>s!==attached.ownerSubject);
  if(carriedParticipants.length||record.excluded.length)this.service.store.event(row.id,mission.startTick,'campaign_membership_carried','campaign',`Campaign membership carried into mission ${plan.missionIndex+1}: ${carriedParticipants.length} participant seat(s), ${record.excluded.length} excluded`,{campaignId:attached.id,membershipVersion:next.version,carried:record.carried,excluded:record.excluded.map(x=>x.subject),basis:'consented campaign membership terms; no previous exercise roster, branch, dossier or controller setting'});
 }

 // ---- read projection -----------------------------------------------------------------------------
 view(state:CampaignSession,viewer:Viewer):MembershipView{
  const m=this.ensure(state),point=this.currentPoint(state),me=m.members.find(x=>x.subject===viewer.subject);
  const canManage=this.isOwner(state,viewer);
  const members:MembershipMemberView[]=m.members.map(x=>{
   const current=x.terms.find(t=>comparePoints(t.from,point)<=0&&(!t.to||comparePoints(point,t.to)<0)),future=x.terms.find(t=>comparePoints(point,t.from)<0),term=current??future??x.terms.at(-1)??null;
   const lifted=x.status==='withdrawn'&&[...m.events].reverse().find(e=>e.subject===x.subject&&['revocation-lifted','withdrawn','rejoined','enrolled','revoked'].includes(e.kind))?.kind==='revocation-lifted';
   return {subject:x.subject,name:x.name,organization:x.organization,role:x.role,roleAtJoin:x.roleAtJoin,status:x.status,since:term?.from??null,until:term?.to??null,rejoinRequired:lifted};
  });
  const terminal=TERMINAL.has(state.status);
  const missions:MembershipMissionView[]=state.missions.map(mission=>{
   const record=m.missions.find(r=>r.exerciseId===mission.exerciseId)??null,row=this.service.store.exercise(mission.exerciseId);
   return {missionIndex:mission.reservation.index,exerciseId:mission.exerciseId,status:row?.status??null,carried:record?.carried??null,excluded:record?.excluded??null,recorded:!!record,detached:terminal&&!mission.end&&row?.status==='running'};
  });
  const det=missions.find(x=>x.detached);
  const limits=['Seats come from consented campaign membership only; each access is still gated by that participant\'s own native resolution (ordinary reads may use the short platform cache).'];
  if(!this.authority)limits.push('No per-participant fresh check is bound in this process: participants are carried as record-only (unverified) at mission creation.');
  if(missions.some(x=>!x.recorded))limits.push('Missions created before shared enrollment have no membership record; only the owner was seated on them.');
  return {version:m.version,maxParticipants:m.maxParticipants,activeParticipants:m.members.filter(x=>x.role==='participant'&&x.status==='active').length,currentPoint:point,
   viewer:{subject:viewer.subject,role:me?.role??'participant',status:me?.status??'withdrawn',canManage},members,missions,
   detached:det?{exerciseId:det.exerciseId,note:`Campaign ${state.status}: mission ${det.missionIndex+1} continues as an ordinary exercise. Membership no longer carries into any new mission; seats on it change only by explicit withdrawal or removal.`}:null,limits};
 }

 private tickOf(row:ExerciseRow){return this.service.worlds.get(row.id)?.engine.game.ticks()??this.service.store.turns(row.id).at(-1)?.tick??1;}
 private codeKey(code:string){return `campaign.join-code:${createHash('sha256').update(code).digest('hex')}`;}
 private revokeCodes(campaignId:string){this.service.store.db.prepare("DELETE FROM settings WHERE key LIKE 'campaign.join-code:%' AND json_extract(value,'$.campaignId')=?").run(campaignId);}
}
