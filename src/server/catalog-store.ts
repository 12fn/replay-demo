import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {createPresetCatalog} from '../catalog/seed';
import type {CatalogBundle,CatalogKind,CatalogPage,CatalogQuery,CatalogRecord,CatalogRole} from '../catalog/types';
export const CATALOG_KINDS=['persona','report','case','event','asset','glossary','historical','lesson','organization','red-profile'] as const;
const id=z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9/_-]*$/);
export const catalogQuerySchema=z.object({query:z.string().trim().max(120).optional(),aorId:z.enum(['taiwan','caribbean','hormuz']).optional(),kind:z.enum(CATALOG_KINDS).optional(),role:z.enum(['commander','intelligence','instructor']).optional(),personaId:id.optional(),caseId:id.optional(),cutoffTick:z.number().int().min(0).max(1000000).optional(),offset:z.number().int().min(0).max(50000).default(0),limit:z.number().int().min(1).max(100).default(20)}).strict();
/** User search is literal token input, never FTS grammar. */
export function literalCatalogMatch(q:string){return (q.match(/[\p{L}\p{N}]+/gu)??[]).map(w=>'"'+w+'"').join(' AND ');}
const cached=new WeakMap<DatabaseSync,CatalogStore>();
export function catalogFor(db:DatabaseSync){let c=cached.get(db);if(!c){c=new CatalogStore(db);cached.set(db,c);}return c;}
export class CatalogStore {
 readonly hash:string;
 private readonly byId:Map<string,CatalogRecord>;
 private readonly releaseTicks=new Map<string,number>();
 constructor(readonly db:DatabaseSync,readonly bundle:CatalogBundle=createPresetCatalog()){
  this.byId=new Map(bundle.records.map(r=>[r.id,r]));
  for(const r of bundle.records)this.releaseTicks.set(r.id,r.availableAtTick??0);
  // Full case/persona summaries contain hindsight. They become eligible only after their authored timeline.
  for(const r of bundle.records)if(r.kind==='event'){if(r.caseId)this.releaseTicks.set(r.caseId,Math.max(this.releaseTicks.get(r.caseId)??0,r.availableAtTick??0));if(r.personaId)this.releaseTicks.set(r.personaId,Math.max(this.releaseTicks.get(r.personaId)??0,r.availableAtTick??0));}
  for(const r of bundle.records)if(r.kind==='case'&&r.personaId)this.releaseTicks.set(r.personaId,Math.max(this.releaseTicks.get(r.personaId)??0,this.releaseTicks.get(r.id)??0));
  this.hash=createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  const ids=new Set(bundle.records.map(r=>r.id));if(ids.size!==bundle.records.length)throw new Error('Duplicate preset record');
  const sourceIds=new Set(bundle.sources.map(s=>s.id));
  for(const r of bundle.records){if(!bundle.aors.some(a=>a.id===r.aorId)||r.links.some(l=>!ids.has(l.targetId))||r.sourceIds.some(s=>!sourceIds.has(s)))throw new Error('Preset catalog relationship is unresolved');}
  db.exec(`CREATE TABLE IF NOT EXISTS preset_catalog_versions(version TEXT PRIMARY KEY,sha256 TEXT NOT NULL,records INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS preset_catalog_records(version TEXT NOT NULL,id TEXT NOT NULL,aor TEXT NOT NULL,kind TEXT NOT NULL,roles TEXT NOT NULL,persona_id TEXT,case_id TEXT,available_tick INTEGER,body TEXT NOT NULL,PRIMARY KEY(version,id));
   CREATE INDEX IF NOT EXISTS preset_catalog_filter ON preset_catalog_records(version,aor,kind,persona_id,case_id,available_tick);
   CREATE VIRTUAL TABLE IF NOT EXISTS preset_catalog_fts USING fts5(version UNINDEXED,id UNINDEXED,title,content,tokenize='unicode61');`);
  const existing=db.prepare('SELECT sha256,records FROM preset_catalog_versions WHERE version=?').get(bundle.version);
  if(existing){if(existing.sha256!==this.hash||existing.records!==bundle.records.length)throw new Error('Preset version changed in place; publish a new version');return;}
  db.exec('BEGIN IMMEDIATE');
  try{
   const row=db.prepare('INSERT INTO preset_catalog_records VALUES(?,?,?,?,?,?,?,?,?)');const text=db.prepare('INSERT INTO preset_catalog_fts(version,id,title,content) VALUES(?,?,?,?)');
   for(const r of bundle.records){row.run(bundle.version,r.id,r.aorId,r.kind,JSON.stringify(r.roles),r.personaId??null,r.caseId??null,this.releaseTicks.get(r.id)??0,JSON.stringify(r));text.run(bundle.version,r.id,r.title,[r.summary,r.body,...r.tags,...Object.values(r.fields).flat().filter(v=>typeof v!=='string'||!ids.has(v))].join(' '));}
   db.prepare('INSERT INTO preset_catalog_versions VALUES(?,?,?)').run(bundle.version,this.hash,bundle.records.length);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 summary(currentRole:CatalogRole){const counts=Object.fromEntries(CATALOG_KINDS.map(k=>[k,0])) as Record<CatalogKind,number>;for(const r of this.db.prepare('SELECT kind,count(*) n FROM preset_catalog_records WHERE version=? GROUP BY kind').all(this.bundle.version))counts[r.kind as CatalogKind]=Number(r.n);return {schema:'replay.catalog-summary/1',version:this.bundle.version,seed:this.bundle.seed,sha256:this.hash,notice:this.bundle.notice,aors:this.bundle.aors,sources:this.bundle.sources,total:this.bundle.records.length,counts,currentRole,storage:'SQLite FTS5',nativeOntologyIngested:false};}
 search(input:unknown):CatalogPage{
  const q=catalogQuerySchema.parse(input);const match=literalCatalogMatch(q.query??'');const where=['r.version=?'];const args:(string|number)[]=[this.bundle.version];
  for(const [key,column]of [['aorId','aor'],['kind','kind'],['personaId','persona_id'],['caseId','case_id']] as const)if(q[key]){where.push(`r.${column}=?`);args.push(q[key]!);}
  if(q.role){where.push('EXISTS (SELECT 1 FROM json_each(r.roles) WHERE value=?)');args.push(q.role);}
  if(q.cutoffTick!==undefined){where.push('(r.available_tick IS NULL OR r.available_tick<=?)');args.push(q.cutoffTick);}
  if(q.query&&!match)where.push('0');
  const join=match?' JOIN preset_catalog_fts ON preset_catalog_fts.version=r.version AND preset_catalog_fts.id=r.id':'';
  if(match){where.push('preset_catalog_fts MATCH ?');args.push(match);}
  const clause=`FROM preset_catalog_records r${join} WHERE ${where.join(' AND ')}`;
  const total=Number(this.db.prepare(`SELECT count(*) n ${clause}`).get(...args)!.n);
  const rows=this.db.prepare(`SELECT r.body ${clause} ORDER BY ${match?'bm25(preset_catalog_fts,0,0,3,1),':''}coalesce(r.available_tick,0),r.id LIMIT ? OFFSET ?`).all(...args,q.limit,q.offset);
  return {schema:'replay.catalog-page/1',version:this.bundle.version,query:q,total,offset:q.offset,limit:q.limit,hasMore:q.offset+rows.length<total,items:rows.map(r=>this.project(JSON.parse(r.body as string),q.cutoffTick)),notice:this.bundle.notice};
 }
 private project(record:CatalogRecord,cutoffTick?:number):CatalogRecord{
  const released=(target:string)=>cutoffTick===undefined||(this.releaseTicks.get(target)??0)<=cutoffTick;
  const visibleValue=(v:string|number|boolean|string[]|null)=>typeof v==='string'&&this.byId.has(v)&&!released(v)?null:Array.isArray(v)?v.filter(x=>!this.byId.has(x)||released(x)):v;
  return {...record,availableAtTick:this.releaseTicks.get(record.id)??record.availableAtTick,
   links:record.links.filter(l=>released(l.targetId)),fields:Object.fromEntries(Object.entries(record.fields).map(([k,v])=>[k,visibleValue(v)]))};
 }
 detail(recordId:string,cutoffTick?:number){
  id.parse(recordId);if(cutoffTick!==undefined)z.number().int().min(0).max(1000000).parse(cutoffTick);
  const allowed=(r:CatalogRecord)=>cutoffTick===undefined||(this.releaseTicks.get(r.id)??0)<=cutoffTick;
  const get=(target:string):CatalogRecord|undefined=>{const row=this.db.prepare('SELECT body FROM preset_catalog_records WHERE version=? AND id=?').get(this.bundle.version,target);if(!row)return;const r=JSON.parse(row.body as string);return allowed(r)?r:undefined;};
  const record=get(recordId);if(!record)return null;
  const links=record.links.flatMap(l=>{const r=get(l.targetId);return r?[{relation:l.relation,record:r}]:[];}).slice(0,64);
  const backlinks=this.bundle.records.filter(allowed).flatMap(r=>r.links.filter(l=>l.targetId===recordId).map(l=>({relation:l.relation,record:r}))).slice(0,64);
  return {record:this.project(record,cutoffTick),links:links.map(l=>({...l,record:this.project(l.record,cutoffTick)})),backlinks:backlinks.map(l=>({...l,record:this.project(l.record,cutoffTick)})),sources:this.bundle.sources.filter(s=>record.sourceIds.includes(s.id)),notice:this.bundle.notice};
 }
 /** Small packets for a model tool; full documents stay queryable individually. No fake live-state projection. */
 toolSearch(input:unknown){const q=catalogQuerySchema.parse(input);const page=this.search({...q,limit:Math.min(q.limit,5)});return {...page,items:page.items.map(r=>({id:r.id,aorId:r.aorId,kind:r.kind,title:r.title,summary:r.summary,roles:r.roles,provenance:r.provenance,caseId:r.caseId??null,personaId:r.personaId??null,availableAtTick:r.availableAtTick??null})),detailTool:'get_catalog_record',scope:'shared preset references; not the caller\'s actual history'};}
}
