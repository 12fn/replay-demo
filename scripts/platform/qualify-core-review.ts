/** One labelled native exercise, one actual cached Luna debrief, and automated instructor revisions.
 * Never changes existing exercises. No retries of creation, order, or paid generation.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(/^\d+\.\d+\.\d+$/.test(version));
const attempt=process.argv[3]??'';assert(/^[a-z0-9-]*$/.test(attempt));
const artifact=`evidence/platform/core-review-${version}${attempt?'-'+attempt:''}.json`;assert(!fs.existsSync(artifact));
const proof:any={at:new Date().toISOString(),version,automated:true,humanValidated:false,requests:[],status:'running',paidGenerationAttempts:0};
const save=()=>fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n');save();
type Client=Awaited<ReturnType<typeof nativeAppClient>>;
const clients:Client[]=[];let commander:Client|undefined,instructor:Client|undefined,peer:Client|undefined,exerciseId:string|undefined,creationAttempted=false;
const name=`Automated instructor feedback qualification ${version} ${randomUUID().slice(0,8)}`;
const j=async(c:Client,p:string,b?:unknown,timeout=20000)=>{
 const r=await c.requestRaw(p,b,{signal:AbortSignal.timeout(timeout)});proof.requests.push({path:p,method:b===undefined?'GET':'POST',status:r.status});assert(r.ok,`HTTP ${r.status} at ${p}`);return r.json() as Promise<any>;
};
try{
 const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
 commander=await nativeAppClient(users.find((u:any)=>u.role==='commander'));clients.push(commander);
 instructor=await nativeAppClient();clients.push(instructor);
 peer=await nativeAppClient(users.find((u:any)=>u.role==='intelligence'));clients.push(peer);
 for(const u of users)u.password='';
 assert.equal((await j(commander,'/replay-build.json')).version,version);
 // Budget is global; the instructor's default exercise is visible before the new participant run exists.
 proof.budgetBefore=(await j(instructor,'/api/agents/tools')).budget;
 assert(proof.budgetBefore.maxRequests-proof.budgetBefore.requestsUsed>=1,'One inference request must remain');
 creationAttempted=true;const ex=await j(commander,'/api/exercises',{name,scenarioId:'crosscurrent-evidence/1'});exerciseId=ex.id;proof.exerciseId=exerciseId;save();
 assert(ex.agentEnabled===false);await j(instructor,'/api/select',{exerciseId});
 const invitation=await j(instructor,'/api/team/code',{});await j(peer,'/api/team/join',{code:invitation.code});invitation.code='';
 let ov:any;for(let n=0;n<15;n++){ov=await j(commander,'/api/overview');if(ov.state.tick>=20)break;await delay(500);}
 assert(ov.state.tick>=20&&ov.observationReceipt);const report=ov.reports.find((r:any)=>r.side==='blue');assert(report);
 const command=await j(commander,'/api/commands',{side:'blue',idempotencyKey:randomUUID(),intent:{type:'attack',targetID:null,troops:10},observationReceipt:ov.observationReceipt,rationale:'Automated functional qualification: small neutral expansion; the source-desk report is an authored claim, not a measurement.',sourceIds:[report.id]});
 let event:any;for(let n=0;n<20;n++){ov=await j(commander,'/api/overview');event=ov.timeline.find((e:any)=>e.kind==='command'&&e.details?.commandId===command.id);if(event)break;await delay(300);}
 assert(event,'Queued command must be observed before finishing');proof.commandEventId=event.id;
 await j(commander,`/api/exercises/${exerciseId}/finish`,{});proof.exerciseFinished=true;
 proof.paidGenerationAttempts=1;save();
 const generated=await j(commander,'/api/learning/debrief',{eventId:event.id},150000);assert.equal(generated.status,'generated');proof.debrief={eventId:event.id,hash:generated.record.hash,receiptId:generated.record.receipt.id,modelReturned:generated.record.receipt.modelReturned};
 const original=JSON.stringify(generated.record),query='/api/learning/reviews?'+new URLSearchParams({exerciseId:exerciseId!,eventId:event.id,hash:generated.record.hash});
 const observed=await j(instructor,`/api/learning/debrief/${event.id}`);assert.equal(JSON.stringify(observed.record),original);
 const initial=await j(instructor,query);assert(initial.canReview&&initial.reviews.length===0);
 const body={exerciseId,eventId:event.id,hash:generated.record.hash,section:'headline',index:0,disposition:'accepted',criterionId:initial.criteria[0].id,explanation:'Automated qualification only: this records an example instructor acceptance, not a human assessment.',nextPractice:'Automated example: inspect the cited order and ask what evidence supported it.',requestId:randomUUID(),expectedReviewId:null};
 const accepted=await j(instructor,'/api/learning/reviews',body),duplicate=await j(instructor,'/api/learning/reviews',body);assert.equal(accepted.id,duplicate.id);
 const edited=await j(instructor,'/api/learning/reviews',{...body,requestId:randomUUID(),expectedReviewId:accepted.id,disposition:'edited',editedText:'Automated qualification example: an order and its sources were recorded; learning quality remains for an actual instructor to judge.',explanation:'Automated qualification only: correction history keeps this interpretation distinct from the original AI claim.'});
 const history=await j(commander,query);assert.equal(history.reviews.length,2);assert.equal(history.canReview,false);assert.equal(history.reviews.at(-1).id,edited.id);
 const denied=await peer.requestRaw(query);assert.equal(denied.status,403);
 const peerOverview=await j(peer,'/api/overview');assert(!JSON.stringify(peerOverview).includes(edited.explanation));
 const ownerOverview=await j(commander,'/api/overview');assert(JSON.stringify(ownerOverview).includes(edited.explanation));
 assert.equal(JSON.stringify((await j(commander,`/api/learning/debrief/${event.id}`)).record),original);
 proof.feedback={acceptedId:accepted.id,editedId:edited.id,duplicateId:duplicate.id,peerStatus:denied.status,learnerVersions:history.reviews.length,originalDebriefUnchanged:true,personalOverviewScoped:true};
 proof.status='passed';
}catch(error){proof.status='failed';proof.failure=error instanceof Error?error.message:'Qualification failed';}
finally{
 if(commander&&creationAttempted&&!exerciseId){try{const ov=await j(commander,'/api/overview');const matches=ov.exercises.filter((e:any)=>e.name===name);if(matches.length===1){exerciseId=matches[0].id;proof.exerciseId=exerciseId;}}catch{proof.creationRecoveryFailed=true;}}
 if(commander&&exerciseId&&!proof.exerciseFinished){try{await j(commander,`/api/exercises/${exerciseId}/finish`,{});proof.exerciseFinished=true;}catch{proof.status='failed';proof.cleanupFailure=true;}}
 if(instructor){try{proof.budgetAfter=(await j(instructor,'/api/agents/tools')).budget;proof.newPaidRequests=proof.budgetAfter.requestsUsed-proof.budgetBefore.requestsUsed;assert(proof.newPaidRequests<=1);}catch{proof.status='failed';proof.budgetCheckFailed=true;}}
 for(const c of clients.reverse())await c.close().catch(()=>{});
 proof.finishedAt=new Date().toISOString();save();
}
console.log(JSON.stringify({artifact,status:proof.status,exerciseId,newPaidRequests:proof.newPaidRequests,exerciseFinished:proof.exerciseFinished,failure:proof.failure??null}));if(proof.status!=='passed')process.exitCode=1;
