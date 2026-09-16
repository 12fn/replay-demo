/**
 * Campaign routes. Mounted by main inside `createApp({mount})` after session middleware, so
 * `res.locals.session` / `res.locals.sessionId` / `res.locals.native` are present and
 * `app.locals.guards` carries the fresh native write guard.
 *
 * Scope: a campaign is readable by its owner and by consented members (fresh membership, current mission
 * point); controllable (pause/resume/stop/limit/invite/revoke/reinstate) solely by its owner subject within
 * the configured workroom. Non-members receive 404 so no other owner's records are even acknowledged;
 * members attempting owner actions receive 403. Subject and workroom are derived from the server-held
 * session and the fresh native resolution, never from the request body.
 *
 * Per-participant fresh checks at mission creation use the last session id seen for that subject on these
 * routes in this process (`members.touch`). There is no subject-to-session index in `NativeSessions`; see
 * docs/process/shared-campaign-service-notes.md for the seam main may add.
 */
import type express from 'express';
import {z} from 'zod';
import {CampaignService,type CampaignResolver} from './campaign-service';
import {CampaignStoreError} from './campaign-store';
import {MembershipStoreError} from './campaign-membership-store';
import type {FreshIdentity,ParticipantAuthority,ParticipantCheck} from './campaign-membership-service';
import {MembershipError} from '../campaign/enrollment';
import {ServiceError,type Session} from './service';
import {LoginRateLimiter,type AuthGuards,type NativeSessionPort} from './native-http';
import {NativeSessionError} from './native-session';
import {TeamError} from './exercise-teams';

interface NativeLocals {identity?:{subject?:string};context?:{canEdit?:boolean;canShare?:boolean;readOnlyReason?:string|null;workroomId?:string}}
const nameSchema=z.object({name:z.string().trim().min(1).max(100)}).strict();
const codeSchema=z.object({code:z.string().trim().regex(/^[a-f0-9]{32}$/i)}).strict();
const subjectSchema=z.object({subject:z.string().min(1).max(200)}).strict();
const limitSchema=z.object({maxParticipants:z.number().int().min(0).max(15)}).strict();
const idSchema=z.string().regex(/^[a-f0-9-]{36}$/);
const DENIED=new Set(['access_blocked','forbidden','workroom_mismatch']);

export function mountCampaignRoutes(app:express.Express,campaigns:CampaignService,native:NativeSessionPort|null){
 const guards=app.locals.guards as AuthGuards;
 const workroomId=native?.workroomId??null;
 const store=campaigns.service.store;
 const sessionOf=(res:express.Response):Session=>{
  const s=res.locals.session as Session|undefined;
  if(!s||!s.identity||!s.identity.subject)throw new ServiceError(401,'Sign in to use campaigns');
  const n=res.locals.native as NativeLocals|undefined;
  if(n?.identity?.subject&&n.identity.subject!==s.identity.subject)throw new ServiceError(403,'Native identity does not match the session');
  campaigns.members.touch(s.identity.subject,res.locals.sessionId as string);
  return s;
 };
 const requireWrite=(res:express.Response):Session=>{
  const s=sessionOf(res);
  if(s.identity.mode==='kamiwaza'){
   const n=res.locals.native as NativeLocals|undefined;
   if(n?.context?.canEdit!==true)throw new ServiceError(403,`Native workroom context does not permit writes${n?.context?.readOnlyReason?` (${n.context.readOnlyReason})`:''}`);
  }
  return s;
 };
 const requireShare=(res:express.Response):Session=>{
  const s=requireWrite(res);
  if(s.identity.mode==='kamiwaza'&&(res.locals.native as NativeLocals|undefined)?.context?.canShare!==true)throw new ServiceError(403,'The campaign owner needs native sharing permission to invite participants');
  return s;
 };
 /** The caller's fresh identity and the workroom it resolved in (the native middleware refreshed `res.locals.native` for this request). */
 const freshOf=(res:express.Response):FreshIdentity=>{const s=sessionOf(res);return {identity:s.identity,workroomId};};
 const scopeOf=(res:express.Response)=>({ownerSubject:sessionOf(res).identity.subject,workroomId});
 /** Owner check that distinguishes a member (403) from a stranger (404 through the store's scope error). */
 const ownedBy=(req:express.Request,res:express.Response)=>{
  const id=campaignId(req),viewer=scopeOf(res);
  const state=campaigns.repo.loadFor(id,{subject:viewer.ownerSubject,workroomId:viewer.workroomId},s=>campaigns.members.canRead(s,viewer.ownerSubject));
  if(state.ownerSubject!==viewer.ownerSubject)throw new ServiceError(403,'Only the campaign owner can do this');
  return state;
 };
 /** Runtime capability bound to this browser session; each check resolves the platform (or the stored local session) afresh. */
 const resolverFor=(res:express.Response):CampaignResolver=>{
  const sessionId=res.locals.sessionId as string;
  if(native)return async()=>{const r=await native.resolve(sessionId,{requireWrite:true});return {identity:r.identity,workroomId:r.context.workroomId};};
  return async()=>{const s=store.session(sessionId) as Session|null;if(!s?.identity?.subject)throw new Error('Local session ended');return {identity:s.identity,workroomId:null};};
 };
 /**
  * Fresh per-participant check for mission creation, by that subject's own last-seen session in this
  * process. Never falls back to the owner's authority: no session means `unverified`, a platform denial
  * means `denied`, a platform failure means `unavailable`.
  */
 const participants:ParticipantAuthority={check:async(subject):Promise<ParticipantCheck>=>{
  const sessionId=campaigns.members.sessionFor(subject);
  if(!sessionId)return {outcome:'unverified',detail:'No live session for this subject in this process'};
  if(!native){
   const s=store.session(sessionId) as Session|null;
   if(s?.identity?.subject!==subject){campaigns.members.forgetSession(subject);return {outcome:'unverified',detail:'Local session no longer belongs to this subject'};}
   return {outcome:'verified',identity:s.identity,workroomId:null,detail:'stored local session'};
  }
  try{
   const r=await native.resolve(sessionId,{fresh:true});
   if(r.identity.subject!==subject){campaigns.members.forgetSession(subject);return {outcome:'unverified',detail:'Session now belongs to another subject'};}
   if(r.context.accessState!=='active')return {outcome:'denied',detail:`Native workroom access state is ${r.context.accessState}`};
   return {outcome:'verified',identity:r.identity,workroomId:r.context.workroomId,detail:`native context validated at ${r.context.validatedAt}`};
  }catch(e){
   if(e instanceof NativeSessionError){
    if(e.code==='signed_out'||e.code==='subject_mismatch'){campaigns.members.forgetSession(subject);return {outcome:'unverified',detail:`No live native session (${e.code})`};}
    if(DENIED.has(e.code))return {outcome:'denied',detail:e.message};
    return {outcome:'unavailable',detail:e.message};
   }
   return {outcome:'unavailable',detail:String((e as Error)?.message??'fresh check failed').slice(0,160)};
  }
 }};
 campaigns.members.useAuthority(participants);

 const send=(res:express.Response,err:unknown)=>{
  if(err instanceof CampaignStoreError)return res.status(err.status===403?404:err.status).json({error:err.status===403?'Campaign not found':err.message});
  if(err instanceof ServiceError)return res.status(err.status).json({error:err.message,...err.extra});
  if(err instanceof MembershipError||err instanceof MembershipStoreError||err instanceof TeamError)return res.status(err.status).json({error:err.message});
  if(err instanceof NativeSessionError)return res.status(err.httpStatus).json({error:err.message,code:err.code});
  if(err instanceof z.ZodError)return res.status(400).json({error:'Request did not match the expected schema'});
  const message=String((err as Error)?.message??'Campaign request failed').replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');
  return res.status(409).json({error:message});
 };
 const wrap=(h:(req:express.Request,res:express.Response)=>Promise<void>|void):express.RequestHandler=>async(req,res)=>{try{res.setHeader('Cache-Control','private, no-store');await h(req,res);}catch(e){send(res,e);}};
 const campaignId=(req:express.Request)=>idSchema.parse(req.params.id);
 /** Selecting a mission is a navigation commit: bump the session's navigation revision so a stale automatic select is refused. */
 const select=(res:express.Response,session:Session,exerciseId:string,side:'blue'|'red'='blue')=>{
  const id=res.locals.sessionId as string,current=store.session(id) as Session|null;
  // World preparation and native checks can yield. Do not replace newer navigation or a signed-out session.
  if(!current||current.identity.subject!==session.identity.subject||current.activeId!==session.activeId||current.playbackTick!==session.playbackTick||(current.navigationRevision??0)!==(session.navigationRevision??0))return false;
  const next={...current,identity:session.identity,activeId:exerciseId,playbackTick:null,selectedSide:side,navigationRevision:(current.navigationRevision??0)+1};
  store.putSession(id,next);res.locals.session=next;return true;
 };
 const joinLimiter=new LoginRateLimiter();

 app.get('/api/campaigns',wrap((_req,res)=>{res.json({campaigns:campaigns.list(scopeOf(res))});}));
 app.post('/api/campaigns',guards.requireWrite,wrap(async(req,res)=>{
  const session=requireWrite(res);const {name}=nameSchema.parse(req.body??{});
  const view=await campaigns.create({name,identity:session.identity,workroomId,resolve:resolverFor(res)});
  const navigationSelected=view.activeExerciseId?select(res,session,view.activeExerciseId):false;
  res.status(201).json({...view,navigationSelected});
 }));
 /** Explicit join with an opaque campaign invite. The joiner's subject and workroom come from their own fresh resolution. */
 app.post('/api/campaigns/join',guards.requireWrite,wrap((req,res)=>{
  const session=requireWrite(res);
  if(joinLimiter.check(session.identity.subject))throw new ServiceError(429,'Too many campaign-code attempts; try again in a minute');
  const {code}=codeSchema.parse(req.body??{});
  const state=campaigns.members.lookupCode(code,workroomId);
  const result=campaigns.members.join(state,freshOf(res));
  const navigationSelected=result.activeExerciseId?select(res,session,result.activeExerciseId,store.exercise(result.activeExerciseId)?.humanSide??'blue'):false;
  res.json({campaignId:state.id,joined:result.joined,activeExerciseId:result.activeExerciseId,navigationSelected,view:campaigns.view(state.id,scopeOf(res))});
 }));
 app.get('/api/campaigns/:id',wrap((req,res)=>{res.json(campaigns.view(campaignId(req),scopeOf(res)));}));
 app.post('/api/campaigns/:id/resume',guards.requireWrite,wrap(async(req,res)=>{requireWrite(res);res.json(await campaigns.resume(campaignId(req),scopeOf(res),resolverFor(res)));}));
 app.post('/api/campaigns/:id/pause',wrap((req,res)=>{res.json(campaigns.pause(campaignId(req),scopeOf(res)));}));
 app.post('/api/campaigns/:id/stop',guards.requireWrite,wrap((req,res)=>{requireWrite(res);res.json(campaigns.stop(campaignId(req),scopeOf(res)));}));
 /** Self-withdrawal needs only a fresh signed-in session: a participant who lost write access can still leave. */
 app.post('/api/campaigns/:id/withdraw',guards.requireFreshRead??((_req,_res,next)=>next()),wrap((req,res)=>{
  const id=campaignId(req),viewer=scopeOf(res);
  const state=campaigns.repo.loadFor(id,{subject:viewer.ownerSubject,workroomId},s=>campaigns.members.canRead(s,viewer.ownerSubject));
  campaigns.members.withdraw(state,freshOf(res));
  res.json({withdrawn:true,campaignId:id});
 }));
 app.post('/api/campaigns/:id/code',guards.requireWrite,wrap((req,res)=>{requireShare(res);res.json(campaigns.members.issueCode(ownedBy(req,res),freshOf(res)));}));
 app.post('/api/campaigns/:id/limit',guards.requireWrite,wrap((req,res)=>{
  requireWrite(res);const {maxParticipants}=limitSchema.parse(req.body??{});const state=ownedBy(req,res);
  campaigns.members.setLimit(state,maxParticipants,freshOf(res));res.json(campaigns.view(state.id,scopeOf(res)));
 }));
 app.post('/api/campaigns/:id/revoke',guards.requireWrite,wrap((req,res)=>{
  requireWrite(res);const {subject}=subjectSchema.parse(req.body??{});const state=ownedBy(req,res);
  campaigns.members.revoke(state,subject,freshOf(res));res.json(campaigns.view(state.id,scopeOf(res)));
 }));
 /** Lifts a removal. The subject rejoins with a current invite and their own fresh identity; nobody is re-seated on their behalf. */
 app.post('/api/campaigns/:id/reinstate',guards.requireWrite,wrap((req,res)=>{
  requireWrite(res);const {subject}=subjectSchema.parse(req.body??{});const state=ownedBy(req,res);
  campaigns.members.lift(state,subject,freshOf(res));res.json({...campaigns.view(state.id,scopeOf(res)),rejoinRequired:true});
 }));
}
