import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import express from 'express';
import {GameService,type Identity} from '../../src/server/service';
import {mountPracticeHistoryRoutes} from '../../src/server/practice-history-routes';
import {McpService} from '../../src/server/mcp-service';
import type {KamiwazaConfig} from '../../src/server/native-http';
import type {ExerciseRow} from '../../src/server/store';
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
const config:KamiwazaConfig={mode:'kamiwaza',apiBase:'https://example.invalid/api',workroomId:'room',forwardedHost:'example.invalid',forwardedProto:'https',allowedOrigins:[],cookieSecure:true,allowLegacyRecordings:true};
const who=(subject='alice',role:Identity['role']='commander'):Identity=>({subject,name:subject,role,mode:'kamiwaza',organization:'fictional'});
async function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'practice-detail-routes-')),s=new GameService(dir);cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}),()=>s.close());
 const row=(owner='alice',status='completed',room='room')=>{const r:ExerciseRow={id:randomUUID(),name:'Fictional relay practice',kind:'recorded',status,createdAt:'2026-09-01T00:00:00Z',humanSide:'blue',agentEnabled:false,options:{ownerSubject:owner,workroomId:room,scenarioId:'taiwan-strait/1',map:'taiwan-strait-400'}};s.store.putExercise(r);return r;};
 const event=(r:ExerciseRow,actor='alice',rationale='Wait for independent corroboration')=>s.store.event(r.id,30,'command',actor,'Recorded expansion',{origin:'human',commandId:randomUUID(),intent:{type:'attack',targetID:null,troops:25},admittedTick:29,rationaleTiming:'contemporaneous',rationale,observation:{tick:28,player:{troops:100}},sourceIds:[]},'blue');
 const state={identity:who(),denied:false,checks:0};const app=express();app.locals.guards={requireFreshRead:(_req:any,res:any,next:any)=>{state.checks++;if(state.denied)return res.sendStatus(403);res.locals.identity=state.identity;next();}};
 mountPracticeHistoryRoutes(app,s,config);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));cleanup.push(()=>server.close());const base=`http://127.0.0.1:${(server.address() as any).port}`;
 return {s,row,event,state,base,mcp:new McpService({service:s,config}),get:(query='')=>fetch(base+'/api/practice/history/details'+query)};
}
it('serves identical statement evidence through authenticated HTTP and MCP without model calls or browser sessions',async()=>{
 const f=await fixture(),r=f.row(),id=f.event(r);const before=f.s.ledger.summary();
 const res=await f.get('?query=corroboration');expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('private, no-store');const body=await res.json();
 const mcp=await f.mcp.call('search_practice_details',{query:'corroboration'},who());expect(mcp).toEqual(body);expect(body.schema).toBe('replay.practice-history/2');
 expect(body.items[0]).toMatchObject({eventId:id,ticks:{observed:28,recorded:30},reason:'written-statement',statement:{timing:'contemporaneous',text:'Wait for independent corroboration'},exercise:{id:r.id,map:'taiwan-strait-400'}});
 expect(JSON.stringify(body).length).toBeLessThanOrEqual(6000);expect(f.s.ledger.summary()).toEqual(before);expect(f.s.store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0);
 // The old path stays /1 and does not broaden its search to reasons.
 const old=await(await fetch(f.base+'/api/practice/history?query=corroboration')).json();expect(old).toMatchObject({schema:'replay.practice-history/1',items:[]});
});
it('uses each fresh role and identity; excludes live/foreign/peer data and revoked enrollment',async()=>{
 const f=await fixture(),own=f.row(),shared=f.row('bob');f.event(own);f.event(own,'bob','Peer decision');f.event(f.row('alice','running'),'alice','Live decision');f.event(f.row('alice','completed','other'),'alice','Foreign decision');
 f.s.teams.enroll(shared,who(),1);f.event(shared);expect((await(await f.get()).json()).items).toHaveLength(2);
 f.s.teams.remove(shared,'alice','bob');expect((await(await f.get()).json()).items).toHaveLength(1);
 f.state.identity=who('teacher','instructor');expect((await f.get('?scope=workroom')).status).toBe(200);
 f.state.identity=who('teacher','commander');expect((await f.get('?scope=workroom')).status).toBe(403);
 f.state.identity=who('stranger');expect((await(await f.get()).json()).items).toEqual([]);
 f.state.denied=true;const denied=await f.get();expect(denied.status).toBe(403);expect(denied.headers.get('cache-control')).toContain('no-store');expect(f.state.checks).toBe(6);
 await expect(f.mcp.call('search_practice_details',{scope:'workroom'},who())).rejects.toThrow('instructor');
});
it('refuses identity injection, malformed pagination, excessive limits and secret-search probes',async()=>{
 const f=await fixture();f.event(f.row(),'alice','Secret sk-abcdefghijklmnopqrstuv');
 for(const query of ['?subject=bob','?side=red','?limit=11','?limit=1.5','?limit=-1','?limit=1&limit=2','?beforeSequence=0','?beforeSequence=9007199254740992'])expect((await f.get(query)).status,query).toBe(400);
 for(const args of [{subject:'bob'},{limit:11},{beforeSequence:1.5}])await expect(f.mcp.call('search_practice_details',args,who())).rejects.toThrow('Invalid practice search');
 const hidden=await(await f.get('?query=abcdefghijklmnopqrstuv')).json();expect(hidden.items).toEqual([]);
 const safe=await(await f.get()).json();expect(JSON.stringify(safe)).not.toContain('sk-abcdefghijklmnopqrstuv');
});
it('keeps stable descending pagination and distinguishes missing reasons from citations and post-hoc statements',async()=>{
 const f=await fixture(),r=f.row();const a=f.event(r),b=f.s.store.event(r.id,40,'decision_log','alice','Later explanation',{commandEventId:a,orderTick:30,orderObservedTick:28,text:'I revised my assessment afterwards',timing:'contemporaneous',sourceIds:[]},'blue');
 const c=f.s.store.event(r.id,50,'command','alice','Citation only',{origin:'human',sourceIds:['fictional-r1'],intent:{type:'attack',troops:1}},'blue');
 const first=await(await f.get('?limit=1')).json();expect(first.items[0]).toMatchObject({eventId:c,reason:'citation-only',statement:null});expect(first.hasMore).toBe(true);
 f.event(r,'alice','New insert');const second=await(await f.get('?limit=1&beforeSequence='+first.nextBeforeSequence)).json();expect(second.items[0]).toMatchObject({eventId:b,statement:{timing:'post-hoc'},reference:{commandEventId:a,orderTick:30}});
 const last=await f.mcp.call('search_practice_details',{limit:1,beforeSequence:second.nextBeforeSequence},who()) as any;expect(last.items[0].eventId).toBe(a);expect(last.hasMore).toBe(false);expect(first.summary.basis).toBe('returned-page-only');
});

it('masks inaccessible parent IDs in legacy source citations as well as detailed history',async()=>{
 const f=await fixture(),parent=f.row('bob'),branch=f.row();branch.kind='branch';branch.parentId=parent.id;branch.forkTick=1;f.s.store.putExercise(branch);
 f.s.store.event(branch.id,30,'command','alice','Branch choice',{origin:'human',sourceIds:[`${branch.id}:${parent.id}:report`]},'blue');
 const v1=await(await fetch(f.base+'/api/practice/history')).json(),v2=await(await f.get()).json();
 for(const result of [v1,v2]){expect(JSON.stringify(result)).not.toContain(parent.id);expect(JSON.stringify(result)).toContain('[unavailable-exercise]');}
 f.s.teams.enroll(parent,who(),1);
 const accessible=await(await f.get()).json();expect(accessible.items[0].exercise.parentId).toBe(parent.id);expect(accessible.items[0].sources.items[0].id).toContain(parent.id);
});
