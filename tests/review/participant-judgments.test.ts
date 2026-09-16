import {afterEach,expect,it} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService,type Identity,type Session} from '../../src/server/service';
import {assessment,saveJudgment,exportAssessment,exportMarkdown,reviewTargets} from '../../src/review/assessment';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
const who=(subject:string,role:Identity['role']):Identity=>({subject,name:subject==='sub-cmd'?'Commander Vale':'Analyst Okoro',role,organization:'Synthetic test',mode:'kamiwaza'});
/** Shared exercise with two real enrolled subjects: the commander owns it and issues an order; the analyst joins and writes an assessment entry. */
async function setup(){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'participant-judgments-')),s=new GameService(d);clean.push(()=>fs.rmSync(d,{recursive:true,force:true}),()=>s.close());
 const cmd=who('sub-cmd','commander'),intel=who('sub-intel','intelligence');
 const row=await s.create('Shared class','plains',cmd),w=s.world(row.id);row.options.workroomId='room';s.store.putExercise(row);
 s.teams.enroll(row,cmd,1);for(let n=0;n<25;n++)s.tick(w);s.teams.enroll(row,intel,w.engine.game.ticks());
 s.command(row.id,'blue',{type:'attack',targetID:null,troops:10},'cmd-order',cmd);s.tick(w);
 const intelSession:Session={identity:intel,activeId:row.id,playbackTick:null,selectedSide:'blue'};
 const logged=s.assessmentLog(intelSession,{text:'Blue holds the river line; no red movement observed yet.'});
 const order=s.store.events(row.id).find(e=>e.kind==='command'&&e.actor==='sub-cmd')!;const report=s.store.reports(row.id).find(r=>r.side==='blue')!;
 const instructor:Session={identity:{subject:'sub-instructor',name:'Instructor Chen',role:'instructor',organization:'Synthetic test',mode:'kamiwaza'},activeId:row.id,playbackTick:null,selectedSide:'blue'};
 const cmdSession:Session={identity:cmd,activeId:row.id,playbackTick:null,selectedSide:'blue'};
 return {s,d,row,w,order,logId:logged.id,report,instructor,cmdSession,intelSession};
}
const body=(o:Record<string,unknown>)=>({criterionId:'C1',baseVersion:0,score:2,disposition:'confirmed',rationale:'The recorded action shows the participant acting on the released report.',evidenceIds:[] as string[],...o});

it('keeps independent version streams per participant and leaves the legacy exercise-wide stream untouched',async()=>{
 const {s,order,logId,report,instructor}=await setup();
 const legacy=saveJudgment(s,instructor,body({evidenceIds:[report.id]}));
 expect(legacy.participantSubject).toBeUndefined();expect(legacy.evidenceOwnership).toBeUndefined();expect(legacy.version).toBe(1);
 const c1=saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[order.id,report.id]}));
 const i1=saveJudgment(s,instructor,body({participantSubject:'sub-intel',evidenceIds:[logId],score:1}));
 expect([c1.version,i1.version]).toEqual([1,1]);expect(c1.previousId).toBeNull();expect(i1.previousId).toBeNull();
 const c2=saveJudgment(s,instructor,body({participantSubject:'sub-cmd',baseVersion:1,evidenceIds:[order.id],score:3,rationale:'Correction after discussion; the order was timed to the report release.'}));
 expect(c2.version).toBe(2);expect(c2.previousId).toBe(c1.id);
 expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-cmd',baseVersion:1,evidenceIds:[order.id]}))).toThrow(/newer judgment/);
 expect(saveJudgment(s,instructor,body({participantSubject:'sub-intel',baseVersion:1,evidenceIds:[logId]})).version).toBe(2);
 expect(saveJudgment(s,instructor,body({baseVersion:1,evidenceIds:[report.id]})).version).toBe(2);
 const stored=JSON.parse((s.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`review.judgment:${legacy.exerciseId}:${legacy.id}`) as any).value);
 expect(stored).toEqual(legacy);
 expect(c1.evidenceOwnership).toMatchObject({participantAuthoredIds:[order.id],otherIds:[report.id]});expect(c1.evidenceOwnership?.meaning).toMatch(/does not validate/);
 const view=assessment(s,instructor,'sub-cmd');expect(view.current[0].judgment?.version).toBe(2);expect(view.current[0].judgment?.participantSubject).toBe('sub-cmd');
 expect(assessment(s,instructor).current[0].judgment?.participantSubject).toBeUndefined();expect(assessment(s,instructor).history).toHaveLength(6);
});

it('rejects unknown subjects, another person\'s actions, cross-exercise citations and report-only personal scores, while accepting authored evidence and evidence-free withheld findings',async()=>{
 const {s,order,logId,report,instructor,row}=await setup();
 expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-stranger',evidenceIds:[order.id]}))).toThrow(/Not a recorded participant/);
 expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-intel',evidenceIds:[order.id]}))).toThrow(/must cite at least one event that participant authored/);
 expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[report.id]}))).toThrow(/reports or another participant/);
 expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[report.id],score:null,disposition:'contested'}))).toThrow(/must cite/);
 const other=await s.create('Other class','plains',who('sub-cmd','commander'));for(let n=0;n<25;n++)s.tick(s.world(other.id));s.command(other.id,'blue',{type:'attack',targetID:null,troops:5},'other-order',who('sub-cmd','commander'));s.tick(s.world(other.id));
 const foreign=s.store.events(other.id).find(e=>e.kind==='command'&&e.actor==='sub-cmd')!;
 expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[foreign.id]}))).toThrow(/this exercise/);
 expect(saveJudgment(s,instructor,body({participantSubject:'sub-intel',evidenceIds:[logId,report.id],score:2})).evidenceOwnership?.participantAuthoredIds).toEqual([logId]);
 const withheld=saveJudgment(s,instructor,body({participantSubject:'sub-cmd',criterionId:'C2',evidenceIds:[],score:null,disposition:'withheld',rationale:'Unobserved: no source assessment was recorded by this participant.'}));
 expect(withheld.score).toBeNull();expect(withheld.evidenceOwnership?.participantAuthoredIds).toEqual([]);
 expect(reviewTargets(s,instructor).map(t=>t.subject)).toEqual([null,'sub-cmd','sub-intel']);expect(row.id).toBeTruthy();
});

it('shows learners only their own personal findings plus exercise-wide ones, in views and completed-exercise exports',async()=>{
 const {s,order,logId,report,instructor,cmdSession,intelSession,w}=await setup();
 saveJudgment(s,instructor,body({evidenceIds:[report.id],rationale:'Exercise-wide: the group acted on the first release without waiting.'}));
 saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[order.id],rationale:'Commander private finding about the river order.'}));
 saveJudgment(s,instructor,body({participantSubject:'sub-intel',evidenceIds:[logId],rationale:'Analyst private finding about the assessment entry.'}));
 w.row.status='completed';
 const cmdView=assessment(s,cmdSession,'sub-cmd');expect(cmdView.targets.map(t=>t.subject)).toEqual([null,'sub-cmd']);
 expect(cmdView.history.map(r=>r.participantSubject??'exercise')).toEqual(['exercise','sub-cmd']);expect(JSON.stringify(cmdView)).not.toContain('Analyst private finding');
 expect(()=>assessment(s,cmdSession,'sub-intel')).toThrow(/only view their own/);
 expect(assessment(s,cmdSession).current[0].judgment?.participantSubject).toBeUndefined();
 const cmdExport=exportAssessment(s,cmdSession),cmdText=JSON.stringify(cmdExport);
 expect(cmdText).toContain('Commander private finding');expect(cmdText).toContain('Exercise-wide: the group');expect(cmdText).not.toContain('Analyst private finding');
 const cmdMd=exportMarkdown(cmdExport);expect(cmdMd).toContain('# Exercise-wide findings');expect(cmdMd).toContain('# Participant findings: Commander Vale (sub-cmd)');expect(cmdMd).not.toContain('sub-intel');
 const intelMd=exportMarkdown(exportAssessment(s,intelSession));expect(intelMd).toContain('Analyst private finding');expect(intelMd).not.toContain('Commander private finding');
 const full=exportAssessment(s,instructor);expect(full.payload.assessment.history).toHaveLength(3);expect(full.payload.engine.canonicalRecord?.turns.length).toBeGreaterThan(0);
 const fullMd=exportMarkdown(full);expect(fullMd).toContain('# Participant findings: Commander Vale (sub-cmd)');expect(fullMd).toContain('# Participant findings: Analyst Okoro (sub-intel)');expect(fullMd).toContain('not individual scores');
 expect(cmdExport.payload.engine.canonicalRecord?.turns.length).toBe(full.payload.engine.canonicalRecord?.turns.length);
});

it('assesses a removed participant from retained history, and the judgment survives restart',async()=>{
 const {s,d,order,instructor,row,cmdSession}=await setup();
 s.removeParticipant(row.id,'sub-intel','sub-cmd');
 expect(s.teams.includes(row,'sub-intel')).toBe(false);
 const targets=reviewTargets(s,instructor);expect(targets.find(t=>t.subject==='sub-intel')).toMatchObject({active:false});expect(targets.find(t=>t.subject==='sub-intel')?.label).toMatch(/removed/);
 const logId=s.store.events(row.id).find(e=>e.kind==='assessment_log'&&e.actor==='sub-intel')!.id;
 const saved=saveJudgment(s,instructor,body({participantSubject:'sub-intel',evidenceIds:[logId,order.id]}));expect(saved.evidenceOwnership?.participantAuthoredIds).toEqual([logId]);
 expect(()=>saveJudgment(s,cmdSession,body({participantSubject:'sub-cmd',evidenceIds:[order.id]}))).toThrow(/Instructor assignment required/);
 const reopened=new GameService(d);clean.push(()=>reopened.close());await reopened.init(false);
 const view=assessment(reopened,instructor,'sub-intel');expect(view.current[0].judgment?.id).toBe(saved.id);expect(view.target).toMatchObject({kind:'participant',subject:'sub-intel',active:false});
 expect(view.evidence.some(e=>e.id===logId&&e.participantAuthored)).toBe(true);expect(view.evidence.find(e=>e.id===order.id)?.participantAuthored).toBe(false);expect(view.evidence.some(e=>e.kind==='assessment_log')).toBe(true);
});


it('binds new saves to the intended exercise, including withheld findings with no evidence',async()=>{
 const {s,row,instructor}=await setup();const before=assessment(s,instructor).history.length;
 expect(()=>saveJudgment(s,instructor,body({exerciseId:'another-exercise',participantSubject:'sub-cmd',score:null,disposition:'withheld',evidenceIds:[]}))).toThrow(/active exercise changed/);
 expect(assessment(s,instructor).history).toHaveLength(before);
 expect(saveJudgment(s,instructor,body({exerciseId:row.id,participantSubject:'sub-cmd',score:null,disposition:'withheld',evidenceIds:[]})).exerciseId).toBe(row.id);
});

it('labels the human staff question separately and never counts model-only or inherited text as a new participant act',async()=>{
 const {s,row,instructor,order}=await setup();
 const noQuestion=s.store.event(row.id,28,'staff_answer','sub-cmd','MODEL ANSWER WITHOUT QUESTION',{sourceIds:[]},'blue');
 const question=s.store.event(row.id,29,'staff_answer','sub-cmd','MODEL ANSWER IS NOT HUMAN WRITING',{question:'Which available report is current?',sourceIds:[]},'blue');
 const inherited=s.store.event(row.id,30,'inherited_event','sub-cmd',order.summary,{originalKind:'command',originalDetails:order.details},'blue');
 for(const id of [noQuestion,inherited])expect(()=>saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[id]}))).toThrow(/must cite at least one event/);
 const view=assessment(s,instructor,'sub-cmd');const option=view.evidence.find(e=>e.id===question)!;
 expect(option.participantAuthored).toBe(true);expect(option.title).toContain('Which available report is current?');expect(option.title).not.toContain('MODEL ANSWER IS NOT HUMAN WRITING');
 const saved=saveJudgment(s,instructor,body({participantSubject:'sub-cmd',evidenceIds:[question]}));expect(saved.evidenceOwnership?.meaning).toContain('only details.question');
});
