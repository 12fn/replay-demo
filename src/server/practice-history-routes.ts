import type express from 'express';
import {z} from 'zod';
import {practiceHistory,practiceHistoryDetails} from './practice-history';
import type {AppConfig} from './native-http';
import {ServiceError,type GameService} from './service';

export function mountPracticeHistoryRoutes(app:express.Express,service:GameService,config:AppConfig){
 for(const [route,project] of [['/api/practice/history',practiceHistory],['/api/practice/history/details',practiceHistoryDetails]] as const)app.get(route,(_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();},app.locals.guards.requireFreshRead,(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  try{
   const query={...req.query};for(const key of ['limit','beforeSequence'])if(query[key]!==undefined){if(typeof query[key]!=='string'||!/^\d+$/.test(query[key] as string))throw new ServiceError(400,'Invalid history pagination');(query as any)[key]=Number(query[key]);}
   res.json(project(service,config,res.locals.identity,query));
  }catch(e){res.status(e instanceof ServiceError?e.status:e instanceof z.ZodError?400:500).json({error:e instanceof ServiceError?e.message:e instanceof z.ZodError?'Invalid practice search':'Practice search is unavailable'});}
 });
}
