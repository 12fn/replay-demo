/** Runtime-only mission progression. Native routes must provide a fresh write-authority capability. */
import {CampaignStore,type CampaignScope} from './campaign-store';
import type {CampaignSession,MissionReservation} from '../campaign/session';
import type {ExerciseRow} from './store';
export interface CampaignAuthority {
 /** Must resolve current native authority, not a cached role or serialized token. */
 check(scope:CampaignScope):Promise<void>;
}
/** Thrown by an attach hook when the state it reasoned about moved; the coordinator recomputes once before pausing. */
export class AttachRaceError extends Error {constructor(message:string){super(message);this.name='AttachRaceError';}}
export interface CampaignMissionFactory {
 /** Persist reservation/owner/workroom in the same transaction as the initial canonical turn.
  * Must check authority again immediately before committing after async engine preparation.
  * The database unique reservation index is the final duplicate-creation guard. */
 create(state:CampaignSession,reservation:MissionReservation,authority:CampaignAuthority):Promise<ExerciseRow>;
 /**
  * Optional: asynchronous work that must precede attaching a created (or recovered) mission, such as fresh
  * per-participant access decisions. Returns a synchronous hook that runs inside the attach transaction and
  * may throw `AttachRaceError` if its inputs changed; the coordinator then recomputes once.
  */
 beforeAttach?(state:CampaignSession,row:ExerciseRow,authority:CampaignAuthority):Promise<(attached:CampaignSession,row:ExerciseRow)=>void>;
}
export class CampaignCoordinator {
 private authorities=new Map<string,CampaignAuthority>();
 private pending=new Map<string,Promise<CampaignSession>>();
 constructor(private repo:CampaignStore,private factory:CampaignMissionFactory){}
 /** Recreated coordinator starts paused; credentials/capabilities never enter the ledger. */
 enabled(id:string){return this.authorities.has(id);}
 pause(id:string){this.authorities.delete(id);}
 async resume(id:string,scope:CampaignScope,authority:CampaignAuthority){
  this.repo.load(id,scope);await authority.check(scope);this.authorities.set(id,authority);
  return this.advance(id,scope);
 }
 advance(id:string,scope:CampaignScope):Promise<CampaignSession>{
  // Scope check precedes single-flight lookup so callers cannot obtain another owner's result.
  this.repo.load(id,scope);const prior=this.pending.get(id);if(prior)return prior;
  const work=this.reconcile(id,scope);this.pending.set(id,work);
  void work.finally(()=>{if(this.pending.get(id)===work)this.pending.delete(id);}).catch(()=>{});return work;
 }
 private async reconcile(id:string,scope:CampaignScope):Promise<CampaignSession>{
  const authority=this.authorities.get(id);let state=this.repo.load(id,scope);
  if(!authority||['completed','stopped','fault'].includes(state.status))return state;
  const guard:CampaignAuthority={check:async s=>{
   if(this.authorities.get(id)!==authority)throw new Error('Campaign progression paused; resume with current authority');
   await authority.check(s);
   if(this.authorities.get(id)!==authority)throw new Error('Campaign progression paused during authority check');
  }};
  try {
   await guard.check(scope);state=this.repo.load(id,scope);
   // Completion is explicitly reconciled by the caller after the durable source ends.
   if(state.status!=='awaiting-mission'||!state.reservation)return state;
   const reservation=structuredClone(state.reservation);
   let row=this.repo.pendingExercise(id,scope);
   if(!row){
    try{row=await this.factory.create(state,reservation,guard);}catch(error){
     // A crash/exception after commit or a competing creator may have left a valid reserved row.
     row=this.repo.pendingExercise(id,scope);if(!row)throw error;
    }
   }
   // Two attempts: membership may move (join/withdraw) between the fresh decisions and the commit.
   for(let attempt=0;;attempt++){
    const within=this.factory.beforeAttach?await this.factory.beforeAttach(state,row,guard):undefined;
    await guard.check(scope);state=this.repo.load(id,scope);
    // CAS and the exact reservation checks refuse stale attachment after stop/other mutation.
    try{return this.repo.attach(id,scope,state.revision,row.id,within);}
    catch(error){if(!(error instanceof AttachRaceError)||attempt>=1)throw error;}
   }
  }catch(error){this.pause(id);throw error;}
 }
 async completed(id:string,scope:CampaignScope,exerciseId:string){
  const state=this.repo.load(id,scope),authority=this.authorities.get(id);
  if(!authority)return state;
  await authority.check(scope);
  if(this.authorities.get(id)!==authority)throw new Error('Campaign progression paused');
  const current=this.repo.load(id,scope);
  this.repo.complete(id,scope,current.revision,exerciseId);
  return this.advance(id,scope);
 }
}
