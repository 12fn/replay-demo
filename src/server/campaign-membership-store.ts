/**
 * Durable campaign membership. One row per campaign holding the kernel state, versioned independently
 * of the campaign ledger (`campaign_sessions.revision`), plus an append-only audit table with one row per
 * membership version. Writes are compare-and-swap on `version`; the audit row and the state row commit in
 * the same SQLite transaction, so a failed audit insert rolls the state back.
 *
 * Nothing here decides authorization. Callers pass kernel transitions; the store only guarantees that
 * concurrent writers cannot both win and that history is contiguous.
 */
import type {Store} from './store';
import {newMembership,type CampaignMembership,type MemberIdentity,type MembershipEvent} from '../campaign/enrollment';

export class MembershipStoreError extends Error {constructor(readonly status:404|409,message:string){super(message);this.name='MembershipStoreError';}}

export class CampaignMembershipStore {
 constructor(private store:Store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_memberships(campaign_id TEXT PRIMARY KEY,version INTEGER NOT NULL,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS campaign_membership_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,subject TEXT,body TEXT NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(campaign_id,version));
 `);}
 /** Raw load without scope: callers apply the kernel's read rule. Null when the campaign predates membership. */
 load(campaignId:string):CampaignMembership|null{
  const row=this.store.db.prepare('SELECT body FROM campaign_memberships WHERE campaign_id=?').get(campaignId) as {body:string}|undefined;
  return row?JSON.parse(row.body) as CampaignMembership:null;
 }
 require(campaignId:string):CampaignMembership{const m=this.load(campaignId);if(!m)throw new MembershipStoreError(404,'Campaign membership not found');return m;}
 /**
 * Owner-only membership for a campaign that has none yet (created before shared enrollment existed, or the
 * membership insert never happened). Idempotent under concurrency: the primary key decides, and the loser
 * reads the winner's row.
 */
 ensure(input:{campaignId:string;owner:MemberIdentity;at?:string;maxParticipants?:number}):CampaignMembership{
  const existing=this.load(input.campaignId);if(existing)return existing;
  const state=newMembership({campaignId:input.campaignId,owner:input.owner,at:input.at??new Date().toISOString(),maxParticipants:input.maxParticipants});
  return this.store.transaction(()=>{
   const again=this.load(input.campaignId);if(again)return again;
   this.store.db.prepare('INSERT INTO campaign_memberships VALUES(?,?,?)').run(state.campaignId,state.version,JSON.stringify(state));
   this.audit(state.campaignId,state.events);return state;
  });
 }
 /** Every membership row. Callers filter by the kernel read rule before anything leaves the process. */
 all():CampaignMembership[]{return(this.store.db.prepare('SELECT body FROM campaign_memberships ORDER BY rowid').all() as {body:string}[]).map(r=>JSON.parse(r.body) as CampaignMembership);}
 /**
 * Apply a kernel transition atomically. `expectedVersion` is the version the caller reasoned about (for
 * decisions computed outside the transaction); omitted, the current row is used. A no-op change writes
 * nothing. Runs its own transaction; use `write` inside an enclosing one.
 */
 mutate(campaignId:string,change:(current:CampaignMembership)=>CampaignMembership,expectedVersion?:number):CampaignMembership{
  return this.store.transaction(()=>this.write(campaignId,change,expectedVersion));
 }
 /** Same as `mutate` but for callers already inside `store.transaction` (the mission attach path). */
 write(campaignId:string,change:(current:CampaignMembership)=>CampaignMembership,expectedVersion?:number):CampaignMembership{
  const current=this.require(campaignId);
  if(expectedVersion!==undefined&&current.version!==expectedVersion)throw new MembershipStoreError(409,'Campaign membership changed; reconcile before retrying');
  const next=change(current);if(next===current)return current;
  if(next.campaignId!==campaignId||next.schema!==current.schema||next.scope.ownerSubject!==current.scope.ownerSubject||next.scope.workroomId!==current.scope.workroomId)throw new Error('Invalid membership transition identity or scope');
  const appended=next.events.slice(current.events.length);
  if(next.version<=current.version||appended.length!==next.version-current.version||appended.some((e,i)=>e.version!==current.version+1+i))throw new Error('Membership audit must be contiguous with the stored version');
  const result=this.store.db.prepare('UPDATE campaign_memberships SET version=?,body=? WHERE campaign_id=? AND version=?').run(next.version,JSON.stringify(next),campaignId,current.version);
  if(result.changes!==1)throw new MembershipStoreError(409,'Campaign membership changed; reconcile before retrying');
  this.audit(campaignId,appended);return next;
 }
 history(campaignId:string){
  return(this.store.db.prepare('SELECT version,kind,actor,subject,body,recorded_at FROM campaign_membership_events WHERE campaign_id=? ORDER BY version').all(campaignId) as {version:number;kind:string;actor:string;subject:string|null;body:string;recorded_at:string}[])
   .map(r=>({version:r.version,kind:r.kind,actor:r.actor,subject:r.subject,event:JSON.parse(r.body) as MembershipEvent,recordedAt:r.recorded_at}));
 }
 private audit(campaignId:string,events:MembershipEvent[]){
  const insert=this.store.db.prepare('INSERT INTO campaign_membership_events(campaign_id,version,kind,actor,subject,body,recorded_at) VALUES(?,?,?,?,?,?,?)');
  const at=new Date().toISOString();for(const e of events)insert.run(campaignId,e.version,e.kind,e.actor,e.subject,JSON.stringify(e),at);
 }
}
