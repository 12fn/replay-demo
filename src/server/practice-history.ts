import {z} from 'zod';
import {redactSecrets} from '../platform/index';
import {sourceStatusAt} from '../learning/evidence';
import {projectEvidenceRecords} from '../scenarios/evidence-records';
import type {PracticeHistoryDetailItem,PracticeHistoryDetailsResult,PracticeHistoryItem,PracticeHistoryResult,PracticeSourceDetail,PracticeSourceStatus,PracticeStatement} from '../learning/practice-history-types';
import {exerciseScope,type AppConfig} from './native-http';
import {ServiceError,type GameService,type Identity} from './service';
import type {ExerciseRow} from './store';

export const practiceHistoryQuery=z.object({scope:z.enum(['mine','workroom']).default('mine'),query:z.string().trim().max(120).default(''),scenarioId:z.string().min(1).max(200).optional(),beforeSequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),limit:z.number().int().min(1).max(50).default(20)}).strict();
export const practiceHistoryDetailsQuery=practiceHistoryQuery.extend({limit:z.number().int().min(1).max(10).default(5)}).strict();
const text=(v:unknown,max=200):string=>typeof v==='string'?redactSecrets(v).replace(/sk-[A-Za-z0-9_-]{16,}/g,'[redacted]').slice(0,max):'';
const str=(v:unknown)=>typeof v==='string'?text(v):null;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const MAX_EXERCISES=1000;
const EVENT_COLUMNS='id,sequence,exercise_id,tick,kind,actor,side,summary,details,recorded_at';
type Selection={scope:'mine'|'workroom';query:string;scenarioId?:string;beforeSequence?:number};

/** Shared by /1 and /2: identity, instructor scope, workroom, completion and enrollment checks decide which exercises are searchable. */
function practiceScope(service:GameService,config:AppConfig,identity:Identity,q:Selection){
 if(config.mode!==identity.mode||!identity.subject)throw new ServiceError(403,'An authenticated practice identity is required');
 if(q.scope==='workroom'&&identity.role!=='instructor')throw new ServiceError(403,'Workroom practice review requires the instructor seat');
 const access=exerciseScope(config,identity,row=>service.teams.includes(row,identity.subject));
 const all=service.store.exercises();
 // Never reveal legacy, other-room or revoked enrollment through a secondary catalog.
 const authorized=all.filter(row=>row.status==='completed'&&access.visible(row)&&(config.mode!=='kamiwaza'||row.options?.workroomId===config.workroomId));
 const eligible=authorized.filter(row=>q.scope==='workroom'||row.options?.ownerSubject===identity.subject||service.teams.includes(row,identity.subject))
  .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 const bounded=eligible.slice(0,MAX_EXERCISES);
 const rows=bounded.filter(r=>!q.scenarioId||r.options?.scenarioId===q.scenarioId),byId=new Map(rows.map(r=>[r.id,r]));
 return {all,authorized,eligible,bounded,rows,byId};
}
/** Values always travel as bound parameters. `statements` adds the /2 written-text match; /1 passes false and keeps its exact filter. */
function eventFilter(rows:ExerciseRow[],q:Selection,subject:string,statements:boolean){
 const params:(string|number)[]=rows.map(r=>r.id);
 let where=`exercise_id IN (${rows.map(()=>'?').join(',')}) AND (kind IN ('assessment_log','task_created','decision_log') OR (kind='command' AND json_extract(details,'$.origin')='human'))`;
 if(q.scope==='mine'){where+=' AND actor=?';params.push(subject);}
 if(q.beforeSequence!==undefined){where+=' AND sequence<?';params.push(q.beforeSequence);}
 if(q.query){
  const statement=statements?' OR (kind=\'command\' AND instr(lower(json_extract(details,\'$.rationale\')),lower(?))>0) OR (kind IN (\'decision_log\',\'assessment_log\') AND instr(lower(json_extract(details,\'$.text\')),lower(?))>0)':'';
  where+=` AND (instr(lower(summary),lower(?))>0 OR instr(lower(kind),lower(?))>0 OR exercise_id IN (SELECT id FROM exercises WHERE instr(lower(json_extract(body,'$.name')),lower(?))>0 OR instr(lower(json_extract(body,'$.options.scenarioId')),lower(?))>0)${statement})`;
  params.push(q.query,q.query,q.query,q.query);if(statements)params.push(q.query,q.query);
 }
 return {where,params};
}
function exerciseOf(row:ExerciseRow,authorized:ExerciseRow[],name=(v:unknown)=>text(v),field=str){
 const o=row.options??{},p=typeof row.parentId==='string'&&authorized.some(r=>r.id===row.parentId)?row.parentId:null;
 return {id:row.id,name:name(row.name),kind:row.kind,status:row.status,createdAt:row.createdAt,scenarioId:field(o.scenarioId),scenarioVersion:field(o.scenario?.id),map:field(o.map),simulationProfile:field(o.simulationProfile),curriculumVersion:field(o.curriculumVersion),assistance:['unassisted','staff-assisted'].includes(o.assistance)?o.assistance:'unknown',parentId:p,forkTick:finite(row.forkTick)?row.forkTick:null};
}
/** Branch source IDs retain ancestry; mask ancestors outside the caller's completed-exercise scope. */
function sourceIdMask(row:ExerciseRow,all:ExerciseRow[],authorized:ExerciseRow[]){
 const rows=new Map(all.map(r=>[r.id,r])),visible=new Set(authorized.map(r=>r.id)),visited=new Set<string>(),hidden:string[]=[];
 for(let p=row.parentId;typeof p==='string'&&!visited.has(p);p=rows.get(p)?.parentId){visited.add(p);if(!visible.has(p))hidden.push(p);}
 return (id:string)=>hidden.reduce((s,h)=>s.split(h).join('[unavailable-exercise]'),id);
}
const observedOf=(d:any)=>finite(d.observedTick)?d.observedTick:finite(d.observation?.tick)?d.observation.tick:null;
const commitmentOf=(d:any)=>{const troops=d.observation?.player?.troops??d.before?.troops,committed=d.intent?.troops;return finite(troops)&&troops>0&&finite(committed)?committed/troops:null;};

/** Exact SQL records remain authoritative. This bounded projection never exports arbitrary event details. */
export function practiceHistory(service:GameService,config:AppConfig,identity:Identity,input:unknown):PracticeHistoryResult{
 const q=practiceHistoryQuery.parse(input);
 const {all,authorized,eligible,bounded,rows,byId}=practiceScope(service,config,identity,q);
 const scenarios=Array.from(new Map(bounded.filter(r=>typeof r.options?.scenarioId==='string').map(r=>[r.options.scenarioId,{id:text(r.options.scenarioId),name:text(r.options.scenarioId)}])).values());
 const base={schema:'replay.practice-history/1' as const,scope:q.scope,fiction:true as const,query:q.query,scenarios,limits:{maxPageSize:50,eligibleExercises:bounded.length,exerciseCatalogTruncated:eligible.length>bounded.length},notice:'Completed fictional exercise records only. Personal scope contains your recorded actions; instructor workroom scope includes attributed participant actions in this workroom. Counts describe this returned page, not all history or learning. Branches are informed practice; different scenarios, versions, roles and assistance are not automatically comparable. Missing statements do not establish a weakness. Live attempts and model/private coaching traces are excluded.'};
 const {where,params}=eventFilter(rows,q,identity.subject,false);
 params.push(q.limit+1);
 const raw=rows.length?service.store.db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE ${where} ORDER BY sequence DESC LIMIT ?`).all(...params) as any[]:[];
 const items:PracticeHistoryItem[]=raw.slice(0,q.limit).map(e=>{
  const row=byId.get(e.exercise_id)!,d=JSON.parse(e.details),mask=sourceIdMask(row,all,authorized);
  return {eventId:e.id,sequence:Number(e.sequence),tick:Number(e.tick),observedTick:observedOf(d),recordedAt:e.recorded_at,kind:e.kind,actor:text(e.actor),side:e.side,summary:text(e.summary,500),
   exercise:exerciseOf(row,authorized),
   sourceIds:Array.isArray(d.sourceIds)?d.sourceIds.filter((x:unknown)=>typeof x==='string').slice(0,20).map((x:string)=>text(mask(x))):[],commitmentRatio:commitmentOf(d),rationaleRecorded:typeof d.rationale==='string'&&d.rationale.trim().length>0};
 });
 return {...base,items,hasMore:raw.length>q.limit,nextBeforeSequence:raw.length>q.limit?items.at(-1)!.sequence:null,summary:{basis:'returned-page-only',commands:items.filter(e=>e.kind==='command').length,assessments:items.filter(e=>e.kind==='assessment_log').length,watches:items.filter(e=>e.kind==='task_created').length,commandsCitingSources:items.filter(e=>e.kind==='command'&&e.sourceIds.length>0).length,commandsWithRecordedReason:items.filter(e=>e.kind==='command'&&e.rationaleRecorded).length,branchEvents:items.filter(e=>e.exercise.kind==='branch').length}};
}

// ---------------------------------------------------------------------------
// replay.practice-history/2: statement text and source status, zero inference.
// ---------------------------------------------------------------------------

const DETAIL={maxPageSize:10,defaultPageSize:5,maxResponseChars:6000,statementChars:500,sourcesPerItem:5,relatedIds:2,idChars:200,maxScannedEvents:500,scanBatch:50} as const;
const DETAIL_NOTICE='Completed fictional exercise records only. Statement text is what the participant wrote, redacted and clipped. Decision-log statements are post-hoc; a statement without recorded authored timing is labelled unknown, never contemporaneous. A cited source is provenance, not a stated reason. Source status uses only reports released to the item\'s side, at the viewed tick and at the completed-record cutoff. Counts describe this page only; missing statements do not establish a weakness. Live attempts and model/private coaching traces are excluded.';
/** Redacted text clipped so both its length and its JSON-escaped length stay within `max`, without splitting a surrogate pair. */
function clip(v:unknown,max:number){
 if(typeof v!=='string')return {text:'',truncated:false};
 const full=text(v,Number.POSITIVE_INFINITY);let out=full.slice(0,max);
 const size=(s:string)=>JSON.stringify(s).length-2,trim=(s:string)=>/[\uD800-\uDBFF]$/.test(s)?s.slice(0,-1):s;
 out=trim(out);
 while(size(out)>max)out=trim(out.slice(0,Math.min(out.length-1,Math.floor(out.length*max/size(out)))));
 return {text:out,truncated:out.length<full.length};
}
const short=(max:number)=>(v:unknown)=>typeof v==='string'?clip(v,max).text:null;
const writtenOf=(kind:string,d:any)=>kind==='command'?d.rationale:kind==='decision_log'||kind==='assessment_log'?d.text:undefined;
/** Authored timing comes only from what was recorded; decision_log is post-hoc by construction whatever its details claim. */
function statementOf(e:any,d:any):PracticeStatement|null{
 const written=writtenOf(e.kind,d);
 if(typeof written!=='string'||!written.trim())return null;
 const {text:body,truncated}=clip(written.trim(),DETAIL.statementChars),at=typeof d.recordedAt==='string'?text(d.recordedAt,40):null;
 if(e.kind==='decision_log')return {text:body,truncated,timing:'post-hoc',authoredTick:Number(e.tick),authoredAt:at};
 if(e.kind==='assessment_log')return {text:body,truncated,timing:d.timing==='post-hoc'?'post-hoc':d.timing==='contemporaneous'&&at?'contemporaneous':'unknown',authoredTick:Number(e.tick),authoredAt:at};
 const submitted=finite(d.admittedTick)?d.admittedTick:null;
 return {text:body,truncated,timing:d.rationaleTiming==='contemporaneous'&&submitted!==null?'contemporaneous':d.rationaleTiming==='post-hoc'?'post-hoc':'unknown',authoredTick:submitted,authoredAt:null};
}
/** Literal match against the same redacted values the caller could read, so search cannot probe redacted secrets. */
function matchesRedacted(query:string,e:any,d:any,row:ExerciseRow){
 const needle=query.toLowerCase(),has=(v:unknown)=>typeof v==='string'&&text(v,Number.POSITIVE_INFINITY).toLowerCase().includes(needle);
 return has(e.summary)||has(e.kind)||has(row.name)||has(row.options?.scenarioId)||has(writtenOf(e.kind,d));
}

/**
 * Richer, separately versioned practice history: the participant's own written statement, its recorded
 * timing, the exact order reference and cited-source status at the viewed tick and at the completed cutoff.
 * Selection and authorization are exactly those of /1. Fresh identity and actor separation remain the caller's job.
 */
export function practiceHistoryDetails(service:GameService,config:AppConfig,identity:Identity,input:unknown):PracticeHistoryDetailsResult{
 const q=practiceHistoryDetailsQuery.parse(input);
 const {all,authorized,eligible,bounded,rows,byId}=practiceScope(service,config,identity,q);
 const db=service.store.db,authorizedIds=new Set(authorized.map(r=>r.id));
 // Scan newest first; rows matched only through a redacted value are dropped here, so paging continues past them.
 const matched:{e:any;d:any;row:ExerciseRow}[]=[];let cursor=q.beforeSequence,scanned=0,exhausted=!rows.length;
 while(!exhausted&&matched.length<=q.limit&&scanned<DETAIL.maxScannedEvents){
  const {where,params}=eventFilter(rows,{...q,beforeSequence:cursor},identity.subject,true),size=q.query?DETAIL.scanBatch:q.limit+1;
  const batch=db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE ${where} ORDER BY sequence DESC LIMIT ?`).all(...params,size) as any[];
  let consumed=0;
  for(const e of batch){
   scanned++;consumed++;cursor=Number(e.sequence);
   const row=byId.get(e.exercise_id)!,d=JSON.parse(e.details);
   if(!q.query||matchesRedacted(q.query,e,d,row))matched.push({e,d,row});
   if(matched.length>q.limit||scanned>=DETAIL.maxScannedEvents)break;
  }
  if(batch.length<size&&consumed===batch.length)exhausted=true;
 }
 const scanLimited=!exhausted&&matched.length<=q.limit;
 const reportCache=new Map<string,any[]>(),cutoffCache=new Map<string,number|null>();
 const sideReports=(exerciseId:string,side:string,tick:number)=>{
  const key=`${exerciseId} ${side} ${tick}`;
  // Re-project over this side's releases only, so correction and dispute links never name an opposing report.
  if(!reportCache.has(key))reportCache.set(key,projectEvidenceRecords(service.store.reports(exerciseId,tick).filter(r=>r.side===side)));
  return reportCache.get(key)!;
 };
 const cutoffOf=(exerciseId:string)=>{
  if(!cutoffCache.has(exerciseId)){const t=(db.prepare('SELECT MAX(tick) AS t FROM turns WHERE exercise_id=?').get(exerciseId) as {t:number|null}|undefined)?.t;cutoffCache.set(exerciseId,finite(t)?Number(t):null);}
  return cutoffCache.get(exerciseId)!;
 };
 const project=({e,d,row}:{e:any;d:any;row:ExerciseRow}):PracticeHistoryDetailItem=>{
  // Branch report IDs embed ancestor exercise IDs; hide any ancestor this caller cannot open.
  const mask=sourceIdMask(row,all,authorized);
  const side=typeof e.side==='string'?e.side:typeof row.humanSide==='string'?row.humanSide:null;
  const statement=statementOf(e,d),cited:string[]=Array.isArray(d.sourceIds)?[...new Set((d.sourceIds as unknown[]).filter((x):x is string=>typeof x==='string'))].slice(0,20):[];
  const exact=cited.filter(id=>clip(id,DETAIL.idChars).text===id);
  const basis=e.kind==='decision_log'?'order-observed-tick' as const:'observed-tick' as const,statusTick=e.kind==='decision_log'?(finite(d.orderObservedTick)?d.orderObservedTick:null):observedOf(d);
  const cutoff=cutoffOf(row.id);
  const statusIn=(reports:any[]|null,id:string,tick:number):PracticeSourceStatus=>{
   if(!reports)return {status:'not-evaluated'};
   const r=reports.find(x=>x.id===id);if(!r)return {status:'unavailable'};
   const visible=(x:unknown):x is string=>typeof x==='string'&&reports.some(o=>o.id===x);
   if(!r.packet){const s=sourceStatusAt(reports,id,tick);return s.status==='superseded'&&visible(s.supersededBy)?{status:'superseded',supersededBy:mask(s.supersededBy)}:{status:'current'};}
   if(r.evidenceStatus==='superseded'&&visible(r.supersededBy))return {status:'superseded',supersededBy:mask(r.supersededBy)};
   const disputes=(Array.isArray(r.disputedWith)?r.disputedWith:[]).filter(visible);
   if(r.evidenceStatus==='disputed'&&disputes.length)return {status:'disputed',disputedWith:disputes.slice(0,DETAIL.relatedIds).map(mask),...(disputes.length>DETAIL.relatedIds?{disputesOmitted:disputes.length-DETAIL.relatedIds}:{})};
   return {status:'current'};
  };
  const viewed=side&&statusTick!==null?sideReports(row.id,side,statusTick):null,later=side&&cutoff!==null?sideReports(row.id,side,cutoff):null;
  const sources:PracticeSourceDetail[]=exact.slice(0,DETAIL.sourcesPerItem).map(id=>{
   const atViewedTick=statusIn(viewed,id,statusTick??0),atCompletedCutoff=statusIn(later,id,cutoff??Number.MAX_SAFE_INTEGER);
   const lineageReports=later??viewed,r=lineageReports?.find(x=>x.id===id),lineage:{derivedFrom?:string;inheritedFrom?:string}={};
   if(r){
    if(typeof r.packet?.lineageRootId==='string'&&r.packet.lineageRootId!==id&&lineageReports!.some(x=>x.id===r.packet.lineageRootId))lineage.derivedFrom=mask(r.packet.lineageRootId);
    if(typeof r.parentSourceId==='string'&&typeof row.parentId==='string'&&authorizedIds.has(row.parentId))lineage.inheritedFrom=mask(r.parentSourceId);
   }
   return {id:mask(id),...lineage,atViewedTick,atCompletedCutoff};
  });
  let reference:PracticeHistoryDetailItem['reference']={commandId:null,commandEventId:null,orderTick:null};
  if(e.kind==='command')reference={commandId:short(80)(d.commandId),commandEventId:null,orderTick:null};
  else if(e.kind==='decision_log'&&typeof d.commandEventId==='string'){
   const order=db.prepare(`SELECT id,tick,json_extract(details,'$.commandId') AS commandId FROM events WHERE id=? AND exercise_id=? AND kind='command' AND json_extract(details,'$.origin')='human'${q.scope==='mine'?' AND actor=?':''}`).get(...[d.commandEventId,row.id,...(q.scope==='mine'?[identity.subject]:[])]) as {id:string;tick:number;commandId:unknown}|undefined;
   if(order)reference={commandId:short(80)(order.commandId),commandEventId:order.id,orderTick:Number(order.tick)};
  }
  return {eventId:e.id,sequence:Number(e.sequence),kind:e.kind,actor:clip(e.actor,120).text,side:e.side,summary:clip(e.summary,200).text,recordedAt:e.recorded_at,
   ticks:{recorded:Number(e.tick),observed:observedOf(d),observationBasis:short(60)(d.observationBasis)},
   exercise:exerciseOf(row,authorized,v=>clip(v,120).text,short(80)),
   commitmentRatio:commitmentOf(d),reason:statement?'written-statement':cited.length?'citation-only':'not-recorded',statement,reference,
   sources:{cited:cited.length,statusTick,statusTickBasis:statusTick===null?'not-recorded':basis,completedCutoffTick:cutoff,items:sources,truncated:exact.length>DETAIL.sourcesPerItem?'source-limit':null,omittedIds:cited.length-exact.length}};
 };
 const scenarioIds=[...new Set(bounded.map(r=>r.options?.scenarioId).filter((x):x is string=>typeof x==='string'&&clip(x,80).text===x))];
 const build=(items:PracticeHistoryDetailItem[],budgetCut:boolean,compacted=false):PracticeHistoryDetailsResult=>{
  const overflow=matched.length>items.length;
  return {schema:'replay.practice-history/2',scope:q.scope,fiction:true,query:q.query,items,hasMore:overflow||scanLimited,nextBeforeSequence:overflow?items.at(-1)!.sequence:scanLimited&&cursor!==undefined?cursor:null,
   page:{returned:items.length,requestedLimit:q.limit,truncatedBy:budgetCut||compacted?'character-budget':overflow?'page-limit':scanLimited?'scan-limit':null,scannedEvents:scanned},
   scenarioIds:scenarioIds.slice(0,5),
   summary:{basis:'returned-page-only',commands:items.filter(i=>i.kind==='command').length,decisionStatements:items.filter(i=>i.kind==='decision_log').length,assessments:items.filter(i=>i.kind==='assessment_log').length,watches:items.filter(i=>i.kind==='task_created').length,writtenStatements:items.filter(i=>i.statement).length,citationOnly:items.filter(i=>i.reason==='citation-only').length,branchEvents:items.filter(i=>i.exercise.kind==='branch').length},
   limits:{maxPageSize:DETAIL.maxPageSize,defaultPageSize:DETAIL.defaultPageSize,maxResponseChars:DETAIL.maxResponseChars,statementChars:DETAIL.statementChars,sourcesPerItem:DETAIL.sourcesPerItem,maxScannedEvents:DETAIL.maxScannedEvents,eligibleExercises:bounded.length,exerciseCatalogTruncated:eligible.length>bounded.length,scenarioCatalogTruncated:scenarioIds.length>5},
   notice:DETAIL_NOTICE};
 };
 // Fit the serialized page to the response budget by ending the page early, never by cutting JSON.
 let items=matched.slice(0,q.limit).map(project),budgetCut=false,result=build(items,false);
 const over=()=>JSON.stringify(result).length>DETAIL.maxResponseChars;
 while(over()&&items.length>1){items=items.slice(0,-1);budgetCut=true;result=build(items,true);}
 if(over()&&items.length===1){
  // A single oversized record keeps its identity, counts and a shorter statement; source details are withheld and say so.
  const [one]=items,c=one.statement&&clip(one.statement.text,160);
  items=[{...one,summary:clip(one.summary,120).text,exercise:{...one.exercise,name:clip(one.exercise.name,60).text},statement:one.statement&&c&&{...one.statement,text:c.text,truncated:one.statement.truncated||c.truncated},sources:{...one.sources,items:[],truncated:'character-budget'}}];
  result=build(items,budgetCut,true);
 }
 if(over())throw new ServiceError(500,'Practice history detail page exceeds its response bound');
 return result;
}
