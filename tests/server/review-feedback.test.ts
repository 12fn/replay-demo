import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DeterministicClient,type CompleteInput} from '../../src/inference/index';
import {exportAssessment} from '../../src/review/assessment';
import {REVIEW_FEEDBACK_EVENT_KIND,saveReviewFeedback} from '../../src/server/review-feedback';
import {mountReviewFeedbackRoutes} from '../../src/server/review-feedback-routes';
import {GameService,type Identity,type Session} from '../../src/server/service';

console.debug=()=>{};
const cleanup:(()=>void)[]=[];
afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));

const learner:Identity={subject:'review-learner',name:'Review Learner',role:'commander',organization:'Synthetic course',mode:'local-demo'};
const instructor:Identity={...learner,subject:'review-instructor',name:'Review Instructor',role:'instructor'};
const peer:Identity={...learner,subject:'review-peer',name:'Other Learner'};
const session=(identity:Identity,activeId:string,playbackTick:number|null=null):Session=>({identity,activeId,playbackTick,selectedSide:'blue'});

function generated(req:CompleteInput){
 const context=JSON.parse(req.input) as {commandEventId:string;availableThenIds:string[];hindsightIds:string[]};
 const eventId=context.commandEventId,before=context.availableThenIds.find(id=>id===`${eventId}:before`)??eventId,after=context.hindsightIds.find(id=>id===`${eventId}:after`);
 return {
  headline:{text:'The commitment used the estimate available at the order.',citations:[eventId]},
  observations:[{text:'The order committed forces from the recorded state.',citations:[before],basis:'available-then'}],
  opponentPerspective:[],tradeoffs:after?[{text:'The later state records the remaining force.',citations:[after],basis:'hindsight'}]:[],
  questions:[{text:'What result did you expect?',citations:[eventId]}],nextPractice:[{text:'Record the intended result before ordering.',citations:['C5']}],limitations:[{text:'This interpretation is provisional.',citations:[]}],
 };
}

async function fixture(existingDir?:string){
 const dir=existingDir??fs.mkdtempSync(path.join(os.tmpdir(),'replay-review-feedback-'));
 if(!existingDir)cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const service=new GameService(dir);cleanup.push(()=>{try{service.close();}catch{/* already closed by a restart assertion */}});
 if(existingDir){await service.init(false);const row=service.store.exercises()[0],event=service.store.events(row.id).find(e=>e.kind==='command'&&e.details.origin==='human')!;return {dir,service,row,event,record:null};}
 const row=await service.create('Claim review exercise','plains',learner),world=service.world(row.id);
 for(let n=0;n<20;n++)service.tick(world);
 service.command(row.id,'blue',{type:'attack',targetID:null,troops:10},'review-order',learner,'human');service.tick(world);service.tick(world);
 const event=service.store.events(row.id).find(e=>e.kind==='command'&&e.actor===learner.subject&&e.details.origin==='human')!;
 world.row.status='completed';world.row.kind='recorded';service.store.putExercise(world.row);
 service.luna=new DeterministicClient({respond:generated});
 const result=await service.debrief(session(learner,row.id),event.id);
 return {dir,service,row,event,record:result.record};
}

async function serve(service:GameService,initial:Session){
 let current=initial,native:unknown=undefined;
 const fresh=vi.fn((_q:any,_r:any,next:any)=>next()),write=vi.fn((_q:any,_r:any,next:any)=>next()),active=vi.fn((_q:any,_r:any,next:any)=>next());
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.session=current;if(native)res.locals.native=native;next();});
 app.locals.guards={requireFreshRead:fresh,requireWrite:write,requireActive:active};mountReviewFeedbackRoutes(app,service);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));cleanup.push(()=>server.close());
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const request=async(method:'GET'|'POST',url:string,body?:unknown)=>{const response=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,json:await response.json() as any};};
 return {request,as:(s:Session,n?:unknown)=>{current=s;native=n;},guards:{fresh,write,active}};
}

const body=(f:Awaited<ReturnType<typeof fixture>>,overrides:Record<string,unknown>={})=>({exerciseId:f.row.id,eventId:f.event.id,hash:f.record!.hash,section:'headline',index:0,disposition:'accepted',criterionId:'C2',explanation:'The cited event supports this bounded interpretation.',nextPractice:'Continue citing the exact order event.',requestId:randomUUID(),expectedReviewId:null,...overrides});
const query=(exerciseId:string,eventId:string,hash:string)=>`/api/learning/reviews?${new URLSearchParams({exerciseId,eventId,hash})}`;

describe('debrief claim review authorization and identity',()=>{
 it('allows only a writable instructor to append and lets only the debrief owner or instructor read',async()=>{
  const f=await fixture(),http=await serve(f.service,session(instructor,f.row.id));
 const created=await http.request('POST','/api/learning/reviews',body(f));
  expect(created.status).toBe(201);expect(created.json).toMatchObject({exerciseId:f.row.id,eventId:f.event.id,hash:f.record!.hash,author:instructor.subject,originalText:f.record!.debrief.headline.text,originalCitations:f.record!.debrief.headline.citations});
  expect(created.json).not.toHaveProperty('score');
  http.as(session(learner,f.row.id));const own=await http.request('GET',query(f.row.id,f.event.id,f.record!.hash));
  expect(own.status).toBe(200);expect(own.json).toMatchObject({canReview:false,truncated:false,reviews:[{id:created.json.id}]});expect(own.json.criteria[0]).toEqual({id:'C1',name:'Evidence currency',objective:'OBJ-1'});
  expect((await http.request('POST','/api/learning/reviews',body(f))).status).toBe(403);
  http.as(session(peer,f.row.id));expect((await http.request('GET',query(f.row.id,f.event.id,f.record!.hash))).status).toBe(403);
  const explanation=created.json.explanation;
  expect(JSON.stringify(await f.service.overview(session(instructor,f.row.id)))).toContain(explanation);
  expect(JSON.stringify(await f.service.overview(session(learner,f.row.id)))).toContain(explanation);
  expect(JSON.stringify(await f.service.overview(session(peer,f.row.id)))).not.toContain(explanation);
  const instructorExport=exportAssessment(f.service,session(instructor,f.row.id)),learnerExport=exportAssessment(f.service,session(learner,f.row.id)),peerExport=exportAssessment(f.service,session(peer,f.row.id));
  expect(JSON.stringify(instructorExport)).toContain(explanation);expect(JSON.stringify(learnerExport)).toContain(explanation);expect(JSON.stringify(peerExport)).not.toContain(explanation);
  expect(learnerExport.payload.debriefs.some((d:any)=>d.hash===f.record!.hash)).toBe(true);
  const branch=await f.service.branch(f.row.id,f.service.world(f.row.id).engine.game.ticks(),'blue',learner);
  expect(f.service.store.events(branch.id).some(e=>e.kind===REVIEW_FEEDBACK_EVENT_KIND||e.kind==='inherited_event'&&e.details.originalKind===REVIEW_FEEDBACK_EVENT_KIND)).toBe(false);
  const nativeInstructor={...instructor,mode:'kamiwaza' as const};
  http.as(session(nativeInstructor,f.row.id),{identity:{subject:nativeInstructor.subject},context:{canEdit:false}});
  const readOnly=await http.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(readOnly.status).toBe(200);expect(readOnly.json.canReview).toBe(false);
  expect((await http.request('POST','/api/learning/reviews',body(f))).status).toBe(403);
  http.as(session(instructor,f.row.id,created.json.tick??f.event.tick));
  const historical=await http.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(historical.status).toBe(200);expect(historical.json.canReview).toBe(false);
  expect((await http.request('POST','/api/learning/reviews',body(f,{expectedReviewId:created.json.id}))).status).toBe(409);
  expect(http.guards.fresh).toHaveBeenCalled();expect(http.guards.write).toHaveBeenCalled();expect(http.guards.active).toHaveBeenCalled();
 });
});

describe('review compare-and-swap and request idempotency',()=>{
 it('returns the same event for the same request and rejects payload conflicts or a stale parent',async()=>{
  const f=await fixture(),http=await serve(f.service,session(instructor,f.row.id)),requestId=randomUUID(),firstBody=body(f,{requestId});
  const first=await http.request('POST','/api/learning/reviews',firstBody),retry=await http.request('POST','/api/learning/reviews',firstBody);
  expect(first.status).toBe(201);expect(retry.status).toBe(200);expect(retry.json).toEqual(first.json);
  expect(f.service.store.events(f.row.id).filter(e=>e.kind===REVIEW_FEEDBACK_EVENT_KIND)).toHaveLength(1);
  expect((await http.request('POST','/api/learning/reviews',{...firstBody,explanation:'A conflicting explanation.'})).status).toBe(409);
  expect((await http.request('POST','/api/learning/reviews',body(f,{requestId:randomUUID(),explanation:'A second revision without its parent.'}))).status).toBe(409);
  const second=await http.request('POST','/api/learning/reviews',body(f,{requestId:randomUUID(),expectedReviewId:first.json.id,disposition:'edited',editedText:'The estimate was current when the commitment was made.',explanation:'The original wording overstated what the event proves.'}));
  expect(second.status).toBe(201);expect(second.json.previousId).toBe(first.json.id);
  const history=await http.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(history.json.reviews.map((r:any)=>r.id)).toEqual([first.json.id,second.json.id]);
 });
});

describe('debrief version and claim binding',()=>{
 it('guards the active run, exact hash, generated claim, and current curriculum',async()=>{
  const f=await fixture(),http=await serve(f.service,session(instructor,f.row.id));
  expect((await http.request('GET',query(randomUUID(),f.event.id,f.record!.hash))).status).toBe(409);
  expect((await http.request('GET',query(f.row.id,f.event.id,'0'.repeat(64)))).status).toBe(404);
  expect((await http.request('POST','/api/learning/reviews',body(f,{section:'headline',index:1}))).status).toBe(400);
  expect((await http.request('POST','/api/learning/reviews',body(f,{section:'observations',index:99}))).status).toBe(400);
  expect((await http.request('POST','/api/learning/reviews',body(f,{criterionId:'C999'}))).status).toBe(400);
  expect((await http.request('POST','/api/learning/reviews',body(f,{disposition:'edited'}))).status).toBe(400);
  expect((await http.request('POST','/api/learning/reviews',body(f,{editedText:'Unexpected edit'}))).status).toBe(400);
 });

 it('keeps reviewed old versions readable but rejects a new write against their stale hash',async()=>{
  const f=await fixture(),http=await serve(f.service,session(instructor,f.row.id)),first=await http.request('POST','/api/learning/reviews',body(f));expect(first.status).toBe(201);
  f.service.store.event(f.row.id,f.event.tick+1,'decision_log',learner.subject,'Later explanation',{commandId:f.event.details.commandId,commandEventId:f.event.id,text:'A later explanation changed the debrief context.',timing:'post-hoc',sourceIds:[]},'blue');
  const regenerated=await f.service.debrief(session(learner,f.row.id),f.event.id);expect(regenerated.record.hash).not.toBe(f.record!.hash);
  const old=await http.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(old.status).toBe(200);expect(old.json.canReview).toBe(false);expect(old.json.reviews[0]).toMatchObject({id:first.json.id,originalText:f.record!.debrief.headline.text});
  expect((await http.request('POST','/api/learning/reviews',body(f,{requestId:randomUUID()}))).status).toBe(409);
  const exactRetry=await http.request('POST','/api/learning/reviews',{...body(f),requestId:(f.service.store.events(f.row.id).find(e=>e.id===first.json.id)!.details.requestId)});expect(exactRetry.status).toBe(200);expect(exactRetry.json.id).toBe(first.json.id);
  const current=await http.request('GET',query(f.row.id,f.event.id,regenerated.record.hash));expect(current.status).toBe(200);expect(current.json.reviews).toEqual([]);
 });
});

describe('bounded durable revision history',()=>{
 it('survives restart, truncates to the latest 100, and filters reviews after a replay cutoff',async()=>{
  const f=await fixture();let expected:string|null=null;
  for(let n=0;n<101;n++){
   const saved=saveReviewFeedback(f.service,session(instructor,f.row.id),body(f,{requestId:randomUUID(),expectedReviewId:expected,explanation:`Instructor revision ${n}.`}));expected=saved.storedReview.id;
  }
  const reviewTick=f.service.store.events(f.row.id).find(e=>e.kind===REVIEW_FEEDBACK_EVENT_KIND)!.tick;
  const before=await serve(f.service,session(learner,f.row.id,Math.max(0,reviewTick-1))),hidden=await before.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(hidden.status).toBe(200);expect(hidden.json.reviews).toEqual([]);
  before.as(session(learner,f.row.id));const bounded=await before.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(bounded.json.truncated).toBe(true);expect(bounded.json.reviews).toHaveLength(100);expect(bounded.json.reviews.at(-1).id).toBe(expected);
  f.service.close();
  const restarted=new GameService(f.dir);cleanup.push(()=>restarted.close());await restarted.init(false);
  const after=await serve(restarted,session(learner,f.row.id)),durable=await after.request('GET',query(f.row.id,f.event.id,f.record!.hash));expect(durable.status).toBe(200);expect(durable.json.reviews).toHaveLength(100);expect(durable.json.reviews.at(-1).id).toBe(expected);
 });
});
