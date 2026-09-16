import {decisionTrace} from '../review/decision-trace';
import type express from 'express';import {z} from 'zod';
import {ServiceError,type GameService,type Session} from './service';
import {assessment,saveJudgment,exportAssessment,exportMarkdown} from '../review/assessment';
/** Optional review target. The session (never the browser) decides whether the subject may be viewed; this only checks shape. */
const participantQuery=z.union([z.undefined(),z.string().max(200)]);
export function mountReviewRoutes(app:express.Express,service:GameService){
 const guard=app.locals.guards;
 app.use('/api/review',guard.requireActive,(req,res,next)=>req.method==='GET'?next():guard.requireWrite(req,res,next));
 const wrap=(fn:(req:express.Request,res:express.Response)=>unknown):express.RequestHandler=>(req,res)=>{try{res.setHeader('Cache-Control','private, no-store');fn(req,res);}catch(e){res.status(e instanceof ServiceError?e.status:e instanceof z.ZodError?400:500).json({error:e instanceof ServiceError?e.message:e instanceof z.ZodError?'Invalid judgment fields':'Review could not be prepared'});}};
 app.get('/api/review/decision-trace',wrap((req,res)=>{
  const query=z.object({exerciseId:z.string().min(1).max(200),eventId:z.string().min(1).max(512),side:z.enum(['blue','red']),cutoffTick:z.coerce.number().int().nonnegative(),includeLater:z.enum(['true','false']).optional()}).strict().parse(req.query);
  const session=res.locals.session as Session;
  if(query.exerciseId!==session.activeId)throw new ServiceError(409,'Exercise changed; reload this review');
  const w=service.world(session.activeId);
  if(query.side!==w.row.humanSide&&session.identity.role!=='instructor'&&w.row.status!=='completed')throw new ServiceError(403,'Opposing records are released when the exercise ends');
  const cutoff=session.playbackTick??w.engine.game.ticks();
  if(query.cutoffTick>cutoff||(session.playbackTick!==null&&query.cutoffTick!==cutoff))throw new ServiceError(409,'Review time changed; reload this moment');
  const project=(at:number)=>decisionTrace({exerciseId:w.row.id,events:service.store.events(w.row.id,at),reports:service.store.reports(w.row.id,at),eventId:query.eventId,side:query.side,cutoffTick:at});
  const selected=project(query.cutoffTick),includeLater=query.includeLater==='true';
  if(includeLater&&w.row.status!=='completed')throw new ServiceError(409,'Later outcomes are available after the exercise ends');
  if(includeLater&&selected.command.status!=='recorded')throw new ServiceError(404,'Select a command available at the displayed tick');
  // Read-only hindsight: the selected map/session tick stays unchanged.
  res.json({...(includeLater?project(w.engine.game.ticks()):selected),review:{viewTick:query.cutoffTick,scope:includeLater?'later-outcomes':'as-of'}});
 }));
 app.get('/api/review/assessment',wrap((req,res)=>{const participant=participantQuery.parse(req.query.participant);res.json(assessment(service,res.locals.session as Session,participant??null));}));
 app.post('/api/review/assessment',wrap((req,res)=>res.status(201).json(saveJudgment(service,res.locals.session as Session,req.body))));
 for(const ext of ['json','md'])app.get(`/api/review/export.${ext}`,wrap((_req,res)=>{const bundle=exportAssessment(service,res.locals.session as Session);res.setHeader('Content-Disposition',`attachment; filename="replay-review-${bundle.payload.exercise.id}.${ext}"`);res.setHeader('X-Content-Type-Options','nosniff');if(ext==='json')res.json(bundle);else res.type('text/markdown').send(exportMarkdown(bundle));}));
}
