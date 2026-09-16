/** Real native roles; synthetic unscored review entries only. Never model inference or human assessment. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {nativeAppClient} from './native-app-client';
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const commander=await nativeAppClient(users.find((u:any)=>u.role==='commander')),analyst=await nativeAppClient(users.find((u:any)=>u.role==='intelligence')),instructor=await nativeAppClient();
const json=async(c:typeof commander,p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const exerciseId='628c219e-e078-41d5-9d8d-0979ca799bed';
try{
 const build=await json(instructor,'/replay-build.json');assert.equal(build.version,'0.6.0','Only qualify the reviewed target-aware release');
 for(const c of [commander,analyst,instructor])await json(c,'/api/select',{exerciseId});
 const cmd=(await json(commander,'/api/overview')).identity, intel=(await json(analyst,'/api/overview')).identity;
 assert.equal(cmd.role,'commander');assert.equal(intel.role,'intelligence');assert.notEqual(cmd.subject,intel.subject);
 const before=await json(instructor,'/api/review/export.json'),budget=(await json(instructor,'/api/agents/tools')).budget;
 const oldExerciseFindings=before.payload.assessment.history.filter((r:any)=>!r.participantSubject);
 const order=before.payload.events.find((e:any)=>e.kind==='command'&&e.actor===cmd.subject&&e.details.origin==='human');
 const assessment=before.payload.events.find((e:any)=>e.kind==='assessment_log'&&e.actor===intel.subject);const report=before.payload.reports.find((r:any)=>r.side==='blue');assert(order&&assessment&&report);
 const view=async(subject:string)=>json(instructor,'/api/review/assessment?participant='+encodeURIComponent(subject));
 const base=(subject:string,evidenceIds:string[],version=0)=>({exerciseId,participantSubject:subject,criterionId:'C1',baseVersion:version,score:null,disposition:'withheld',evidenceIds,rationale:'Automated native qualification only. The record is available, but no human instructor judgment or learning score was supplied.'});
 const status=async(c:typeof commander,body:any)=>(await c.requestRaw('/api/review/assessment',body)).status;
 const rejects={otherPersonEvidence:await status(instructor,{...base(intel.subject,[order.id]),disposition:'confirmed',score:2}),reportOnlyScore:await status(instructor,{...base(cmd.subject,[report.id]),disposition:'confirmed',score:2}),wrongExercise:await status(instructor,{...base(cmd.subject,[]),exerciseId:'wrong-exercise'}),learnerWrite:await status(commander,base(cmd.subject,[order.id]))};
 assert.deepEqual(rejects,{otherPersonEvidence:400,reportOnlyScore:400,wrongExercise:409,learnerWrite:403});
 const saved:any[]=[];
 for(const [who,event] of [[cmd,order],[intel,assessment]]){
  const a=await view(who.subject);const version=a.current.find((x:any)=>x.criterion.id==='C1').judgment?.version??0;
  // A rerun may only extend its own explicitly automated unscored stream; never replace human work.
  const existing=a.current.find((x:any)=>x.criterion.id==='C1').judgment;
  assert(!existing||existing.score===null&&existing.disposition==='withheld'&&existing.rationale.startsWith('Automated native qualification only.'),'Existing instructor work requires separate qualification data');
  const r=await json(instructor,'/api/review/assessment',base(who.subject,[event.id],version));assert.equal(r.version,version+1);assert.equal(r.score,null);assert.deepEqual(r.evidenceOwnership.participantAuthoredIds,[event.id]);saved.push(r);
 }
 const correction=await json(instructor,'/api/review/assessment',{...base(cmd.subject,[order.id],saved[0].version),rationale:'Automated native qualification only. This second withheld version tests correction history; it is not a human assessment.'});
 assert.equal(correction.previousId,saved[0].id);assert.equal((await view(intel.subject)).current.find((x:any)=>x.criterion.id==='C1').judgment.version,saved[1].version);
 const privacy=[];
 for(const [c,who,other] of [[commander,cmd,intel],[analyst,intel,cmd]] as const){
  const denied=await c.requestRaw('/api/review/assessment?participant='+encodeURIComponent(other.subject));assert.equal(denied.status,403);
  const a=await json(c,'/api/review/assessment?participant='+encodeURIComponent(who.subject));assert(a.history.every((r:any)=>!r.participantSubject||r.participantSubject===who.subject));
  const bundle=await json(c,'/api/review/export.json');assert(bundle.payload.assessment.history.every((r:any)=>!r.participantSubject||r.participantSubject===who.subject));
  const md=await(await c.request('/api/review/export.md')).text();assert(!md.includes('Participant findings: '+other.name+' ('+other.subject+')'));
  privacy.push({subject:who.subject,otherTargetStatus:denied.status,ownVersions:a.history.filter((r:any)=>r.participantSubject===who.subject).map((r:any)=>r.id),jsonPersonalHistoryScoped:true,markdownPersonalSectionsScoped:true});
 }
 const after=await json(instructor,'/api/review/export.json');assert.deepEqual(after.payload.assessment.history.filter((r:any)=>!r.participantSubject),oldExerciseFindings);assert.equal(after.payload.engine.fingerprint,before.payload.engine.fingerprint);
 const afterBudget=(await json(instructor,'/api/agents/tools')).budget;assert.equal(afterBudget.requestsUsed,budget.requestsUsed);
 const proof={at:new Date().toISOString(),build,exerciseId,automated:true,humanJudgment:false,allScoresNull:true,allDispositionsWithheld:true,subjects:{commander:cmd.subject,intelligence:intel.subject},rejectedRequests:rejects,versions:[...saved,correction].map(r=>({id:r.id,participantSubject:r.participantSubject,version:r.version,previousId:r.previousId,evidenceOwnership:r.evidenceOwnership,score:r.score,disposition:r.disposition})),privacy,exerciseWideFindingsUnchanged:true,originalFingerprint:after.payload.engine.fingerprint,bundleSha256:after.sha256,newPaidRequests:0,budget:afterBudget};
 fs.writeFileSync('evidence/poc/native-participant-review.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{for(const c of [commander,analyst,instructor])await c.close().catch(()=>{});}
