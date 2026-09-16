import type express from 'express';import {z} from 'zod';
import {catalogFor} from './catalog-store';import type {GameService} from './service';
export function mountCatalogRoutes(app:express.Express,service:GameService){
 const catalog=catalogFor(service.store.db);
 for(const route of ['/api/catalog','/api/catalog/search','/api/catalog/records/:id'])app.get(route,(_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();},app.locals.guards.requireFreshRead,(req,res)=>{
  try{
   if(route==='/api/catalog')return res.json(catalog.summary(res.locals.identity.role));
   if(route==='/api/catalog/search'){const q={...req.query};for(const k of ['offset','limit','cutoffTick'])if(q[k]!==undefined){if(typeof q[k]!=='string'||!/^\d+$/.test(q[k] as string))return res.status(400).json({error:'Invalid catalog pagination or cutoff'});(q as any)[k]=Number(q[k]);}return res.json(catalog.search(q));}
   let cutoff:number|undefined;if(req.query.cutoffTick!==undefined){if(typeof req.query.cutoffTick!=='string'||!/^\d+$/.test(req.query.cutoffTick))return res.status(400).json({error:'Invalid catalog cutoff'});cutoff=Number(req.query.cutoffTick);}
   const detail=catalog.detail(req.params.id as string,cutoff);if(!detail)return res.status(404).json({error:'Catalog record not available'});return res.json(detail);
  }catch(e){return res.status(e instanceof z.ZodError?400:500).json({error:e instanceof z.ZodError?'Invalid catalog query':'Catalog unavailable'});}
 });
}
