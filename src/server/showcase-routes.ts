import type express from 'express';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {type GameService,type Session,ServiceError} from './service';
export function mountShowcaseRoutes(app:express.Express,service:GameService){
 const guard=app.locals.guards;if(!guard?.requireFreshRead||!guard?.requireWrite)throw Error('Showcase routes require native authorization guards');
 app.use('/api/showcase',(_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
 app.get('/api/showcase',guard.requireFreshRead,(_req,res)=>{
  try{const manifest=JSON.parse(fs.readFileSync(path.join(process.cwd(),'resources/showcase/manifest.json'),'utf8'));const proofBytes=fs.readFileSync(path.join(process.cwd(),'resources/showcase/recorded-proof.json'));if(createHash('sha256').update(proofBytes).digest('hex')!==manifest.recordedProofSha256)throw Error('Recorded showcase proof hash mismatch');const analysisBytes=fs.readFileSync(path.join(process.cwd(),'resources/showcase/recorded-debrief.json'));if(createHash('sha256').update(analysisBytes).digest('hex')!==manifest.recordedDebriefSha256)throw Error('Recorded debrief hash mismatch');const session=res.locals.session as Session,workroomId=res.locals.native?.context.workroomId??null;
   const prepared=service.store.exercises().find(e=>e.options.showcaseSynthetic===true&&e.options.showcaseVersion===manifest.version&&e.options.ownerSubject===session.identity.subject&&(e.options.workroomId??null)===workroomId);
   res.json({manifest,recordedProof:JSON.parse(proofBytes.toString()),recordedAnalysis:JSON.parse(analysisBytes.toString()),prepared:prepared?{exerciseId:prepared.id,selectedEventId:`${prepared.id}:${manifest.fixture.selectedEventId}`,reviewTick:manifest.fixture.reviewTick,forkTick:manifest.fixture.forkTick}:null,paidCalls:0,claim:'Prepared authored rehearsal and separately identified recorded native AI evidence. Neither establishes human learning efficacy.'});
  }catch{res.status(503).json({error:'Prepared showcase is unavailable or failed its evidence hash check'});}
 });
 app.post('/api/showcase/prepare',guard.requireWrite,async(_req,res)=>{try{const s=res.locals.session as Session;res.status(201).json(await service.prepareShowcase(s.identity,res.locals.native?.context.workroomId??null));}catch(e){res.status(e instanceof ServiceError?e.status:500).json({error:e instanceof ServiceError?e.message:'Prepared showcase could not be installed'});}});
}
