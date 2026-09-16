import {afterEach,expect,it} from 'vitest';
import express from 'express';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService} from '../../src/server/service';import {mountRecordingRoutes} from '../../src/server/recording-routes';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
async function setup(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'recording-test-')),s=new GameService(d);cleanup.push(()=>fs.rmSync(d,{recursive:true,force:true}),()=>s.close());
 const app=express();app.use((req,res,next)=>{res.locals.session={identity:{subject:req.headers['x-test-user']??'one'},activeId:'exercise-one'};res.locals.native={context:{workroomId:req.headers['x-test-room']??'room-one'}};next();});
 app.locals.guards={requireActive:(_q:any,_r:any,n:any)=>n(),requireWrite:(q:any,r:any,n:any)=>q.headers['x-test-readonly']?r.sendStatus(403):n()};mountRecordingRoutes(app,s);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));cleanup.push(()=>server.close());const base=`http://127.0.0.1:${(server.address() as any).port}`;return {s,d,base};}
const media=Buffer.from([0x1a,0x45,0xdf,0xa3,0,1,2,3]);
it('stores actual media bytes with a digest and only serves the authenticated owner in the same workroom',async()=>{const {base,d}=await setup();const res=await fetch(base+'/api/recordings',{method:'POST',headers:{'content-type':'video/webm'},body:media});expect(res.status).toBe(201);const r:any=await res.json();expect(r).toMatchObject({subject:'one',workroom:'room-one',bytes:8});expect(fs.readFileSync(path.join(d,'recordings',r.id+'.webm'))).toEqual(media);expect(fs.statSync(path.join(d,'recordings',r.id+'.webm')).mode&0o777).toBe(0o600);
 const own=await fetch(`${base}/api/recordings/${r.id}/media`);expect(own.status).toBe(200);expect(own.headers.get('cache-control')).toContain('no-store');expect(Buffer.from(await own.arrayBuffer())).toEqual(media);
 for(const h of [{'x-test-user':'two'},{'x-test-room':'another'}] as Record<string,string>[]){expect((await fetch(`${base}/api/recordings/${r.id}/media`,{headers:h})).status).toBe(404);expect(await(await fetch(base+'/api/recordings',{headers:h})).json()).toEqual([]);}
});
it('refuses revoked writes and invalid media without creating a record',async()=>{const {base,s}=await setup();expect((await fetch(base+'/api/recordings',{method:'POST',headers:{'content-type':'video/webm','x-test-readonly':'true'},body:media})).status).toBe(403);expect((await fetch(base+'/api/recordings',{method:'POST',headers:{'content-type':'video/webm'},body:'not a video'})).status).toBe(400);expect(s.store.db.prepare("SELECT key FROM settings WHERE key LIKE 'recording:%'").all()).toEqual([]);});
