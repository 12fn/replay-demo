/** Durable ledger foundation. Not yet wired to automatic creation or native routes. */
import type {Store,ExerciseRow} from './store';
import {newCampaign,attachCampaignMission,completeCampaignMission,type CampaignSession,type CampaignRules} from '../campaign/session';

export class CampaignStoreError extends Error {constructor(readonly status:number,message:string){super(message);}}
export interface CampaignScope {ownerSubject:string;workroomId:string|null;}
export class CampaignStore {
 constructor(private store:Store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS campaign_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,body TEXT NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(campaign_id,revision));
  CREATE UNIQUE INDEX IF NOT EXISTS exercise_campaign_reservation ON exercises(json_extract(body,'$.options.campaignReservation')) WHERE json_extract(body,'$.options.campaignReservation') IS NOT NULL;
 `);}
 create(input:{id:string;name:string;ownerSubject:string;workroomId:string|null;rules?:CampaignRules}):CampaignSession{
  const state=newCampaign(input);return this.store.transaction(()=>{this.store.db.prepare('INSERT INTO campaign_sessions VALUES(?,?)').run(state.id,JSON.stringify(state));this.audit(state,'created',state.ownerSubject);return state;});
 }
 /** Only the caller's own owner/workroom campaigns; nothing belonging to another subject is even read into the result. */
 list(scope:CampaignScope):CampaignSession[]{
  return(this.store.db.prepare('SELECT body FROM campaign_sessions ORDER BY rowid').all() as {body:string}[]).map(r=>JSON.parse(r.body) as CampaignSession).filter(s=>s.ownerSubject===scope.ownerSubject&&s.workroomId===scope.workroomId);
 }
 /** Owner-only load: control operations (pause, stop, resume, limit, revoke, invite) go through here. */
 load(id:string,scope:CampaignScope):CampaignSession{
  const state=this.raw(id);
  if(state.ownerSubject!==scope.ownerSubject||state.workroomId!==scope.workroomId)throw new CampaignStoreError(403,'Campaign is outside this owner/workroom scope');return state;
 }
 /**
  * Read load for the owner or a consented member. `isMember` is the caller's membership rule (fresh
  * membership state, current mission point); the workroom must still match the viewer's own resolution.
  */
 loadFor(id:string,viewer:{subject:string;workroomId:string|null},isMember:(state:CampaignSession)=>boolean):CampaignSession{
  const state=this.raw(id);
  if(state.workroomId!==viewer.workroomId)throw new CampaignStoreError(403,'Campaign is outside this owner/workroom scope');
  if(state.ownerSubject!==viewer.subject&&!isMember(state))throw new CampaignStoreError(403,'Campaign is outside this owner/workroom scope');
  return state;
 }
 /** Campaigns in the viewer's workroom that the viewer owns or `isMember` admits. Same in-memory filter pattern as `list`. */
 listFor(viewer:{subject:string;workroomId:string|null},isMember:(state:CampaignSession)=>boolean):CampaignSession[]{
  return(this.store.db.prepare('SELECT body FROM campaign_sessions ORDER BY rowid').all() as {body:string}[]).map(r=>JSON.parse(r.body) as CampaignSession).filter(s=>s.workroomId===viewer.workroomId&&(s.ownerSubject===viewer.subject||isMember(s)));
 }
 private raw(id:string):CampaignSession{
  const row=this.store.db.prepare('SELECT body FROM campaign_sessions WHERE id=?').get(id) as {body:string}|undefined;
  if(!row)throw new CampaignStoreError(404,'Campaign not found');return JSON.parse(row.body) as CampaignSession;
 }
 private audit(state:CampaignSession,kind:string,actor:string){this.store.db.prepare('INSERT INTO campaign_events(campaign_id,revision,kind,actor,body,recorded_at) VALUES(?,?,?,?,?,?)').run(state.id,state.revision,kind,actor,JSON.stringify(state),new Date().toISOString());}
 history(id:string,scope:CampaignScope){this.load(id,scope);return(this.store.db.prepare('SELECT revision,kind,actor,body,recorded_at FROM campaign_events WHERE campaign_id=? ORDER BY revision').all(id) as any[]).map(r=>({...r,state:JSON.parse(r.body),body:undefined}));}
 /** Optimistic revision check prevents stale async completion from overwriting newer progress. */
 transition(id:string,scope:CampaignScope,expectedRevision:number,kind:string,change:(state:CampaignSession)=>CampaignSession):CampaignSession{
  return this.store.transaction(()=>{const current=this.load(id,scope);if(current.revision!==expectedRevision)throw new CampaignStoreError(409,'Campaign changed; reconcile before retrying');const next=change(current);
   if(next===current)return current;
   if(next.id!==id||next.ownerSubject!==current.ownerSubject||next.workroomId!==current.workroomId||next.revision!==current.revision+1)throw new Error('Invalid campaign transition identity or revision');
   this.store.db.prepare('UPDATE campaign_sessions SET body=? WHERE id=?').run(JSON.stringify(next),id);this.audit(next,kind,scope.ownerSubject);return next;
  });
 }
 /** Recover an already-created exercise by its stable reservation, never create another on retry. */
 pendingExercise(id:string,scope:CampaignScope):ExerciseRow|null{
  const state=this.load(id,scope);if(!state.reservation)return null;
  const raw=this.store.db.prepare("SELECT body FROM exercises WHERE json_extract(body,'$.options.campaignReservation')=?").get(state.reservation.key) as {body:string}|undefined;
  if(!raw)return null;const row=JSON.parse(raw.body) as ExerciseRow;this.checkExercise(row,state);return row;
 }
 private checkExercise(row:ExerciseRow,state:CampaignSession){
  if(row.kind==='branch'||row.parentId||row.options?.campaignId!==state.id||row.options?.ownerSubject!==state.ownerSubject||(row.options?.workroomId??null)!==state.workroomId)throw new CampaignStoreError(403,'Exercise does not belong to this campaign owner/workroom');
 }
 /**
  * Attach a reserved mission. `within` runs inside the same transaction, only when the attach actually
  * transitions (a redelivered attach of an already-attached mission is a no-op and runs nothing), so the
  * membership record and carried seats commit with the ledger or not at all.
  */
 attach(id:string,scope:CampaignScope,expectedRevision:number,exerciseId:string,within?:(state:CampaignSession,row:ExerciseRow)=>void):CampaignSession{
  return this.transition(id,scope,expectedRevision,'mission-attached',state=>{
   const row=this.store.exercise(exerciseId);if(!row)throw new CampaignStoreError(404,'Reserved exercise not found');this.checkExercise(row,state);
   const first=this.store.db.prepare('SELECT tick,body,fingerprint FROM turns WHERE exercise_id=? ORDER BY tick LIMIT 1').get(row.id) as {tick:number;body:string;fingerprint:string}|undefined;
   if(!first||first.tick!==1||JSON.parse(first.body).turnNumber!==0)throw new Error('Mission lacks a canonical initial turn');
   const next=attachCampaignMission(state,{reservationKey:row.options.campaignReservation,exerciseId:row.id,scenarioId:row.options.scenario?.id,startTick:first.tick,startFingerprint:first.fingerprint});
   if(next!==state)within?.(next,row);
   return next;
  });
 }
 complete(id:string,scope:CampaignScope,expectedRevision:number,exerciseId:string):CampaignSession{
  return this.transition(id,scope,expectedRevision,'mission-completed',state=>{
   const row=this.store.exercise(exerciseId);if(!row)throw new CampaignStoreError(404,'Mission exercise not found');this.checkExercise(row,state);
   if(row.status!=='completed')throw new CampaignStoreError(409,'Mission has not durably completed');
   const last=this.store.db.prepare('SELECT tick,fingerprint FROM turns WHERE exercise_id=? ORDER BY tick DESC LIMIT 1').get(row.id) as {tick:number;fingerprint:string}|undefined;
   const ended=this.store.events(row.id).filter(e=>['exercise_completed','exercise_ended','campaign_budget_reached'].includes(e.kind)).at(-1);
   if(!last||!ended||ended.tick!==last.tick)throw new Error('Completion does not match the last durable canonical turn');
   const reason=ended.kind==='campaign_budget_reached'?'campaign-budget':ended.kind==='exercise_ended'?'facilitator-end':ended.details.objectiveOutcome?.reason==='time-limit'?'time-limit':'elimination';
   return completeCampaignMission(state,{exerciseId,tick:last.tick,fingerprint:last.fingerprint,reason});
  });
 }
}
