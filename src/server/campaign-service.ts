/**
 * Continuous practice campaign service: real mission creation over the durable reservation
 * coordinator. Native write capabilities live only in this process; the ledger never stores them.
 *
 * Progression is single-flight per campaign. Any failure pauses the campaign with an observable
 * reason (runtime view plus a durable event on the mission) and never retries on its own.
 *
 * Shared play: missions are attributed to the owner and created under the owner's fresh authority.
 * Consented campaign members are seated on each new mission from the dated membership projection
 * (`CampaignMembershipService`), recorded in the same transaction as the ledger attach. Missions
 * carry no other participants' branches, dossiers, paid controller or staff settings.
 */
import {randomUUID} from 'node:crypto';
import {CampaignStore,type CampaignScope} from './campaign-store';
import {CampaignCoordinator,type CampaignAuthority} from './campaign-coordinator';
import {CampaignMembershipService,type MembershipView} from './campaign-membership-service';
import {campaignProgress,stopCampaign,type CampaignSession,type CampaignRules,type MissionReservation} from '../campaign/session';
import {ServiceError,type GameService,type Identity} from './service';
import {SCENARIOS} from '../scenarios/catalog';

/** Fresh native write authority for one browser session. Must consult live platform state on every call. */
export type CampaignResolver=()=>Promise<{identity:Identity;workroomId:string|null}>;
/**
 * The caller's own fresh subject and workroom. For control operations it must equal the campaign owner
 * scope; for reads it may be a consented member. (Field name kept from the owner-only increment.)
 */
export type CampaignViewer=CampaignScope;
export interface CampaignPause {reason:string;at:string|null;}
export interface TransitionNotice {
 missionIndex:number;exerciseId:string;name:string;scenarioId:string;scenarioTitle:string;openedAt:string;freshWorld:true;
 previous:{exerciseId:string;reason:string;elapsedTicks:number}|null;text:string;
}
export interface CampaignView {
 campaign:CampaignSession;enabled:boolean;activeExerciseId:string|null;progress:ReturnType<typeof campaignProgress>;
 transitionNotice:TransitionNotice|null;paused:CampaignPause|null;
 /** Roster, per-mission carry record and the viewer's own standing. Present for owner and members alike. */
 membership:MembershipView;
}
const TERMINAL=new Set(['completed','stopped','fault']);
const scopeOf=(s:CampaignSession):CampaignScope=>({ownerSubject:s.ownerSubject,workroomId:s.workroomId});
const viewerOf=(v:CampaignViewer)=>({subject:v.ownerSubject,workroomId:v.workroomId});

export class CampaignService {
 readonly repo:CampaignStore;readonly coordinator:CampaignCoordinator;readonly members:CampaignMembershipService;
 /** Runtime only: the resolver bound at resume and the identity it most recently returned. */
 private runtime=new Map<string,{resolve:CampaignResolver;identity:Identity}>();
 private paused=new Map<string,CampaignPause>();
 private inflight=new Map<string,Promise<void>>();
 constructor(readonly service:GameService){
  this.repo=new CampaignStore(service.store);
  this.members=new CampaignMembershipService(service,this.repo);
  this.coordinator=new CampaignCoordinator(this.repo,{
   create:(state,reservation,authority)=>this.createMission(state,reservation,authority),
   beforeAttach:async(state,_row,authority)=>{
    const identity=this.runtime.get(state.id)?.identity;
    if(!identity||identity.subject!==state.ownerSubject)throw new Error('Campaign progression paused; resume with current authority');
    const plan=await this.members.plan(state,identity,authority);
    return (attached,row)=>this.members.commitMission(attached,row,plan);
   },
  });
  service.onExerciseEnded.add(row=>{
   const id=row.options?.campaignId;if(typeof id!=='string'||typeof row.options?.ownerSubject!=='string')return;
   void this.kick(id,{ownerSubject:row.options.ownerSubject,workroomId:row.options.workroomId??null},row.id);
  });
 }
 /** Campaigns the viewer owns or is a consented member of, in the viewer's workroom. */
 list(viewer:CampaignViewer){
  const v=viewerOf(viewer);
  return this.repo.listFor(v,s=>this.members.canRead(s,v.subject)).map(s=>({id:s.id,name:s.name,status:s.status,revision:s.revision,missionCount:s.missions.length,playedTicks:s.playedTicks,targetTicks:s.rules.targetTicks,enabled:this.coordinator.enabled(s.id),role:s.ownerSubject===v.subject?'owner' as const:'participant' as const}));
 }
 /** Create the record and immediately start mission one under the caller's fresh authority. */
 async create(input:{name:string;identity:Identity;workroomId:string|null;resolve:CampaignResolver;rules?:CampaignRules}):Promise<CampaignView>{
  const name=input.name.trim().slice(0,100);if(!name)throw new ServiceError(400,'A campaign needs a name');
  if(!input.identity.subject)throw new ServiceError(401,'A signed-in owner is required to start a campaign');
  const state=this.repo.create({id:randomUUID(),name,ownerSubject:input.identity.subject,workroomId:input.workroomId,rules:input.rules});
  this.members.ensure(state,input.identity);
  return this.resume(state.id,scopeOf(state),input.resolve);
 }
 /** Enable progression with a fresh capability, create/attach a reserved mission if due, and reconcile a mission that ended while paused. */
 async resume(id:string,scope:CampaignScope,resolve:CampaignResolver):Promise<CampaignView>{
  const state=this.repo.load(id,scope);
  if(TERMINAL.has(state.status))throw new ServiceError(409,`Campaign is ${state.status} and cannot resume`);
  const fresh=await resolve();
  if(fresh.identity.subject!==scope.ownerSubject||fresh.workroomId!==scope.workroomId)throw new ServiceError(403,'Only the campaign owner in its workroom can resume progression');
  this.runtime.set(id,{resolve,identity:fresh.identity});this.paused.delete(id);
  await this.serial(id,async()=>{
   try{await this.coordinator.resume(id,scope,this.authorityFor(id,resolve));}
   catch(e){this.pauseWith(id,scope,(e as Error).message);throw e;}
  });
  await this.reconcile(id,scope);
  return this.view(id,scope);
 }
 pause(id:string,scope:CampaignScope,reason='Paused by the campaign owner'):CampaignView{
  this.repo.load(id,scope);this.coordinator.pause(id);this.runtime.delete(id);
  this.paused.set(id,{reason,at:new Date().toISOString()});return this.view(id,scope);
 }
 /** Durable stop of progression. The current mission keeps running as an ordinary exercise until it ends or is finished. */
 stop(id:string,scope:CampaignScope):CampaignView{
  const state=this.repo.load(id,scope);this.coordinator.pause(id);this.runtime.delete(id);this.paused.delete(id);
  if(!TERMINAL.has(state.status))this.repo.transition(id,scope,state.revision,'stopped',s=>stopCampaign(s));
  return this.view(id,scope);
 }
 /** Read for the owner or a consented member. Anything else surfaces as the store's scope error (routes map it to 404). */
 view(id:string,viewer:CampaignViewer):CampaignView{
  const v=viewerOf(viewer);
  const state=this.repo.loadFor(id,v,s=>this.members.canRead(s,v.subject)),enabled=this.coordinator.enabled(id);
  const latest=state.missions.at(-1),active=latest&&!latest.end?latest:null;
  const world=active?this.service.worlds.get(active.exerciseId):undefined;
  const progress=campaignProgress(state,active&&world?{exerciseId:active.exerciseId,tick:Math.max(active.startTick,world.engine.game.ticks())}:undefined);
  // A mission ended outside the clock (facilitator finish) is reconciled lazily under the owner's own scope; the read returns at once.
  if(enabled&&active&&world&&world.row.status!=='running')void this.kick(id,scopeOf(state),active.exerciseId);
  const paused=enabled||TERMINAL.has(state.status)?null:this.paused.get(id)??{reason:'Progression is paused until the campaign owner resumes it (server restart or explicit pause)',at:null};
  return {campaign:state,enabled,activeExerciseId:active?.exerciseId??null,progress,transitionNotice:this.notice(state),paused,membership:this.members.view(state,v)};
 }
 /** Owner-only ledger load for membership control routes. */
 owned(id:string,scope:CampaignScope):CampaignSession{return this.repo.load(id,scope);}
 /** Await progression in flight for one campaign (tests, shutdown). */
 settled(id:string):Promise<void>{return this.inflight.get(id)??Promise.resolve();}
 /** A mission that ended while progression was paused is completed now that authority is fresh. */
 private async reconcile(id:string,scope:CampaignScope){
  const state=this.repo.load(id,scope);if(state.status!=='running'||!this.coordinator.enabled(id))return;
  const mission=state.missions.at(-1)!,row=this.service.store.exercise(mission.exerciseId);
  if(row&&row.status!=='running')await this.kick(id,scope,row.id);
 }

 private notice(state:CampaignSession):TransitionNotice|null{
  const m=state.missions.at(-1);if(!m)return null;
  const row=this.service.store.exercise(m.exerciseId),prev=state.missions.at(-2)??null;
  const scenarioTitle=SCENARIOS.find(s=>s.id===m.reservation.scenarioId)?.title??m.reservation.scenarioId,n=m.reservation.index+1;
  const previous=prev?.end?{exerciseId:prev.exerciseId,reason:prev.end.reason,elapsedTicks:prev.end.elapsedTicks}:null;
  const text=`Mission ${n} · ${scenarioTitle} opened with a fresh map and fresh forces.${previous?` Nothing carries over from mission ${n-1}, which ended by ${previous.reason.replace('-',' ')} after ${previous.elapsedTicks} simulated ticks.`:''}${m.end?` This mission has ended (${m.end.reason.replace('-',' ')}).`:''}`;
  return {missionIndex:n,exerciseId:m.exerciseId,name:row?.name??m.exerciseId,scenarioId:m.reservation.scenarioId,scenarioTitle,openedAt:row?.createdAt??'',freshWorld:true,previous,text};
 }
 private authorityFor(id:string,resolve:CampaignResolver):CampaignAuthority{
  return {check:async scope=>{
   const r=await resolve();
   if(r.identity.subject!==scope.ownerSubject||r.workroomId!==scope.workroomId)throw new Error('Native authority no longer matches the campaign owner and workroom');
   const entry=this.runtime.get(id);if(entry&&entry.resolve===resolve)entry.identity=r.identity;
  }};
 }
 /** Create the mission world under the owner's authority. Seats (owner and carried members) are written at attach. */
 private async createMission(state:CampaignSession,reservation:MissionReservation,authority:CampaignAuthority){
  const identity=this.runtime.get(state.id)?.identity;
  if(!identity||identity.subject!==state.ownerSubject)throw new Error('Campaign progression paused; resume with current authority');
  const scope=scopeOf(state);
  return this.service.create(`${state.name} · mission ${reservation.index+1}`,'world',identity,reservation.scenarioId,{campaign:{id:state.id,reservationKey:reservation.key,remainingTicks:reservation.remainingTicks,workroomId:state.workroomId},beforeCommit:()=>authority.check(scope)});
 }
 /** Reconcile one durably ended mission: complete the ledger and open the next mission, or stop on a source fault. */
 private kick(id:string,scope:CampaignScope,exerciseId:string):Promise<void>{
  return this.serial(id,async()=>{
   if(!this.coordinator.enabled(id))return;
   const state=this.repo.load(id,scope),row=this.service.store.exercise(exerciseId);
   if(!row||state.status!=='running'||state.missions.at(-1)?.exerciseId!==exerciseId||row.status==='running')return;
   try{
    if(row.status==='fault'){
     this.coordinator.pause(id);this.repo.transition(id,scope,state.revision,'source-fault',s=>stopCampaign(s,true));
     this.pauseWith(id,scope,'Mission simulation faulted; the campaign stopped and counts no time the simulation never ran');return;
    }
    await this.coordinator.completed(id,scope,exerciseId);
    if(TERMINAL.has(this.repo.load(id,scope).status)){this.coordinator.pause(id);this.runtime.delete(id);}
   }catch(e){this.coordinator.pause(id);this.pauseWith(id,scope,(e as Error).message);}
  }).catch(()=>{/* reason recorded by pauseWith */});
 }
 private pauseWith(id:string,scope:CampaignScope,reason:string){
  const at=new Date().toISOString();this.paused.set(id,{reason,at});
  try{
   const mission=this.repo.load(id,scope).missions.at(-1);if(!mission)return;
   const tick=this.service.worlds.get(mission.exerciseId)?.engine.game.ticks()??this.service.store.turns(mission.exerciseId).at(-1)?.tick??0;
   this.service.store.event(mission.exerciseId,tick,'campaign_progression_paused','campaign','Campaign progression paused; the owner must resume it with current authority',{campaignId:id,reason});
  }catch{/* the runtime reason above remains observable */}
 }
 private serial<T>(id:string,fn:()=>Promise<T>):Promise<T>{
  const prior=this.inflight.get(id)??Promise.resolve();
  const run=prior.then(fn);
  const tail=run.then(()=>{},()=>{});this.inflight.set(id,tail);
  void tail.then(()=>{if(this.inflight.get(id)===tail)this.inflight.delete(id);});
  return run;
 }
}
