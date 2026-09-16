import {networkAt} from '../server/network-store';
import {canReadDebriefReviewEvent} from '../learning/review-feedback-visibility';
import {recordedScenario,victoryDescription} from '../scenarios/catalog';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CURRICULUM,ServiceError,type GameService,type Session} from '../server/service';
import curriculum from '../../docs/pilot/exercise-curriculum.json';
import {UPSTREAM_COMMIT} from '../engine/engine';
export interface InstructorJudgment {schema:'replay.instructor-judgment/1';id:string;exerciseId:string;criterionId:string;version:number;previousId:string|null;author:string;createdAt:string;score:number|null;disposition:'confirmed'|'contested'|'withheld';rationale:string;evidenceIds:string[];curriculumVersion:string;curriculumContentRevision:number;
 /** Absent on legacy rows and on exercise-wide findings: the judgment describes the exercise, not one person. */
 participantSubject?:string;
 /** Automated ownership check stored with a personal finding. It lists which citations the participant authored; it does not say the rationale is true. */
 evidenceOwnership?:{participantAuthoredIds:string[];otherIds:string[];checkedAt:string;meaning:string};}
export interface ReviewTarget {kind:'exercise'|'participant';subject:string|null;name:string;active:boolean;label:string;}
const input=z.object({exerciseId:z.string().min(1).max(100).optional(),criterionId:z.string(),baseVersion:z.number().int().min(0),score:z.number().int().min(0).max(3).nullable(),disposition:z.enum(['confirmed','contested','withheld']),rationale:z.string().trim().min(12).max(2000),evidenceIds:z.array(z.string().min(1).max(200)).max(24),participantSubject:z.string().trim().min(1).max(200).nullable().optional()}).strict();
const prefix=(id:string)=>`review.judgment:${id}:`;
export const limitations=['Human instructor judgments against a provisional curriculum; no automatic mastery or learning-efficacy claim.','Simulation outcome is separate from quality of reasoning.','A branch after viewing later play is informed practice, not an independent pre/post attempt.','SHA256 is an integrity reference, not proof against administrator modification.','No reviewed doctrine or real adversary model is loaded.','A confirmed or contested participant finding cites at least one new event that participant authored; the ownership check is mechanical and does not establish that the evidence supports the rationale.','Findings without a participant target are exercise-wide and are never re-labelled as an individual score.'];
const OWNERSHIP_MEANING='Mechanical check of a new act recorded under this participant subject; for staff_answer only details.question is authored by the participant, while summary is model assistance. It does not validate the instructor interpretation.';
/** Event kinds a participant authors in their own name. Reports, staff output and other people's orders never count. */
const AUTHORED_KINDS=new Set(['command','assessment_log','decision_log','staff_answer','task_created']);
/** New participant acts only. Inherited branch events remain context; staff answers count only their recorded human question. */
export function authoredBy(e:any,subject:string):boolean{
 if(e.kind==='inherited_event'||e.actor!==subject||!AUTHORED_KINDS.has(e.kind))return false;
 if(e.kind==='command')return e.details?.origin==='human';
 if(e.kind==='staff_answer')return typeof e.details?.question==='string'&&e.details.question.trim().length>0;
 return true;
}
function evidenceTitle(e:any):string{
 if(e.kind==='staff_answer')return typeof e.details?.question==='string'?`Participant question: ${e.details.question}. The answer is recorded model assistance.`:'Model answer; no participant question was recorded.';
 if(e.kind==='inherited_event')return `Inherited context (not a new act in this branch): ${e.summary}`;
 return e.summary;
}
const targetOf=(r:InstructorJudgment)=>r.participantSubject??null;
const sameTarget=(r:InstructorJudgment,subject:string|null)=>targetOf(r)===subject;
function all(service:GameService,id:string):InstructorJudgment[]{return (service.store.db.prepare('SELECT value FROM settings WHERE key LIKE ?').all(prefix(id)+'%') as any[]).map(r=>JSON.parse(r.value)).sort((a,b)=>a.version-b.version||a.createdAt.localeCompare(b.createdAt));}
export function visibleEvidence(service:GameService,s:Session){const w=service.world(s.activeId),both=w.row.status==='completed'||s.identity.role==='instructor';const visible=(r:any)=>both||!r.side||r.side===w.row.humanSide;return {both,events:service.store.events(w.row.id).filter(visible).filter(e=>canReadDebriefReviewEvent(e,s.identity)),reports:service.store.reports(w.row.id).filter(visible),tasks:service.store.tasks(w.row.id).filter(visible)};}
const EXERCISE_TARGET:ReviewTarget={kind:'exercise',subject:null,name:'Whole exercise',active:true,label:'Exercise-wide finding (not an individual score)'};
/** Targets this session may select. Instructors: every recorded participant, removed ones included. Learners: the exercise and, when recorded as a participant, themselves. */
export function reviewTargets(service:GameService,s:Session):ReviewTarget[]{
 const row=service.world(s.activeId).row;const participants=service.teams.participants(row).map(p=>({kind:'participant' as const,subject:p.subject,name:p.name,active:p.active,label:`${p.name} (${p.subject})${p.active?'':' · removed, history retained'}`}));
 return [EXERCISE_TARGET,...(s.identity.role==='instructor'?participants:participants.filter(p=>p.subject===s.identity.subject))];
}
/** Resolve a requested target or throw. Learners may only name themselves; instructors may name any recorded participant of this exercise. */
export function resolveTarget(service:GameService,s:Session,subject:string|null|undefined):ReviewTarget{
 if(subject==null||subject==='')return EXERCISE_TARGET;
 const t=reviewTargets(service,s).find(t=>t.subject===subject);
 if(t)return t;
 if(s.identity.role!=='instructor')throw new ServiceError(403,'Learners may only view their own participant findings');
 throw new ServiceError(404,'Not a recorded participant of this exercise');
}
/** Instructors read every judgment; learners read exercise-wide findings and their own personal findings only. */
const readable=(r:InstructorJudgment,s:Session)=>s.identity.role==='instructor'||targetOf(r)===null||targetOf(r)===s.identity.subject;
const REVIEWABLE_KINDS=new Set([...AUTHORED_KINDS,'staff_update','execution_feedback','objective_update','inherited_event']);
function evidenceOptions(service:GameService,s:Session,target:ReviewTarget){
 const v=visibleEvidence(service,s);const subject=target.subject;
 const events=v.events.filter(e=>REVIEWABLE_KINDS.has(e.kind)&&(e.kind!=='inherited_event'||AUTHORED_KINDS.has(e.details?.originalKind))).map(e=>({id:e.id,kind:e.kind==='inherited_event'?`inherited:${e.details?.originalKind}`:e.kind,tick:e.tick,actor:e.actor,title:evidenceTitle(e),participantAuthored:subject!==null&&authoredBy(e,subject)}));
 const reports=v.reports.map(r=>({id:r.id,kind:'report',tick:r.tick,actor:'exercise-reporter',title:r.title,participantAuthored:false}));
 return [...events,...reports].sort((a,b)=>b.tick-a.tick||Number(b.participantAuthored)-Number(a.participantAuthored)).slice(0,200);
}
export function assessment(service:GameService,s:Session,participant?:string|null){
 const target=resolveTarget(service,s,participant);const {events,reports,both}=visibleEvidence(service,s);const ids=new Set([...events,...reports].map(e=>e.id));
 const history=all(service,s.activeId).filter(r=>readable(r,s)).filter(r=>both||r.evidenceIds.length>0&&r.evidenceIds.every(id=>ids.has(id)));
 const latest=(subject:string|null)=>CURRICULUM.rubric.criteria.map(c=>({criterion:c,judgment:history.filter(r=>r.criterionId===c.id&&sameTarget(r,subject)).at(-1)??null}));
 const targets=reviewTargets(service,s);const findings=targets.filter(t=>t.kind==='exercise'||history.some(r=>sameTarget(r,t.subject))).map(t=>({target:t,current:latest(t.subject)}));
 return {schema:'replay.assessment/2',exerciseId:s.activeId,curriculumVersion:CURRICULUM.version,curriculumContentRevision:curriculum.content_revision,target,targets,history,current:latest(target.subject),findings,evidence:evidenceOptions(service,s,target),limitations};
}
export function saveJudgment(service:GameService,s:Session,body:unknown){
 if(s.identity.role!=='instructor')throw new ServiceError(403,'Instructor assignment required');
 const b=input.parse(body);if(b.exerciseId!==undefined&&b.exerciseId!==s.activeId)throw new ServiceError(409,'The active exercise changed; reload the intended review before saving');if(!CURRICULUM.rubric.criteria.some(c=>c.id===b.criterionId))throw new ServiceError(400,'Unknown curriculum criterion');
 const target=resolveTarget(service,s,b.participantSubject);
 const v=visibleEvidence(service,s),allowed=new Set([...v.events,...v.reports].map(e=>e.id));const evidenceIds=[...new Set(b.evidenceIds)];
 if(evidenceIds.some(id=>!allowed.has(id)))throw new ServiceError(400,'Citations must belong to this exercise and be visible to the reviewer');
 if(b.score!==null&&(b.disposition!=='confirmed'||!evidenceIds.length))throw new ServiceError(400,'A score requires confirmed judgment and observable evidence');
 if(b.disposition!=='withheld'&&!evidenceIds.length)throw new ServiceError(400,'Confirmed or contested findings need observable evidence; use withheld for unobserved criteria');
 let evidenceOwnership:InstructorJudgment['evidenceOwnership'];
 if(target.subject!==null){
  const byId=new Map(v.events.map(e=>[e.id,e]));const participantAuthoredIds=evidenceIds.filter(id=>{const e=byId.get(id);return !!e&&authoredBy(e,target.subject!);});
  if(b.disposition!=='withheld'&&!participantAuthoredIds.length)throw new ServiceError(400,'A participant finding must cite at least one event that participant authored (order, assessment entry, decision statement, staff question or tasking); reports or another participant\'s actions do not show this person\'s performance');
  evidenceOwnership={participantAuthoredIds,otherIds:evidenceIds.filter(id=>!participantAuthoredIds.includes(id)),checkedAt:new Date().toISOString(),meaning:OWNERSHIP_MEANING};
 }
 return service.store.transaction(()=>{const prior=all(service,s.activeId).filter(r=>r.criterionId===b.criterionId&&sameTarget(r,target.subject)).at(-1);if((prior?.version??0)!==b.baseVersion)throw new ServiceError(409,'A newer judgment exists for this target; reload before correcting it');
  const r:InstructorJudgment={schema:'replay.instructor-judgment/1',id:randomUUID(),exerciseId:s.activeId,criterionId:b.criterionId,version:b.baseVersion+1,previousId:prior?.id??null,author:s.identity.subject,createdAt:new Date().toISOString(),score:b.score,disposition:b.disposition,rationale:b.rationale,evidenceIds,curriculumVersion:CURRICULUM.version,curriculumContentRevision:curriculum.content_revision,...(target.subject!==null?{participantSubject:target.subject,evidenceOwnership}:{})};
  service.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(prefix(s.activeId)+r.id,JSON.stringify(r));return r;});
}
/** Export only this authorized record. Strip credential-shaped fields even from untrusted tool output. */
const usageMetrics=new Set(['inputTokens','cachedInputTokens','outputTokens']);
export function redact(value:any):any{if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k,v])=>usageMetrics.has(k)?v===null||(Number.isSafeInteger(v)&&Number(v)>=0):!/token|secret|password|authorization|signature|platformClient/i.test(k)).map(([k,v])=>[k,redact(v)]));return typeof value==='string'?value.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_.=-]{40,}/g,'[REDACTED]'):value;}
export function exportAssessment(service:GameService,s:Session){const w=service.world(s.activeId),visible=visibleEvidence(service,s);const events=redact(visible.events);const receiptIds=new Set(events.flatMap((e:any)=>[e.details?.receiptId,e.details?.receipt?.id]).filter(Boolean));
 const debriefRows=(service.store.db.prepare('SELECT value FROM settings WHERE key LIKE ?').all(`learning.debrief:${w.row.id}:%`) as any[]).map(r=>JSON.parse(r.value));
 const historical=(service.store.db.prepare('SELECT value FROM settings WHERE key LIKE ?').all(`learning.debrief-history:${w.row.id}:%`) as any[]).map(r=>JSON.parse(r.value));
 const debriefs=visible.both?[...new Map([...historical,...debriefRows].filter(r=>s.identity.role==='instructor'||r.author===s.identity.subject).map(r=>[r.hash,r])).values()]:[];for(const d of debriefs)if(d.receipt?.id)receiptIds.add(d.receipt.id);
 const receipts=service.ledger.listReceipts().filter(r=>receiptIds.has(r.id)||(visible.both&&r.context?.exerciseId===w.row.id)).map(r=>({id:r.id,purpose:r.purpose,status:r.status,errorCode:r.errorCode,modelRequested:r.modelRequested,modelReturned:r.modelReturned,inputTokens:r.inputTokens,outputTokens:r.outputTokens,settledUsd:r.settledMicro===null?null:r.settledMicro/1_000_000,createdAt:r.createdAt}));
 const metadata={...w.row,agentEnabled:w.row.agentEnabled,options:{scenario:recordedScenario(w.row.options),simulationProfile:w.row.options.simulationProfile??null,map:w.row.options.map,simulationId:w.row.options.simulationId,scenarioId:w.row.options.scenarioId,curriculumVersion:w.row.options.curriculumVersion,ownerSubject:w.row.options.ownerSubject,workroomId:w.row.options.workroomId,assistance:w.row.options.assistance}};
 const payload={campaign:networkAt(service.store,w.row,w.engine,w.campaign),schema:'replay.learning-bundle/1',createdAt:new Date().toISOString(),exportedBy:s.identity.subject,exercise:metadata,lineage:{parentId:w.row.parentId??null,forkTick:w.row.forkTick??null,interpretation:w.row.parentId?'informed practice':'independent exercise (attribution and assistance still apply)'},engine:{upstreamCommit:UPSTREAM_COMMIT,simulationProfile:w.row.options.simulationProfile??null,tick:w.engine.game.ticks(),fingerprint:w.engine.state().fingerprint,canonicalRecord:visible.both?service.record(w.row.id):null,canonicalWithheld:!visible.both?'Complete canonical inputs are released after the exercise or to an instructor':null},events,participants:service.teams.participants(w.row),reports:visible.reports,importedSources:redact(service.noteIntakeHistory(s).filter((r:any)=>visible.both||r.side===w.row.humanSide).map((r:any)=>service.intakeSource(s,r.sha256))),tasks:redact(visible.tasks),receipts,debriefs:redact(debriefs),assessment:assessment(service,s),curriculum:{...curriculum,sha256:createHash('sha256').update(JSON.stringify(curriculum)).digest('hex')},limitations};
 return {schema:'replay.learning-export/1',sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),payload};
}
const describeFinding=(x:{criterion:{id:string;name:string};judgment:InstructorJudgment|null})=>`## ${x.criterion.id}: ${x.criterion.name}\n\n${x.judgment?`${x.judgment.disposition}; score ${x.judgment.score??'unobserved'}; version ${x.judgment.version}.\n\n${x.judgment.rationale}\n\nEvidence: ${x.judgment.evidenceIds.join(', ')}.${x.judgment.evidenceOwnership?`\n\nParticipant-authored citations (mechanical ownership check only): ${x.judgment.evidenceOwnership.participantAuthoredIds.join(', ')||'none'}.`:''}\n\nReviewer ${x.judgment.author}, ${x.judgment.createdAt}.`:'Unobserved; no instructor judgment.'}`;
export function exportMarkdown(bundle:ReturnType<typeof exportAssessment>){const p=bundle.payload,a=p.assessment;
 const sections=a.findings.flatMap(f=>[f.target.kind==='exercise'?'# Exercise-wide findings\n\nThese describe the exercise as a whole. They are not individual scores for any participant.':`# Participant findings: ${f.target.name} (${f.target.subject})${f.target.active?'':' — removed from the exercise; history retained'}\n\nEach finding cites at least one event this participant authored. The ownership check is mechanical; the rationale is the instructor\'s own judgment.`,...f.current.map(describeFinding)]);
 const participantSections=a.findings.length-1;
 return [`# REPLAY instructor review — ${p.exercise.name}`,`Generated ${p.createdAt}. Exercise ${p.exercise.id}. Scope: exercise-wide findings${participantSections?` and ${participantSections} participant section${participantSections===1?'':'s'}`:' only'}, as readable by ${p.exportedBy}.`,`Integrity reference SHA256: ${bundle.sha256}`,`Simulation tick ${p.engine.tick}; public-state fingerprint ${p.engine.fingerprint}.`,`Curriculum ${p.curriculum.version}, content revision ${p.curriculum.content_revision}.`,...(p.exercise.options.scenario?[`Exercise rules: ${p.exercise.options.scenario.title} (${p.exercise.options.scenario.id}). ${victoryDescription(p.exercise.options.scenario)}`]:[]),...sections,'## Interpretation',...limitations.map(x=>`- ${x}`),`\nJSON export includes ${p.events.length} visible events, ${p.reports.length} reports, ${p.receipts.length} cost receipts and ${a.history.length} judgment versions. The Markdown is a readable view; the JSON contains the complete authorized bundle.`].join('\n\n');}
