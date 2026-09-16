/**
 * Pure campaign membership kernel.
 *
 * Records who belongs to a campaign over time and projects which subjects may be carried into a
 * future mission. It holds no authorization, persistence, native lookup or exercise state:
 *  - membership never grants a native role or capability; every carried subject is still gated by
 *    a fresh native identity/workroom resolution at request time,
 *  - `roleAtJoin` is a historical label copied at enrollment and is never used for decisions,
 *  - the membership version is independent of the campaign ledger revision (`CampaignSession`),
 *  - nothing here reads learning records; membership shares no personal dossier.
 *
 * Every mutation is either a no-op (same state object returned), a new state with `version+1` and
 * one appended event, or a thrown conflict. Effective points order by mission index then tick.
 */
export type MembershipSeat='commander'|'intelligence'|'instructor'|'unknown';
export interface MembershipScope {ownerSubject:string;workroomId:string|null;}
export interface MissionPoint {missionIndex:number;tick:number;}
export interface MembershipTerm {from:MissionPoint;startedAt:string;startedBy:string;to?:MissionPoint;endedAt?:string;endedBy?:string;endReason?:'withdrawn'|'revoked';}
export interface CampaignMember {
 subject:string;role:'owner'|'participant';name:string;organization:string;
 /** Historical context only: the seat the subject held when enrolled. Never an authorization input. */
 roleAtJoin:MembershipSeat;
 status:'active'|'withdrawn'|'revoked';terms:MembershipTerm[];
}
export type MembershipEventKind='created'|'enrolled'|'rejoined'|'withdrawn'|'revoked'|'reinstated'|'revocation-lifted'|'limit-changed'|'mission-enrolled';
export interface MembershipEvent {version:number;kind:MembershipEventKind;subject:string|null;actor:string;at:string;effective:MissionPoint|null;details:Record<string,unknown>;}
/** Fresh native outcome per projected member at mission creation. `unverified` = no live check was possible; record-only carry. */
export type AccessOutcome='verified'|'unverified'|'denied'|'unavailable';
export interface AccessDecision {subject:string;outcome:AccessOutcome;detail?:string;}
export interface MissionEnrollmentRecord {missionIndex:number;exerciseId:string;at:string;actor:string;carried:string[];excluded:{subject:string;outcome:'denied'|'unavailable';detail:string|null}[];}
export interface CampaignMembership {
 schema:'replay.campaign-membership/1';campaignId:string;scope:MembershipScope;version:number;maxParticipants:number;
 members:CampaignMember[];missions:MissionEnrollmentRecord[];events:MembershipEvent[];
}
export interface ProjectedMember {subject:string;role:CampaignMember['role'];name:string;organization:string;roleAtJoin:MembershipSeat;since:MissionPoint;}
export interface MissionEnrollmentProjection {campaignId:string;scope:MembershipScope;at:MissionPoint;members:ProjectedMember[];absent:{subject:string;status:CampaignMember['status'];until:MissionPoint|null}[];}

/** Participants excluding the owner. Sixteen seats total matches the exercise team cap. */
export const PARTICIPANT_CEILING=15;
export const DEFAULT_PARTICIPANT_LIMIT=15;
export class MembershipError extends Error {constructor(readonly status:400|403|404|409,message:string){super(message);this.name='MembershipError';}}

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const iso=(at:string)=>{if(typeof at!=='string'||Number.isNaN(Date.parse(at)))throw new MembershipError(400,'A dated ISO timestamp is required');return at;};
const subj=(s:string,what='Subject')=>{if(typeof s!=='string'||!s.trim())throw new MembershipError(400,`${what} identity required`);return s;};
export function missionStart(missionIndex:number):MissionPoint{return{missionIndex,tick:1};}
export function validPoint(p:MissionPoint):MissionPoint{
 if(!p||!Number.isSafeInteger(p.missionIndex)||p.missionIndex<0||!Number.isSafeInteger(p.tick)||p.tick<0)throw new MembershipError(400,'Effective point needs a nonnegative mission index and canonical tick');
 return{missionIndex:p.missionIndex,tick:p.tick};
}
export function comparePoints(a:MissionPoint,b:MissionPoint):number{return a.missionIndex-b.missionIndex||a.tick-b.tick;}
/** A term covers [from, to). */
export function termCovers(term:MembershipTerm,p:MissionPoint):boolean{return comparePoints(term.from,p)<=0&&(!term.to||comparePoints(p,term.to)<0);}
/**
 * The latest dated point recorded for a subject: term boundaries plus every dated event naming the subject
 * (a revocation of an already-withdrawn member closes no term but is still a recorded point). Every later
 * mutation must take effect at or after it, so nothing can be backdated behind an earlier decision.
 */
export function latestRecordedPoint(state:CampaignMembership,subject:string):MissionPoint{
 let latest=missionStart(0);
 const consider=(p:MissionPoint|null|undefined)=>{if(p&&comparePoints(p,latest)>0)latest=p;};
 for(const t of findMember(state,subject)?.terms??[]){consider(t.from);consider(t.to);}
 for(const e of state.events)if(e.subject===subject)consider(e.effective);
 return latest;
}
const activeParticipants=(s:CampaignMembership)=>s.members.filter(m=>m.role==='participant'&&m.status==='active').length;
const findMember=(s:CampaignMembership,subject:string)=>s.members.find(m=>m.subject===subject);
function append(state:CampaignMembership,members:CampaignMember[],event:Omit<MembershipEvent,'version'>,changes:Partial<Pick<CampaignMembership,'missions'|'maxParticipants'>>={}):CampaignMembership{
 const version=state.version+1;return{...state,...changes,version,members,events:[...state.events,{version,...event}]};
}
function replace(state:CampaignMembership,member:CampaignMember){return state.members.map(m=>m.subject===member.subject?member:m);}
function limit(n:number){if(!Number.isSafeInteger(n)||n<0||n>PARTICIPANT_CEILING)throw new MembershipError(400,`Participant limit must be an integer from 0 to ${PARTICIPANT_CEILING}`);return n;}
function notBefore(state:CampaignMembership,subject:string,effective:MissionPoint,what:string){if(comparePoints(effective,latestRecordedPoint(state,subject))<0)throw new MembershipError(409,`${what} cannot take effect before the member's latest recorded point`);}

export interface MemberIdentity {subject:string;name:string;organization:string;roleAtJoin:MembershipSeat;/** Workroom from the fresh native resolution of this subject. */workroomId:string|null;}
export function newMembership(input:{campaignId:string;owner:MemberIdentity;at:string;maxParticipants?:number}):CampaignMembership{
 const campaignId=subj(input.campaignId,'Campaign'),owner=input.owner,at=iso(input.at);subj(owner.subject,'Owner');
 const scope:MembershipScope={ownerSubject:owner.subject,workroomId:owner.workroomId??null};
 const member:CampaignMember={subject:owner.subject,role:'owner',name:owner.name,organization:owner.organization,roleAtJoin:owner.roleAtJoin,status:'active',terms:[{from:missionStart(0),startedAt:at,startedBy:owner.subject}]};
 const maxParticipants=limit(input.maxParticipants??DEFAULT_PARTICIPANT_LIMIT);
 return{schema:'replay.campaign-membership/1',campaignId,scope,version:1,maxParticipants,members:[member],missions:[],events:[{version:1,kind:'created',subject:owner.subject,actor:owner.subject,at,effective:missionStart(0),details:{maxParticipants}}]};
}
/** Explicit enrollment by a signed-in subject in the campaign's workroom. Re-enrolling an active member is a no-op; a withdrawn member rejoins; a revoked member needs `reinstateParticipant`. */
export function enrollParticipant(state:CampaignMembership,input:{identity:MemberIdentity;actor:string;at:string;effective:MissionPoint}):CampaignMembership{
 const id=input.identity,effective=validPoint(input.effective),at=iso(input.at),actor=subj(input.actor,'Actor');subj(id.subject);
 if((id.workroomId??null)!==state.scope.workroomId)throw new MembershipError(403,'Subject resolved outside the campaign workroom');
 if(id.subject===state.scope.ownerSubject)throw new MembershipError(409,'The campaign owner is already a member and cannot enroll as a participant');
 const existing=findMember(state,id.subject);
 if(existing?.status==='active')return state;
 if(existing?.status==='revoked')throw new MembershipError(409,'Subject was removed from this campaign; reinstatement must be explicit');
 if(activeParticipants(state)>=state.maxParticipants)throw new MembershipError(409,`This campaign already has ${state.maxParticipants} participants`);
 const term:MembershipTerm={from:effective,startedAt:at,startedBy:actor};
 if(existing){
  notBefore(state,existing.subject,effective,'Rejoin');
  const member:CampaignMember={...existing,name:id.name,organization:id.organization,roleAtJoin:id.roleAtJoin,status:'active',terms:[...existing.terms,term]};
  return append(state,replace(state,member),{kind:'rejoined',subject:id.subject,actor,at,effective,details:{term:existing.terms.length+1}});
 }
 const member:CampaignMember={subject:id.subject,role:'participant',name:id.name,organization:id.organization,roleAtJoin:id.roleAtJoin,status:'active',terms:[term]};
 return append(state,[...state.members,member],{kind:'enrolled',subject:id.subject,actor,at,effective,details:{term:1}});
}
function endTerm(state:CampaignMembership,subject:string,input:{actor:string;at:string;effective:MissionPoint},reason:'withdrawn'|'revoked'):CampaignMembership{
 const member=findMember(state,subject),effective=validPoint(input.effective),at=iso(input.at);
 if(!member)throw new MembershipError(404,'Campaign member not found');
 if(member.role==='owner')throw new MembershipError(409,'The campaign owner cannot be withdrawn or revoked');
 if(member.status===reason)return state;
 // Monotonic for every status: revoking an already-withdrawn member closes no term but is still a dated
 // decision that later reinstatement/rejoin must not precede.
 notBefore(state,subject,effective,reason==='withdrawn'?'Withdrawal':'Revocation');
 const open=member.status==='active';
 const terms=open?member.terms.map((t,i)=>i===member.terms.length-1?{...t,to:effective,endedAt:at,endedBy:input.actor,endReason:reason}:t):member.terms;
 return append(state,replace(state,{...member,status:reason,terms}),{kind:reason,subject,actor:input.actor,at,effective,details:{previousStatus:member.status}});
}
/** Self-withdrawal: effective from the given point, so the current mission history stays and later missions exclude the subject. */
export function withdrawParticipant(state:CampaignMembership,input:{subject:string;at:string;effective:MissionPoint}):CampaignMembership{
 const subject=subj(input.subject),member=findMember(state,subject);
 if(member?.status==='revoked')throw new MembershipError(409,'A removed member cannot withdraw; the removal already ended membership');
 return endTerm(state,subject,{...input,actor:subject},'withdrawn');
}
/** Removal by someone other than the subject (owner/instructor authority is the service's check). Blocks rejoin until explicitly reinstated. */
export function revokeParticipant(state:CampaignMembership,input:{subject:string;actor:string;at:string;effective:MissionPoint}):CampaignMembership{
 const subject=subj(input.subject),actor=subj(input.actor,'Actor');
 if(actor===subject)throw new MembershipError(409,'Use withdrawal to leave a campaign; revocation is another actor\'s decision');
 return endTerm(state,subject,{...input,actor},'revoked');
}
/** Lifts a revocation and opens a new term. Only valid for revoked members; withdrawn members rejoin through `enrollParticipant`. */
export function reinstateParticipant(state:CampaignMembership,input:{identity:MemberIdentity;actor:string;at:string;effective:MissionPoint}):CampaignMembership{
 const id=input.identity,member=findMember(state,subj(id.subject)),actor=subj(input.actor,'Actor'),effective=validPoint(input.effective),at=iso(input.at);
 if(!member)throw new MembershipError(404,'Campaign member not found');
 if(member.status==='active')return state;
 if(member.status!=='revoked')throw new MembershipError(409,'Only a removed member can be reinstated');
 if(actor===id.subject)throw new MembershipError(409,'A removed member cannot reinstate themselves');
 if((id.workroomId??null)!==state.scope.workroomId)throw new MembershipError(403,'Subject resolved outside the campaign workroom');
 if(activeParticipants(state)>=state.maxParticipants)throw new MembershipError(409,`This campaign already has ${state.maxParticipants} participants`);
 notBefore(state,id.subject,effective,'Reinstatement');
 const next:CampaignMember={...member,name:id.name,organization:id.organization,roleAtJoin:id.roleAtJoin,status:'active',terms:[...member.terms,{from:effective,startedAt:at,startedBy:actor}]};
 return append(state,replace(state,next),{kind:'reinstated',subject:id.subject,actor,at,effective,details:{term:next.terms.length}});
}
/**
 * Lifts a revocation without re-enrolling: the member becomes `withdrawn` and may rejoin explicitly through
 * `enrollParticipant` with their own fresh identity. This is the consented recovery path when nobody can
 * resolve the removed subject's native identity freshly on their behalf. No term opens here.
 */
export function liftRevocation(state:CampaignMembership,input:{subject:string;actor:string;at:string;effective:MissionPoint}):CampaignMembership{
 const subject=subj(input.subject),member=findMember(state,subject),actor=subj(input.actor,'Actor'),effective=validPoint(input.effective),at=iso(input.at);
 if(!member)throw new MembershipError(404,'Campaign member not found');
 if(member.status!=='revoked')return state;
 if(actor===subject)throw new MembershipError(409,'A removed member cannot lift their own removal');
 notBefore(state,subject,effective,'Lifting a removal');
 return append(state,replace(state,{...member,status:'withdrawn'}),{kind:'revocation-lifted',subject,actor,at,effective,details:{rejoinRequired:true}});
}
export function setParticipantLimit(state:CampaignMembership,input:{maxParticipants:number;actor:string;at:string}):CampaignMembership{
 const maxParticipants=limit(input.maxParticipants),at=iso(input.at),actor=subj(input.actor,'Actor');
 if(maxParticipants===state.maxParticipants)return state;
 if(maxParticipants<activeParticipants(state))throw new MembershipError(409,'Limit is below the current active participant count; remove participants first');
 return append(state,state.members,{kind:'limit-changed',subject:null,actor,at,effective:null,details:{from:state.maxParticipants,to:maxParticipants}},{maxParticipants});
}
export function isMemberAt(state:CampaignMembership,subject:string,point:MissionPoint):boolean{
 const p=validPoint(point);return findMember(state,subject)?.terms.some(t=>termCovers(t,p))??false;
}
/** Who may be carried into the mission starting at `point`. Derived from membership terms only, never from a prior exercise's participant table. */
export function projectMissionEnrollment(state:CampaignMembership,point:MissionPoint):MissionEnrollmentProjection{
 const at=validPoint(point),members:ProjectedMember[]=[],absent:MissionEnrollmentProjection['absent']=[];
 for(const m of state.members){
  const term=m.terms.find(t=>termCovers(t,at));
  if(term)members.push({subject:m.subject,role:m.role,name:m.name,organization:m.organization,roleAtJoin:m.roleAtJoin,since:term.from});
  else{const future=m.terms.find(t=>comparePoints(at,t.from)<0);absent.push({subject:m.subject,status:m.status,until:future?future.from:null});}
 }
 return{campaignId:state.campaignId,scope:{...state.scope},at,members,absent};
}
/** Minimal shape of an exercise record a mission may carry membership into. */
export interface CarryoverTarget {id:string;kind:string;parentId?:string|null;options?:{campaignId?:unknown;ownerSubject?:unknown;workroomId?:unknown}|null;}
/** Refuses private branches, forks and anything outside this campaign's owner/workroom. */
export function assertCarryoverTarget(state:CampaignMembership,row:CarryoverTarget):void{
 if(row.kind==='branch'||row.parentId)throw new MembershipError(403,'Membership is never carried into a private branch or forked exercise');
 if(row.options?.campaignId!==state.campaignId)throw new MembershipError(403,'Exercise does not belong to this campaign');
 if(row.options?.ownerSubject!==state.scope.ownerSubject||(row.options?.workroomId??null)!==state.scope.workroomId)throw new MembershipError(403,'Exercise is outside the campaign owner/workroom scope');
}
/**
 * Records the dated enrollment outcome for one created mission. Requires one fresh access decision per
 * projected member: the owner must be `verified`; participants are carried when `verified` or `unverified`
 * (record-only, gated at access time) and excluded, without changing membership, when `denied` or `unavailable`.
 * Same mission/exercise/outcome is a no-op; any difference is a conflict.
 */
export function recordMissionEnrollment(state:CampaignMembership,input:{missionIndex:number;exerciseId:string;at:string;actor:string;decisions:AccessDecision[]}):CampaignMembership{
 const point=missionStart(validPoint({missionIndex:input.missionIndex,tick:1}).missionIndex),at=iso(input.at),actor=subj(input.actor,'Actor'),exerciseId=subj(input.exerciseId,'Exercise');
 const projection=projectMissionEnrollment(state,point),expected=new Set(projection.members.map(m=>m.subject)),decided=new Map<string,AccessDecision>();
 for(const d of input.decisions){
  if(!expected.has(d.subject))throw new MembershipError(409,`Access decision for ${d.subject} does not match a projected member`);
  if(decided.has(d.subject))throw new MembershipError(409,`Duplicate access decision for ${d.subject}`);decided.set(d.subject,d);
 }
 const missing=[...expected].filter(s=>!decided.has(s));
 if(missing.length)throw new MembershipError(409,`Every projected member needs an explicit access decision; missing ${missing.join(', ')}`);
 // Membership order, not decision order, so a redelivered record compares equal regardless of input order.
 const carried:string[]=[],excluded:MissionEnrollmentRecord['excluded']=[];
 for(const m of projection.members){
  const d=decided.get(m.subject)!;
  if(m.subject===state.scope.ownerSubject){if(d.outcome!=='verified')throw new MembershipError(403,'Mission creation requires the owner\'s fresh native write authority');carried.push(m.subject);continue;}
  if(d.outcome==='verified'||d.outcome==='unverified')carried.push(m.subject);
  else excluded.push({subject:m.subject,outcome:d.outcome,detail:d.detail??null});
 }
 const record:MissionEnrollmentRecord={missionIndex:point.missionIndex,exerciseId,at,actor,carried,excluded};
 const prior=state.missions.find(m=>m.missionIndex===point.missionIndex||m.exerciseId===exerciseId);
 if(prior){
  const {at:_a,actor:_b,...p}=prior,{at:_c,actor:_d,...r}=record;
  if(!same(p,r))throw new MembershipError(409,'Conflicting mission enrollment record');return state;
 }
 const last=state.missions.at(-1);
 if(last&&point.missionIndex<=last.missionIndex)throw new MembershipError(409,'Mission enrollment must be recorded in mission order');
 return append(state,state.members,{kind:'mission-enrolled',subject:null,actor,at,effective:point,details:{exerciseId,carried,excluded}},{missions:[...state.missions,record]});
}
/**
 * Read access rule for a campaign: the owner always; a participant while their membership is active and
 * either covers `point` or begins at a later point (joined effective from the next mission). Withdrawn and
 * removed subjects lose read access at once, whatever history they keep on earlier missions.
 */
export function mayRead(state:CampaignMembership,subject:string,point:MissionPoint):boolean{
 const m=findMember(state,subject);if(!m)return false;if(m.role==='owner')return true;
 if(m.status!=='active')return false;const p=validPoint(point);
 return m.terms.some(t=>termCovers(t,p)||comparePoints(p,t.from)<0);
}
