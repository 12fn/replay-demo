import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {GameService,Session} from './service';
const validId=/^[a-f0-9-]{36}$/;
export function mountRecordingRoutes(app:express.Express,service:GameService){
 const dir=path.join(service.dataDir,'recordings');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const who=(res:express.Response)=>{const s=res.locals.session as Session;return {subject:s.identity.subject,workroom:res.locals.native?.context?.workroomId??'local-demo'};};
 const owned=(res:express.Response,r:any)=>{const w=who(res);return r?.subject===w.subject&&r?.workroom===w.workroom;};
 const read=(id:string)=>{const r=service.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`recording:${id}`) as any;return r?JSON.parse(r.value):null;};
 const active=app.locals.guards?.requireActive??((_q:any,_r:any,n:any)=>n());
 const write=app.locals.guards?.requireWrite??((_q:any,_r:any,n:any)=>n());
 app.get('/api/recordings',active,(_req,res)=>{
  const rows=service.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'recording:%'").all() as any[];
  res.json(rows.map(r=>JSON.parse(r.value)).filter(r=>owned(res,r)));
 });
 app.post('/api/recordings',active,write,express.raw({type:['video/webm','video/mp4'],limit:'128mb'}),(req,res)=>{
  const bytes=req.body;const type=req.headers['content-type']?.split(';')[0];
  const webm=Buffer.isBuffer(bytes)&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  const mp4=Buffer.isBuffer(bytes)&&bytes.subarray(4,8).toString()==='ftyp';
  if(!bytes?.length||!(type==='video/webm'&&webm||type==='video/mp4'&&mp4))return res.status(400).json({error:'Expected a WebM or MP4 recording'});
  const id=randomUUID();const ext=type==='video/mp4'?'mp4':'webm';const file=path.join(dir,`${id}.${ext}`);
  const reported=(name:string,max:number)=>{const n=Number(req.headers[name]);return Number.isFinite(n)&&n>=0?Math.min(n,max):null;};
  const record={id,...who(res),exerciseId:res.locals.session.activeId,createdAt:new Date().toISOString(),method:'Rendered application DOM frames (not OS screen capture)',durationMs:reported('x-replay-duration-ms',900000),frames:reported('x-replay-frame-count',10000),failedFrames:reported('x-replay-failed-frames',10000),clientReportedTiming:true,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),type,ext};
  try{fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});service.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`recording:${id}`,JSON.stringify(record));res.status(201).json(record);}
  catch{fs.rmSync(file,{force:true});res.status(500).json({error:'Recording could not be stored'});}
 });
 app.get('/api/recordings/:id/media',active,(req,res)=>{
  const id=String(req.params.id);if(!validId.test(id))return res.sendStatus(404);
  const record=read(id);if(!owned(res,record)||!['webm','mp4'].includes(record.ext))return res.sendStatus(404);
  res.setHeader('Content-Type',record.type);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition',`attachment; filename="replay-${id}.${record.ext}"`);
  res.sendFile(path.resolve(dir,`${id}.${record.ext}`));
 });
}
