import type express from 'express';
import {z} from 'zod';
import {ServiceError,type GameService,type Session} from './service';
import {reviewFeedback,reviewFeedbackInput,saveReviewFeedback} from './review-feedback';

const querySchema=z.object({exerciseId:z.uuid(),eventId:z.string().min(1).max(200),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
interface NativeLocals {identity?:{subject?:string};context?:{canEdit?:boolean;readOnlyReason?:string|null}}

function sessionOf(res:express.Response):Session{
 const session=res.locals.session as Session|undefined;
 if(!session?.identity?.subject||!session.activeId)throw new ServiceError(401,'No exercise session');
 const native=res.locals.native as NativeLocals|undefined;
 if(native?.identity?.subject&&native.identity.subject!==session.identity.subject)throw new ServiceError(403,'Native identity does not match the exercise session');
 return session;
}
function canReview(res:express.Response,session:Session){
 if(session.identity.role!=='instructor'||session.playbackTick!==null)return false;
 if(session.identity.mode!=='kamiwaza')return true;
 return (res.locals.native as NativeLocals|undefined)?.context?.canEdit===true;
}
function requireInstructorWrite(res:express.Response){
 const session=sessionOf(res);
 if(session.identity.role!=='instructor')throw new ServiceError(403,'Only the instructor seat may review generated debrief claims');
 if(session.playbackTick!==null)throw new ServiceError(409,'Return to the full exercise record before saving a debrief review');
 if(session.identity.mode==='kamiwaza'&&(res.locals.native as NativeLocals|undefined)?.context?.canEdit!==true)throw new ServiceError(403,'Native workroom context does not permit review writes');
 return session;
}
function send(res:express.Response,error:unknown){
 if(error instanceof ServiceError)return res.status(error.status).json({error:error.message,...error.extra});
 if(error instanceof z.ZodError)return res.status(400).json({error:'Request did not match the expected review schema'});
 return res.status(500).json({error:'Review feedback could not be prepared'});
}
type Handler=(req:express.Request,res:express.Response)=>void|Promise<void>;
const wrap=(handler:Handler):express.RequestHandler=>async(req,res)=>{try{res.setHeader('Cache-Control','private, no-store');await handler(req,res);}catch(error){send(res,error);}};

/** Mounted by main after native session middleware has installed fresh read/write and active-scope guards. */
export function mountReviewFeedbackRoutes(app:express.Express,service:GameService){
 const guards=app.locals.guards;
 if(!guards?.requireFreshRead||!guards?.requireWrite||!guards?.requireActive)throw new Error('Review feedback routes require native authorization guards');
 app.get('/api/learning/reviews',guards.requireFreshRead,guards.requireActive,wrap((req,res)=>{
  const session=sessionOf(res),query=querySchema.parse(req.query);
  res.json(reviewFeedback(service,session,query,canReview(res,session)));
 }));
 app.post('/api/learning/reviews',guards.requireWrite,guards.requireActive,wrap((req,res)=>{
  const session=requireInstructorWrite(res),body=reviewFeedbackInput.parse(req.body),result=saveReviewFeedback(service,session,body);
  res.status(result.duplicate?200:201).json(result.storedReview);
 }));
}
