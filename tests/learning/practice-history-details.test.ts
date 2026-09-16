import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {GameService,type Identity} from '../../src/server/service';
import {practiceHistory,practiceHistoryDetails} from '../../src/server/practice-history';
import type {KamiwazaConfig} from '../../src/server/native-http';
import type {ExerciseRow} from '../../src/server/store';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
const config:KamiwazaConfig={mode:'kamiwaza',apiBase:'https://example.invalid/api',workroomId:'room',forwardedHost:'example.invalid',forwardedProto:'https',allowedOrigins:[],cookieSecure:true,allowLegacyRecordings:true};
const person=(subject='alice',role:Identity['role']='commander'):Identity=>({subject,name:subject,role,mode:'kamiwaza',organization:'fictional'});
let created=0;
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'practice-details-')),s=new GameService(dir);clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}),()=>s.close());
 const row=(owner='alice',opts:{room?:string|null;kind?:ExerciseRow['kind'];status?:string;name?:string;parent?:ExerciseRow;humanSide?:'blue'|'red'}={}):ExerciseRow=>{
  const r:ExerciseRow={id:randomUUID(),name:opts.name??'Practice',kind:opts.kind??'recorded',status:opts.status??'completed',createdAt:new Date(Date.UTC(2026,8,1,0,0,created++)).toISOString(),humanSide:opts.humanSide??'blue',agentEnabled:false,options:{ownerSubject:owner,workroomId:opts.room===undefined?'room':opts.room,scenarioId:'station-practice',scenario:{id:'crosscurrent-objectives/1'},map:'world-500',simulationProfile:'naval-isolation/1',curriculumVersion:'0.1.0',assistance:'unassisted'}};
  if(opts.parent){r.parentId=opts.parent.id;r.forkTick=10;}
  s.store.putExercise(r);return r;
 };
 const command=(r:ExerciseRow,actor='alice',details:Record<string,unknown>={},summary='Expanded with 40 forces',tick=600,side='blue')=>s.store.event(r.id,tick,'command',actor,summary,{origin:'human',commandId:randomUUID(),intent:{type:'attack',troops:40},observedTick:590,admittedTick:595,observation:{tick:590,player:{troops:100}},...details},side);
 const log=(r:ExerciseRow,commandEventId:string,text:string,actor='alice',details:Record<string,unknown>={})=>s.store.event(r.id,800,'decision_log',actor,'Post-hoc decision statement for the order at tick 600',{commandEventId,text,sourceIds:[],timing:'post-hoc',author:actor,orderTick:600,orderObservedTick:590,recordedAt:'2026-09-01T01:00:00.000Z',...details},'blue');
 const packet=(r:ExerciseRow,id:string,tick:number,side:'blue'|'red',links:{kind:string;reportId:string}[]=[],lineageRootId=id)=>s.store.putReport(r.id,{id,tick,side,title:`Title ${id}`,body:`Body ${id} withheld-body`,source:'Station desk',confidence:'Fictional scenario claim; unverified.',synthetic:true,...(links.some(l=>l.kind==='supersedes')?{supersedes:links.find(l=>l.kind==='supersedes')!.reportId}:{}),packet:{id:'pk',reportId:id,sourceId:'station',entityId:'marsh',observedTick:tick,releaseTick:tick,sourceRelationship:'independent',links,lineageRootId,claimStatus:'fictional-scenario-claim',authoritativeState:false}});
 const read=(q:unknown={},who=person())=>practiceHistoryDetails(s,config,who,q);
 return {s,row,command,log,packet,read};
}
/** Replace generated UUIDs and wall-clock timestamps with first-appearance tokens so the /1 bytes can be hashed. */
function normalized(value:unknown){
 const ids=new Map<string,string>();
 return JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,m=>{if(!ids.has(m))ids.set(m,`uuid-${ids.size}`);return ids.get(m)!;}).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,'<time>');
}
function v1Fixture(){
 const {s,row,command,log}=setup();
 const own=row('alice',{name:'Marsh practice'}),peer=row('bob'),parent=row('carol',{room:'other'}),branch=row('alice',{kind:'branch',parent,name:'Branch'}),shared=row('bob',{name:'Shared'});
 s.teams.enroll(shared,person(),1);
 const a=command(own,'alice',{rationale:'hold Marsh reserve until correction sk-abcdefghijklmnopqrstuv',rationaleTiming:'contemporaneous',sourceIds:['blue-r02']});
 log(own,a,'Marsh looked quiet');
 s.store.event(own.id,700,'assessment_log','alice','Assessment: "quoted" text',{text:'Assessment full',sourceIds:['blue-r02'],timing:'contemporaneous',observedTick:690},'blue');
 s.store.event(own.id,710,'task_created','alice','Watch Marsh',{taskId:'t1'},'blue');
 command(peer,'bob',{rationale:'bob private reason'});command(branch,'alice',{},'Branch order',20);
 s.store.event(branch.id,5,'inherited_event','carol','inherited',{parentEventId:'x',parentId:parent.id},'blue');command(shared,'alice',{sourceIds:['a','b']},'Shared order');command(row('alice',{status:'running',kind:'live'}));
 const reads=[{},{limit:2},{query:'marsh'},{query:'Marsh'},{query:'station'},{scenarioId:'none'},{query:"' OR 1=1 --"}].map(q=>practiceHistory(s,config,person(),q));
 reads.push(practiceHistory(s,config,person(),{limit:1,beforeSequence:reads[1].nextBeforeSequence}));
 reads.push(practiceHistory(s,config,person('teacher','instructor'),{scope:'workroom'}),practiceHistory(s,config,person('teacher','instructor'),{scope:'workroom',query:'private'}));
 return reads;
}
it('keeps replay.practice-history/1 response bytes and query semantics unchanged',()=>{
 const out=normalized(v1Fixture()),hash=createHash('sha256').update(out).digest('hex');
 // Captured from the unmodified /1 implementation before the shared helpers were extracted; a change here is a /1 contract break.
 expect(hash).toBe('1604d9abd8411e347549d6de7f8e2e7fec21a0ce1ccaeaa694941a8b99727326');
});
it('finds own written reasons and reports cited-source status at the viewed tick and at the completed cutoff, side-scoped',()=>{
 const {s,row,command,log,packet,read}=setup(),ex=row('alice',{name:'Marsh practice'});
 packet(ex,'blue-r01',100,'blue');packet(ex,'blue-r02',200,'blue');packet(ex,'blue-r03',400,'blue',[{kind:'disputes',reportId:'blue-r01'}]);packet(ex,'blue-r04',600,'blue',[{kind:'supersedes',reportId:'blue-r02'}]);
 packet(ex,'red-r09',300,'red',[{kind:'supersedes',reportId:'blue-r02'},{kind:'disputes',reportId:'blue-r01'}]);s.store.recordTurn(ex.id,900,{},'fp');
 const order=command(ex,'alice',{rationale:'hold Marsh reserve until correction',rationaleTiming:'contemporaneous',sourceIds:['blue-r02','blue-r01']});
 const note=log(ex,order,'In hindsight Marsh was stale','alice',{timing:'contemporaneous',sourceIds:['blue-r02']});
 command(ex,'alice',{sourceIds:['blue-r04','red-r09']},'Citation only');
 expect(practiceHistory(s,config,person(),{query:'marsh reserve'}).items).toEqual([]);
 const found=read({query:'MARSH reserve'});expect(found.schema).toBe('replay.practice-history/2');expect(found.items).toHaveLength(1);
 expect(found.items[0]).toMatchObject({eventId:order,reason:'written-statement',ticks:{recorded:600,observed:590},statement:{text:'hold Marsh reserve until correction',truncated:false,timing:'contemporaneous',authoredTick:595},reference:{commandEventId:null},
  sources:{cited:2,statusTick:590,statusTickBasis:'observed-tick',completedCutoffTick:900,truncated:null,items:[
   {id:'blue-r02',atViewedTick:{status:'current'},atCompletedCutoff:{status:'superseded',supersededBy:'blue-r04'}},
   {id:'blue-r01',atViewedTick:{status:'disputed',disputedWith:['blue-r03']},atCompletedCutoff:{status:'disputed',disputedWith:['blue-r03']}}]}});
 const later=read({query:'hindsight'}).items[0];
 expect(later).toMatchObject({eventId:note,kind:'decision_log',statement:{timing:'post-hoc',authoredTick:800,authoredAt:'2026-09-01T01:00:00.000Z'},reference:{commandEventId:order,orderTick:600},sources:{statusTick:590,statusTickBasis:'order-observed-tick',items:[{id:'blue-r02',atViewedTick:{status:'current'}}]}});
 const citation=read({query:'citation only'}).items[0];
 expect(citation).toMatchObject({reason:'citation-only',statement:null});
 expect(citation.sources.items).toEqual([{id:'blue-r04',atViewedTick:{status:'unavailable'},atCompletedCutoff:{status:'current'}},{id:'red-r09',atViewedTick:{status:'unavailable'},atCompletedCutoff:{status:'unavailable'}}]);
 const all=JSON.stringify(read({limit:10}));expect(all).not.toMatch(/withheld-body|Title blue|Station desk/);expect(all.match(/red-r09/g)).toHaveLength(1);
});
it('keeps actor, workroom, instructor, completion and enrollment boundaries of /1',()=>{
 const {s,row,command,log,read}=setup(),ex=row('alice'),other=row('alice',{room:'other'}),live=row('alice',{status:'running',kind:'live'}),shared=row('bob');
 const aliceOrder=command(ex,'alice',{rationale:'alice marsh note'});command(ex,'bob',{rationale:'bob marsh note'});log(ex,aliceOrder,'bob marsh log on alice order','bob');
 command(other,'alice',{rationale:'other room marsh'});command(live,'alice',{rationale:'live marsh'});s.teams.enroll(shared,person(),1);command(shared,'alice',{rationale:'shared marsh'});
 expect(read({query:'marsh'}).items.map(i=>i.statement?.text)).toEqual(['shared marsh','alice marsh note']);
 expect(()=>read({scope:'workroom'})).toThrow('instructor');expect(()=>read({},{...person(),mode:'local-demo'})).toThrow('identity');
 const teacher=read({scope:'workroom',query:'marsh',limit:10},person('teacher','instructor'));
 expect(teacher.items.map(i=>i.statement?.text)).toEqual(['shared marsh','bob marsh log on alice order','bob marsh note','alice marsh note']);
 expect(teacher.items[1].reference).toMatchObject({commandEventId:aliceOrder});expect(JSON.stringify(teacher)).not.toMatch(/other room|live marsh/);
 s.teams.remove(shared,'alice','bob');expect(read({query:'marsh'}).items.map(i=>i.statement?.text)).toEqual(['alice marsh note']);
});
it('withholds an order reference the caller cannot read in personal scope',()=>{
 const {s,row,command,log,read}=setup(),ex=row('alice');s.teams.enroll(ex,person('bob'),1);
 const order=command(ex,'alice',{rationale:'alice order'});log(ex,order,'bob annotation','bob');
 // Bob's own statement stays readable to Bob; the order it names belongs to Alice and is not echoed back.
 const own=read({query:'annotation'},person('bob'));expect(own.items).toHaveLength(1);
 expect(own.items[0]).toMatchObject({statement:{text:'bob annotation',timing:'post-hoc'},reference:{commandId:null,commandEventId:null,orderTick:null}});
 expect(JSON.stringify(own)).not.toMatch(new RegExp(`${order}|alice order`));
});
it('labels timing only from recorded fields and never treats a citation as a reason',()=>{
 const {s,row,command,log,read}=setup(),ex=row('alice');
 const unlabeled=command(ex,'alice',{rationale:'no timing label'},'A');
 const noTick=command(ex,'alice',{rationale:'label but no admission tick',rationaleTiming:'contemporaneous',admittedTick:undefined},'B');
 const logged=log(ex,unlabeled,'decision log with no timing','alice',{timing:undefined,recordedAt:undefined});
 const assessment=s.store.event(ex.id,700,'assessment_log','alice','Assessment',{text:'assessment without authored time',timing:'contemporaneous',observedTick:690},'blue');
 const by=Object.fromEntries(read({limit:10}).items.map(i=>[i.eventId,i]));
 expect(by[unlabeled].statement).toMatchObject({timing:'unknown',authoredTick:595});
 expect(by[noTick].statement).toMatchObject({timing:'unknown',authoredTick:null});
 expect(by[logged].statement).toEqual({text:'decision log with no timing',truncated:false,timing:'post-hoc',authoredTick:800,authoredAt:null});
 expect(by[assessment].statement).toMatchObject({timing:'unknown',authoredAt:null});
 expect(JSON.stringify(read({limit:10}))).not.toMatch(/"timing":"contemporaneous"/);
});
it('redacts statement text and does not let search probe redacted secrets',()=>{
 const {row,command,read}=setup(),ex=row('alice');
 command(ex,'alice',{rationale:'use key sk-abcdefghijklmnopqrstuvwxyz and Bearer abcdefghijklmnopqrstuvwxyz0123456789 now'});
 const out=read({query:'use key'});expect(out.items).toHaveLength(1);expect(out.items[0].statement!.text).toContain('[redacted]');expect(JSON.stringify(out)).not.toMatch(/abcdefghijklmnop/);
 expect(read({query:'sk-abcdefgh'}).items).toEqual([]);expect(read({query:'sk-abcdefgh'}).hasMore).toBe(false);
 expect(read({query:"' OR 1=1 --"}).items).toEqual([]);expect(read({query:'%'}).items).toEqual([]);
 expect(()=>read({limit:11})).toThrow();expect(()=>read({subject:'bob'})).toThrow();
});
it('bounds each page by characters with explicit continuation rather than cutting JSON',()=>{
 const {s,row,command,packet,read}=setup(),ex=row('alice',{name:'N'.repeat(400)});
 const ids=Array.from({length:6},(_,i)=>`${String(i).padStart(2,'0')}-${'x'.repeat(197)}`);ids.forEach((id,i)=>packet(ex,id,i,'blue'));
 const orders=Array.from({length:10},(_,i)=>command(ex,'alice',{rationale:`${i} `+'"\\'.repeat(700),sourceIds:ids},'S'.repeat(600)));
 const seen:string[]=[];let before:number|undefined,pages=0;
 for(;;){
  const page=read({limit:10,...(before?{beforeSequence:before}:{})}),json=JSON.stringify(page);pages++;
  expect(json.length).toBeLessThanOrEqual(page.limits.maxResponseChars);expect(page.items.length).toBeGreaterThan(0);
  for(const item of page.items){expect(item.statement!.text.length).toBeLessThanOrEqual(500);expect(JSON.stringify(item.statement!.text).length-2).toBeLessThanOrEqual(500);expect(item.statement!.truncated).toBe(true);expect(item.sources).toMatchObject({cited:6,truncated:expect.stringMatching(/source-limit|character-budget/)});}
  seen.push(...page.items.map(i=>i.eventId));
  if(!page.hasMore){expect(page.nextBeforeSequence).toBe(null);break;}
  expect(page.page.truncatedBy).toBe('character-budget');before=page.nextBeforeSequence!;
 }
 expect(pages).toBeGreaterThan(1);expect(seen).toEqual([...orders].reverse());
 expect(read().items.length).toBeLessThanOrEqual(5);
});
it('compacts a single oversized record and says which details were withheld',()=>{
 const {row,command,packet,read}=setup(),ex=row('alice');
 const long=(tag:string)=>`${tag}-${'y'.repeat(200-tag.length-1)}`,cited=['a','b','c','d','e'].map(long);
 cited.forEach((id,i)=>{packet(ex,id,1,'blue');for(const n of [1,2,3])packet(ex,long(`${i}${n}`),2,'blue',[{kind:'disputes',reportId:id}]);});
 command(ex,'alice',{rationale:'"'.repeat(500),sourceIds:cited});
 const out=read();expect(JSON.stringify(out).length).toBeLessThanOrEqual(6000);
 expect(out).toMatchObject({hasMore:false,nextBeforeSequence:null,page:{truncatedBy:'character-budget',returned:1}});
 expect(out.items[0].sources).toMatchObject({cited:5,items:[],truncated:'character-budget'});expect(out.items[0].statement).toMatchObject({truncated:true});
});
it('keeps branch history single-counted and hides inaccessible ancestors, including inside source IDs',()=>{
 const {s,row,command,read}=setup(),hiddenParent=row('carol',{room:'other'}),branch=row('alice',{kind:'branch',parent:hiddenParent,name:'Hidden branch'});
 const copied=`${branch.id}:${hiddenParent.id}:r1`;s.store.putReport(branch.id,{id:copied,tick:5,side:'blue',title:'t',parentSourceId:`${hiddenParent.id}:r1`});
 s.store.event(branch.id,5,'inherited_event','carol','inherited marsh',{parentEventId:'p',parentId:hiddenParent.id,originalKind:'command',originalDetails:{rationale:'inherited marsh reason'}},'blue');
 command(branch,'alice',{rationale:'branch marsh',rationaleTiming:'contemporaneous',sourceIds:[copied]});
 const hidden=read({query:'marsh'});expect(hidden.items).toHaveLength(1);expect(hidden.summary.branchEvents).toBe(1);
 expect(hidden.items[0].exercise).toMatchObject({kind:'branch',parentId:null,forkTick:10});expect(hidden.items[0].sources.items[0]).toEqual({id:`${branch.id}:[unavailable-exercise]:r1`,atViewedTick:{status:'current'},atCompletedCutoff:{status:'not-evaluated'}});
 expect(JSON.stringify(hidden)).not.toContain(hiddenParent.id);
 const parent=row('alice',{name:'Own parent'}),own=row('alice',{kind:'branch',parent}),copy=`${own.id}:${parent.id}:r1`;
 s.store.putReport(own.id,{id:copy,tick:5,side:'blue',title:'t',parentSourceId:`${parent.id}:r1`});command(own,'alice',{rationale:'own branch',sourceIds:[copy]});
 const visible=read({query:'own branch'}).items[0];expect(visible.exercise.parentId).toBe(parent.id);expect(visible.sources.items[0]).toMatchObject({id:copy,inheritedFrom:`${parent.id}:r1`});
});
it('reads only retained SQL records: no budget reservation, session or model call',()=>{
 const {s,row,command,read}=setup(),ex=row('alice');command(ex,'alice',{rationale:'zero inference'});
 const before=s.ledger.summary();expect(read({query:'zero'}).items).toHaveLength(1);expect(s.ledger.summary()).toEqual(before);
 expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0);
});

it('does not invent a completed cutoff when the retained exercise has no recorded turns',()=>{
 const {row,command,packet,read}=setup(),ex=row();packet(ex,'report-before',5,'blue');packet(ex,'correction-after',700,'blue',[{kind:'supersedes',reportId:'report-before'}]);
 command(ex,'alice',{rationale:'No retained completed cutoff',sourceIds:['report-before']});
 const item=read().items[0];expect(item.sources.completedCutoffTick).toBeNull();expect(item.sources.items[0]).toMatchObject({atViewedTick:{status:'current'},atCompletedCutoff:{status:'not-evaluated'}});
});
