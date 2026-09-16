import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {DebriefClaim} from '../learning/types';
import type {
 ReviewFeedback,ReviewFeedbackCriterion,ReviewFeedbackResponse,ReviewFeedbackSection,
} from '../learning/review-feedback-types';
import {CURRICULUM,ServiceError,type DebriefRecord,type GameService,type Session} from './service';

/** Private learning data. Generic timelines, catalogs, MCP/search, and non-owner exports must omit this kind. */
export const REVIEW_FEEDBACK_EVENT_KIND='debrief_claim_reviewed';
export const REVIEW_FEEDBACK_HISTORY_LIMIT=100;

const sectionSchema=z.enum(['headline','observations','opponentPerspective','tradeoffs','questions','nextPractice','limitations']);
export const reviewFeedbackInput=z.object({
 exerciseId:z.uuid(),eventId:z.string().min(1).max(200),hash:z.string().regex(/^[a-f0-9]{64}$/),section:sectionSchema,index:z.number().int().min(0).max(1000),
 disposition:z.enum(['accepted','edited','rejected']),criterionId:z.string().min(1).max(100),explanation:z.string().trim().min(1).max(2000),
 editedText:z.string().trim().min(1).max(4000).optional(),nextPractice:z.string().trim().min(1).max(2000),requestId:z.uuid(),expectedReviewId:z.uuid().nullable(),
}).strict().superRefine((v,ctx)=>{
 if(v.disposition==='edited'&&!v.editedText)ctx.addIssue({code:'custom',path:['editedText'],message:'An edited claim needs editedText'});
 if(v.disposition!=='edited'&&v.editedText!==undefined)ctx.addIssue({code:'custom',path:['editedText'],message:'editedText is only valid for an edited claim'});
});
export type ReviewFeedbackInput=z.infer<typeof reviewFeedbackInput>;

interface StoredDetails {
 schema:'replay.review-feedback-event/1';requestId:string;requestFingerprint:string;debriefEventId:string;debriefHash:string;debriefGeneratedAt:string;debriefAuthor:string;
 section:ReviewFeedbackSection;index:number;disposition:ReviewFeedback['disposition'];criterion:ReviewFeedbackCriterion;explanation:string;editedText?:string;nextPractice:string;
 originalText:string;originalCitations:string[];previousId:string|null;reviewer:{subject:string;name:string};recordedAt:string;
}
interface EventRow {id:string;sequence:number;tick:number;actor:string;details:StoredDetails;recordedAt:string;}

const criteria=():ReviewFeedbackCriterion[]=>CURRICULUM.rubric.criteria.map(c=>({id:c.id,name:c.name,objective:c.objective}));
const activeExercise=(session:Session,exerciseId:string)=>{
 if(exerciseId!==session.activeId)throw new ServiceError(409,'The active exercise changed; reload the intended debrief review');
};
const parseRecord=(value:string|undefined):DebriefRecord|null=>{
 if(!value)return null;
 try{
  const r=JSON.parse(value) as DebriefRecord;
  return r?.schema==='replay.debrief-record/1'&&typeof r.exerciseId==='string'&&typeof r.eventId==='string'&&typeof r.hash==='string'?r:null;
 }catch{return null;}
};

/**
 * Re-authorize through cachedDebrief on every request. A requested historical version is then
 * loaded by its exact immutable hash; possession of a hash never grants access by itself.
 */
function readableDebrief(service:GameService,session:Session,eventId:string,hash:string){
 const cached=service.cachedDebrief(session,eventId);
 if(!cached)throw new ServiceError(404,'No generated debrief exists for this order');
 if(cached.record.hash===hash)return {record:cached.record,current:cached};
 const row=service.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`learning.debrief-history:${session.activeId}:${eventId}:${hash}`) as {value:string}|undefined;
 const record=parseRecord(row?.value);
 if(!record||record.exerciseId!==session.activeId||record.eventId!==eventId||record.hash!==hash)throw new ServiceError(404,'No generated debrief exists with that hash');
 return {record,current:cached};
}

function claimAt(record:DebriefRecord,section:ReviewFeedbackSection,index:number):DebriefClaim{
 const value=record.debrief[section];
 if(section==='headline'){
  if(index!==0)throw new ServiceError(400,'The headline claim index must be 0');
  return value as DebriefClaim;
 }
 if(!Array.isArray(value)||index>=value.length)throw new ServiceError(400,'No generated debrief claim exists at that section and index');
 return value[index] as DebriefClaim;
}

function rows(service:GameService,exerciseId:string,eventId:string,hash:string,tick=Number.MAX_SAFE_INTEGER):EventRow[]{
 const raw=service.store.db.prepare(`SELECT id,sequence,tick,actor,details,recorded_at FROM events
  WHERE exercise_id=? AND kind=? AND tick<=? AND json_extract(details,'$.debriefEventId')=? AND json_extract(details,'$.debriefHash')=? ORDER BY sequence`).all(exerciseId,REVIEW_FEEDBACK_EVENT_KIND,tick,eventId,hash) as any[];
 return raw.flatMap(r=>{try{return [{id:r.id,sequence:Number(r.sequence),tick:Number(r.tick),actor:r.actor,details:JSON.parse(r.details),recordedAt:r.recorded_at} as EventRow];}catch{return [];}});
}

function publicReview(row:EventRow):ReviewFeedback{
 const d=row.details;
 return {schema:'replay.review-feedback/1',id:row.id,exerciseId:'',eventId:d.debriefEventId,hash:d.debriefHash,section:d.section,index:d.index,disposition:d.disposition,
  criterionId:d.criterion.id,criterionName:d.criterion.name,criterionObjective:d.criterion.objective,explanation:d.explanation,...(d.editedText!==undefined?{editedText:d.editedText}:{}),nextPractice:d.nextPractice,
  author:d.reviewer.subject,recordedAt:d.recordedAt,...(d.previousId?{previousId:d.previousId}:{}),originalText:d.originalText,originalCitations:[...d.originalCitations]};
}

function withExercise(row:EventRow,exerciseId:string){const r=publicReview(row);r.exerciseId=exerciseId;return r;}

export function reviewFeedback(service:GameService,session:Session,input:{exerciseId:string;eventId:string;hash:string},canReview:boolean):ReviewFeedbackResponse{
 activeExercise(session,input.exerciseId);const {current}=readableDebrief(service,session,input.eventId,input.hash);
 const cutoff=session.playbackTick??Number.MAX_SAFE_INTEGER,all=rows(service,input.exerciseId,input.eventId,input.hash,cutoff),selected=all.slice(-REVIEW_FEEDBACK_HISTORY_LIMIT);
 return {exerciseId:input.exerciseId,eventId:input.eventId,hash:input.hash,reviews:selected.map(r=>withExercise(r,input.exerciseId)),criteria:criteria(),canReview:canReview&&!current.stale&&current.record.hash===input.hash,truncated:all.length>selected.length};
}

function fingerprint(input:ReviewFeedbackInput,subject:string){
 return createHash('sha256').update(JSON.stringify({subject,exerciseId:input.exerciseId,eventId:input.eventId,hash:input.hash,section:input.section,index:input.index,disposition:input.disposition,criterionId:input.criterionId,explanation:input.explanation,editedText:input.editedText??null,nextPractice:input.nextPractice,requestId:input.requestId,expectedReviewId:input.expectedReviewId})).digest('hex');
}

function requestRow(service:GameService,requestId:string):EventRow|null{
 const r=service.store.db.prepare(`SELECT id,sequence,tick,actor,details,recorded_at FROM events WHERE kind=? AND json_extract(details,'$.requestId')=? LIMIT 1`).get(REVIEW_FEEDBACK_EVENT_KIND,requestId) as any;
 if(!r)return null;
 try{return {id:r.id,sequence:Number(r.sequence),tick:Number(r.tick),actor:r.actor,details:JSON.parse(r.details),recordedAt:r.recorded_at};}catch{throw new ServiceError(409,'The requestId is already associated with an unreadable review event');}
}

export function saveReviewFeedback(service:GameService,session:Session,raw:unknown):{storedReview:ReviewFeedback;duplicate:boolean}{
 if(session.identity.role!=='instructor')throw new ServiceError(403,'Only the instructor seat may review generated debrief claims');
 const input=reviewFeedbackInput.parse(raw);activeExercise(session,input.exerciseId);
 const {record,current}=readableDebrief(service,session,input.eventId,input.hash),claim=claimAt(record,input.section,input.index);
 const criterion=criteria().find(c=>c.id===input.criterionId);if(!criterion)throw new ServiceError(400,'Unknown current curriculum criterion');
 const requestFingerprint=fingerprint(input,session.identity.subject);
 return service.store.transaction(()=>{
  const priorRequest=requestRow(service,input.requestId);
  if(priorRequest){
   if(priorRequest.details.requestFingerprint!==requestFingerprint)throw new ServiceError(409,'The requestId was already used with a different review payload');
   return {storedReview:withExercise(priorRequest,input.exerciseId),duplicate:true};
  }
  if(current.stale||current.record.hash!==input.hash)throw new ServiceError(409,'The debrief changed or is stale; reload the current generated claim before reviewing it');
  const history=rows(service,input.exerciseId,input.eventId,input.hash).filter(r=>r.details.section===input.section&&r.details.index===input.index),previous=history.at(-1)??null;
  if((previous?.id??null)!==input.expectedReviewId)throw new ServiceError(409,'A newer review exists for this claim; reload before saving another revision');
  const recordedAt=new Date().toISOString(),details:StoredDetails={schema:'replay.review-feedback-event/1',requestId:input.requestId,requestFingerprint,debriefEventId:record.eventId,debriefHash:record.hash,debriefGeneratedAt:record.generatedAt,debriefAuthor:record.author,
   section:input.section,index:input.index,disposition:input.disposition,criterion:{...criterion},explanation:input.explanation,...(input.editedText!==undefined?{editedText:input.editedText}:{}),nextPractice:input.nextPractice,
   originalText:claim.text,originalCitations:[...claim.citations],previousId:previous?.id??null,reviewer:{subject:session.identity.subject,name:session.identity.name},recordedAt};
  const tick=service.world(input.exerciseId).engine.game.ticks();
  const id=service.store.event(input.exerciseId,tick,REVIEW_FEEDBACK_EVENT_KIND,session.identity.subject,'Instructor reviewed a generated debrief claim',details);
  const stored=rows(service,input.exerciseId,input.eventId,input.hash).find(r=>r.id===id);
  if(!stored||!isDeepStrictEqual(stored.details,details))throw new Error('Stored review event could not be verified');
  return {storedReview:withExercise(stored,input.exerciseId),duplicate:false};
 });
}
