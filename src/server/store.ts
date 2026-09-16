import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {projectEvidenceRecords} from '../scenarios/evidence-records';

export interface ExerciseRow {id:string;name:string;kind:'live'|'recorded'|'branch';status:string;createdAt:string;parentId?:string;forkTick?:number;humanSide:'blue'|'red';options:any;agentEnabled:boolean;}
export class Store {
  readonly db:DatabaseSync;
  constructor(filename:string){
    fs.mkdirSync(path.dirname(filename),{recursive:true});this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS exercises(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(exercise_id TEXT NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(exercise_id,tick));
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,exercise_id TEXT NOT NULL,tick INTEGER NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,side TEXT,summary TEXT NOT NULL,details TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,exercise_id TEXT NOT NULL,idem TEXT NOT NULL,actor TEXT NOT NULL,side TEXT NOT NULL,intent TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(exercise_id,idem));
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,exercise_id TEXT NOT NULL,tick INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,exercise_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_exercise ON events(exercise_id,sequence);
      CREATE INDEX IF NOT EXISTS events_by_actor_sequence ON events(actor,sequence DESC);
    `);
  }
  private transactionDepth=0;
  /** Nested operations use savepoints so a caller can commit a task and its request receipt together. */
  transaction<T>(fn:()=>T):T{
    const depth=this.transactionDepth, savepoint=`replay_nested_${depth}`;
    this.db.exec(depth===0?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try{const result=fn();this.db.exec(depth===0?'COMMIT':`RELEASE SAVEPOINT ${savepoint}`);return result;}
    catch(error){if(depth===0)this.db.exec('ROLLBACK');else{this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);}throw error;}
    finally{this.transactionDepth--;}
  }
  putExercise(row:ExerciseRow){this.db.prepare('INSERT INTO exercises VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(row.id,JSON.stringify(row));}
  exercises():ExerciseRow[]{return this.db.prepare('SELECT body FROM exercises ORDER BY rowid').all().map((r:any)=>JSON.parse(r.body));}
  exercise(id:string){return this.exercises().find(r=>r.id===id);}
  event(exerciseId:string,tick:number,kind:string,actor:string,summary:string,details:any={},side?:string){
    const id=randomUUID();this.db.prepare('INSERT INTO events(id,exercise_id,tick,kind,actor,side,summary,details,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,exerciseId,tick,kind,actor,side??null,summary,JSON.stringify(details),new Date().toISOString());return id;
  }
  events(id:string,tick=Number.MAX_SAFE_INTEGER){return this.db.prepare('SELECT * FROM events WHERE exercise_id=? AND tick<=? ORDER BY sequence').all(id,tick).map((r:any)=>({id:r.id,sequence:r.sequence,tick:r.tick,kind:r.kind,actor:r.actor,side:r.side,summary:r.summary,details:JSON.parse(r.details),recordedAt:r.recorded_at}));}
  recordTurn(id:string,tick:number,turn:any,fingerprint:string){this.db.prepare('INSERT INTO turns VALUES(?,?,?,?)').run(id,tick,JSON.stringify(turn),fingerprint);}
  turns(id:string){return this.db.prepare('SELECT tick,body,fingerprint FROM turns WHERE exercise_id=? ORDER BY tick').all(id).map((r:any)=>({tick:Number(r.tick),turn:JSON.parse(r.body),fingerprint:r.fingerprint}));}
  command(id:string,idem:string){const r=this.db.prepare('SELECT * FROM commands WHERE exercise_id=? AND idem=?').get(id,idem) as any;return r?{...r,intent:JSON.parse(r.intent),...JSON.parse(r.body)}:null;}
  queue(id:string,idem:string,actor:string,side:string,intent:any,body:any){const commandId=randomUUID();this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?,?,?)').run(commandId,id,idem,actor,side,JSON.stringify(intent),'queued',JSON.stringify(body));return commandId;}
  pending(id:string){return this.db.prepare("SELECT * FROM commands WHERE exercise_id=? AND status='queued' ORDER BY rowid").all(id).map((r:any)=>({...r,intent:JSON.parse(r.intent),...JSON.parse(r.body)}));}
  settleCommand(id:string,status:string,body:any){this.db.prepare('UPDATE commands SET status=?,body=? WHERE id=?').run(status,JSON.stringify(body),id);}
  putReport(exerciseId:string,report:any){this.db.prepare('INSERT OR REPLACE INTO reports VALUES(?,?,?,?)').run(report.id,exerciseId,report.tick,JSON.stringify(report));}
  reports(id:string,tick=Number.MAX_SAFE_INTEGER):any[]{return projectEvidenceRecords(this.db.prepare('SELECT body FROM reports WHERE exercise_id=? AND tick<=? ORDER BY tick,rowid').all(id,tick).map((r:any)=>JSON.parse(r.body)));}
  putTask(exerciseId:string,task:any){this.db.prepare('INSERT OR REPLACE INTO tasks VALUES(?,?,?)').run(task.id,exerciseId,JSON.stringify(task));}
  tasks(id:string){return this.db.prepare('SELECT body FROM tasks WHERE exercise_id=?').all(id).map((r:any)=>JSON.parse(r.body));}
  session(id:string){const r=this.db.prepare('SELECT body FROM sessions WHERE id=?').get(id) as any;return r?JSON.parse(r.body):null;}
  putSession(id:string,body:any){this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(id,JSON.stringify(body));}
  close(){this.db.close();}
}
