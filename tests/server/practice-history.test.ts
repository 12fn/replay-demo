import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import express from 'express';
import {GameService,type Identity} from '../../src/server/service';
import {practiceHistory} from '../../src/server/practice-history';
import {mountPracticeHistoryRoutes} from '../../src/server/practice-history-routes';
import {McpService} from '../../src/server/mcp-service';
import type {KamiwazaConfig} from '../../src/server/native-http';
import type {ExerciseRow} from '../../src/server/store';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
const config:KamiwazaConfig={mode:'kamiwaza',apiBase:'https://example.invalid/api',workroomId:'room',forwardedHost:'example.invalid',forwardedProto:'https',allowedOrigins:[],cookieSecure:true,allowLegacyRecordings:true};
const person=(subject='alice',role:Identity['role']='commander'):Identity=>({subject,name:subject,role,mode:'kamiwaza',organization:'fictional'});
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'practice-history-')),s=new GameService(dir);clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}),()=>s.close());
 const row=(owner='alice',room:string|null='room',kind:ExerciseRow['kind']='recorded',status='completed',name='Practice'):ExerciseRow=>{const r:ExerciseRow={id:randomUUID(),name,kind,status,createdAt:'2026-09-01T00:00:00Z',humanSide:'blue',agentEnabled:false,options:{ownerSubject:owner,workroomId:room,scenarioId:'station-practice',scenario:{id:'crosscurrent-objectives/1'},map:'world-500',simulationProfile:'naval-isolation/1',curriculumVersion:'0.1.0',assistance:'unassisted'}};s.store.putExercise(r);return r;};
 const event=(r:ExerciseRow,actor='alice',kind='command',summary='Choice',details:Record<string,unknown>={})=>s.store.event(r.id,20,kind,actor,summary,{origin:'human',intent:{type:'attack',troops:40},observation:{tick:18,player:{troops:100}},sourceIds:['report-a'],rationale:'Recorded reason',...details},'blue');
 return {s,row,event,read:(q:unknown={},who=person())=>practiceHistory(s,config,who,q)};
}
it('queries exact own retained events with scenario context while hiding peer/model/legacy/live/other-room data',()=>{
 const {s,row,event,read}=setup(),own=row();event(own);event(own,'bob','assessment_log','private peer narrative');event(own,'alice','model_decision','private model');event(own,'alice','command','agent choice',{origin:'luna'});event(row('bob'),'bob');event(row('alice','different'));event(row('alice',null));event(row('alice','room','live','running'));
 const result=read();expect(result.items).toHaveLength(1);expect(result.items[0]).toMatchObject({observedTick:18,tick:20,commitmentRatio:0.4,rationaleRecorded:true,exercise:{scenarioVersion:'crosscurrent-objectives/1',map:'world-500'}});expect(JSON.stringify(result)).not.toContain('private peer');expect(JSON.stringify(result)).not.toContain('Recorded reason');expect(result.summary).toMatchObject({basis:'returned-page-only',commands:1});expect(()=>read({scope:'workroom'})).toThrow('instructor');
 const instructor=read({scope:'workroom'},person('teacher','instructor'));expect(instructor.items).toHaveLength(3);expect(instructor.items.every(i=>i.exercise.status==='completed')).toBe(true);expect(s.store.events(own.id)).toHaveLength(4);
});
it('keeps pagination stable under new inserts and supports literal text/scenario filters without widening scope',()=>{
 const {row,event,read}=setup(),r=row();const a=event(r,'alice','command','25% commitment'),b=event(r,'alice','command','reserve'),c=event(r,'alice','command','reserve');const first=read({limit:2});expect(first.items.map(x=>x.eventId)).toEqual([c,b]);expect(first.hasMore).toBe(true);event(r,'alice','command','newer');const next=read({limit:2,beforeSequence:first.nextBeforeSequence});expect(next.items.map(x=>x.eventId)).toEqual([a]);expect(next.hasMore).toBe(false);expect(read({query:'%'}).items.map(x=>x.eventId)).toEqual([a]);expect(read({query:"' OR 1=1 --"}).items).toEqual([]);expect(read({query:'station-practice'}).items).toHaveLength(4);expect(read({scenarioId:'different'}).items).toEqual([]);expect(()=>read({subject:'bob'})).toThrow();expect(()=>read({limit:1000})).toThrow();
});
it('keeps branches distinct, hides inaccessible parents, excludes inherited acts and respects enrollment revocation',()=>{
 const {s,row,event,read}=setup(),parent=row('bob'),branch=row('alice','room','branch');branch.parentId=parent.id;branch.forkTick=10;s.store.putExercise(branch);event(branch);event(branch,'alice','inherited_event','not a new act');const result=read();expect(result.items).toHaveLength(1);expect(result.items[0].exercise).toMatchObject({kind:'branch',parentId:null,forkTick:10});expect(result.summary.branchEvents).toBe(1);
 const shared=row('bob');s.teams.enroll(shared,person(),1);event(shared);expect(read().items).toHaveLength(2);s.teams.remove(shared,'alice','bob');expect(read().items).toHaveLength(1);
});
it('redacts projected text, never exports arbitrary details, and validates native identity mode',()=>{
 const {row,event,read}=setup(),r=row();event(r,'alice','command','Choice sk-abcdefghijklmnopqrstuv',{hidden:'private payload',observation:{tick:3,player:{troops:0}},rationale:'',sourceIds:['safe']});const out=read();expect(JSON.stringify(out)).not.toMatch(/abcdefghijklmnopqrstuv|private payload/);expect(out.items[0].commitmentRatio).toBe(null);expect(out.items[0].rationaleRecorded).toBe(false);expect(()=>read({}, {...person(),mode:'local-demo'})).toThrow('identity');
});
it('exposes the same bounded personal history over MCP without browser state or model calls',async()=>{
 const {s,row,event}=setup();const r=row();event(r);const mcp=new McpService({service:s,config});const before=s.ledger.summary();const result=await mcp.call('search_practice_history',{query:'Choice'},person());expect((result.items as any[])).toHaveLength(1);expect(s.ledger.summary()).toEqual(before);expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0);await expect(mcp.call('search_practice_history',{scope:'workroom'},person())).rejects.toThrow('instructor');
});
it('HTTP search uses fresh identity, no-store and strict pagination; role change removes workroom access',async()=>{
 const {s,row,event}=setup();event(row());const app=express();let identity=person('teacher','instructor'),denied=false,calls=0;app.locals.guards={requireFreshRead:(_q:any,r:any,n:any)=>{calls++;if(denied)return r.sendStatus(403);r.locals.identity=identity;n();}};mountPracticeHistoryRoutes(app,s,config);const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));clean.push(()=>server.close());const base=`http://127.0.0.1:${(server.address() as any).port}/api/practice/history`;
 const first=await fetch(base+'?scope=workroom&limit=2');expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toContain('no-store');expect((await first.json()).items).toHaveLength(1);identity=person('teacher');expect((await fetch(base+'?scope=workroom')).status).toBe(403);expect((await fetch(base+'?limit=NaN')).status).toBe(400);expect((await fetch(base+'?subject=alice')).status).toBe(400);denied=true;expect((await fetch(base)).status).toBe(403);expect(calls).toBe(5);
});
