import {createHash,randomBytes} from 'node:crypto';
import type {Store,ExerciseRow} from './store';
import type {Identity} from './service';

export interface ExerciseParticipant {
  subject:string;name:string;roleAtJoin:Identity['role']|'unknown';organization:string;
  joinedTick:number;joinedAt:string;active:boolean;owner:boolean;
  removedAt?:string;removedBy?:string;
  /** How the seat arose. Absent = joined this exercise directly (standalone code or creation). */
  source?:'campaign-carryover'|'campaign-join';
  /** Membership version the campaign seat was derived from; the roster of record is the campaign membership. */
  campaignMembershipVersion?:number;
}
/** Seat derived from consented campaign membership; identity fields are labels from the membership record or a fresh resolution. */
export interface CarriedSeat {subject:string;name:string;organization:string;roleAtJoin:Identity['role']|'unknown';source:'campaign-carryover'|'campaign-join';membershipVersion:number;}
export class TeamError extends Error {constructor(readonly status:number,message:string){super(message);}}

/** App enrollment intersects native workroom authority; it never grants a platform role. */
export class ExerciseTeams {
  constructor(private store:Store){
    store.db.exec('CREATE TABLE IF NOT EXISTS exercise_participants(exercise_id TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(exercise_id,subject))');
  }
  participants(row:ExerciseRow):ExerciseParticipant[]{
    const rows=(this.store.db.prepare('SELECT body FROM exercise_participants WHERE exercise_id=? ORDER BY rowid').all(row.id) as {body:string}[]).map(r=>JSON.parse(r.body) as ExerciseParticipant);
    if(row.options?.ownerSubject&&!rows.some(p=>p.subject===row.options.ownerSubject))rows.unshift({subject:row.options.ownerSubject,name:'Exercise owner',roleAtJoin:'unknown',organization:'Not recorded',joinedTick:row.forkTick??1,joinedAt:row.createdAt,active:true,owner:true});
    return rows;
  }
  includes(row:ExerciseRow,subject:string):boolean{return row.options?.ownerSubject===subject||this.participants(row).some(p=>p.subject===subject&&p.active);}
  enroll(row:ExerciseRow,identity:Identity,tick:number):ExerciseParticipant{
    if(row.options?.campaignId&&identity.subject!==row.options.ownerSubject)throw new TeamError(403,'Use the campaign invitation to join or manage campaign participants');
    const existing=this.participants(row).find(p=>p.subject===identity.subject);
    if(existing?.active&&!existing.owner)return existing;
    if(!existing?.active&&this.participants(row).filter(p=>p.active).length>=16)throw new TeamError(409,'This exercise already has sixteen participants');
    const member:ExerciseParticipant={subject:identity.subject,name:identity.name,roleAtJoin:identity.role,organization:identity.organization,joinedTick:existing?.active?existing.joinedTick:tick,joinedAt:existing?.active?existing.joinedAt:new Date().toISOString(),active:true,owner:row.options?.ownerSubject===identity.subject};
    this.store.db.prepare('INSERT INTO exercise_participants VALUES(?,?,?) ON CONFLICT(exercise_id,subject) DO UPDATE SET body=excluded.body').run(row.id,identity.subject,JSON.stringify(member));
    return member;
  }
  /**
   * Seat a campaign participant on a mission exercise. This is the only path for a non-owner onto a
   * campaign row: it requires the row to be a mission of the named campaign and is called by the campaign
   * service with a subject taken from the membership projection, never from a request body. Re-carrying an
   * active seat keeps its original join tick. Non-transactional; callers wrap it with the membership write.
   */
  carry(row:ExerciseRow,campaignId:string,seat:CarriedSeat,tick:number):ExerciseParticipant{
    if(!row.options?.campaignId||row.options.campaignId!==campaignId||row.kind==='branch'||row.parentId)throw new TeamError(409,'Campaign seats apply only to that campaign\'s own missions');
    if(seat.subject===row.options.ownerSubject)throw new TeamError(409,'The mission owner is seated by creation, not carried');
    const existing=this.participants(row).find(p=>p.subject===seat.subject);
    if(!existing?.active&&this.participants(row).filter(p=>p.active).length>=16)throw new TeamError(409,'This exercise already has sixteen participants');
    const member:ExerciseParticipant={subject:seat.subject,name:seat.name,roleAtJoin:seat.roleAtJoin,organization:seat.organization,joinedTick:existing?.active?existing.joinedTick:tick,joinedAt:existing?.active?existing.joinedAt:new Date().toISOString(),active:true,owner:false,source:seat.source,campaignMembershipVersion:seat.membershipVersion};
    this.store.db.prepare('INSERT INTO exercise_participants VALUES(?,?,?) ON CONFLICT(exercise_id,subject) DO UPDATE SET body=excluded.body').run(row.id,seat.subject,JSON.stringify(member));
    return member;
  }
  issueCode(row:ExerciseRow,issuer:string){
    if(row.options?.campaignId)throw new TeamError(409,'Use the campaign invitation to join or manage campaign participants');
    if(row.status!=='running')throw new TeamError(409,'Join a running exercise or start a new one');
    const code=randomBytes(16).toString('hex'),expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
    this.store.transaction(()=>{
      this.revokeCodes(row.id);
      this.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(this.codeKey(code),JSON.stringify({exerciseId:row.id,workroomId:row.options?.workroomId??null,issuer,expiresAt}));
      this.store.event(row.id,this.store.turns(row.id).at(-1)?.tick??1,'team_enrollment_opened',issuer,'Exercise join code created',{expiresAt},row.humanSide);
    });
    return {code,expiresAt};
  }
  lookupCode(code:string,workroomId:string|null):ExerciseRow{
    const entry=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(this.codeKey(code.trim().toLowerCase())) as {value:string}|undefined;
    const body=entry?JSON.parse(entry.value):null,row=body?this.store.exercise(body.exerciseId):null;
    if(!body||!row||row.options?.campaignId||body.workroomId!==workroomId||Date.parse(body.expiresAt)<=Date.now()||row.status!=='running'||(row.options?.workroomId??null)!==workroomId)throw new TeamError(404,'Exercise code is invalid, expired, or unavailable in this workroom');
    return row;
  }
  remove(row:ExerciseRow,subject:string,removedBy:string,withinTransaction=false){
    if(subject===row.options?.ownerSubject)throw new TeamError(409,'The exercise owner cannot be removed');
    const member=this.participants(row).find(p=>p.subject===subject&&p.active);
    if(!member)throw new TeamError(404,'Active participant not found');
    const updated={...member,active:false,removedAt:new Date().toISOString(),removedBy};
    const write=()=>{
      this.store.db.prepare('UPDATE exercise_participants SET body=? WHERE exercise_id=? AND subject=?').run(JSON.stringify(updated),row.id,subject);
      this.revokeCodes(row.id);
      this.store.event(row.id,this.store.turns(row.id).at(-1)?.tick??1,'participant_removed',removedBy,'Participant removed from exercise; prior evidence retained',{subject},row.humanSide);
    };
    if(withinTransaction)write();else this.store.transaction(write);
  }
  private codeKey(code:string){return `exercise.join-code:${createHash('sha256').update(code).digest('hex')}`;}
  private revokeCodes(exerciseId:string){this.store.db.prepare("DELETE FROM settings WHERE key LIKE 'exercise.join-code:%' AND json_extract(value,'$.exerciseId')=?").run(exerciseId);}
}
