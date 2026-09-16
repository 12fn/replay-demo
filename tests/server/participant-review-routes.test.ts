import {afterEach,expect,it} from 'vitest';import express from 'express';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService,type Identity,type Session} from '../../src/server/service';import {mountReviewRoutes} from '../../src/server/review-routes';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
/** The route never reads a role from the request: the test swaps the server-held session between calls. */
async function serve(){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'participant-review-routes-')),s=new GameService(d);clean.push(()=>fs.rmSync(d,{recursive:true,force:true}),()=>s.close());
 const learner:Identity={subject:'sub-learner',name:'Learner One',role:'commander',organization:'Synthetic',mode:'kamiwaza'};const peer:Identity={...learner,subject:'sub-peer',name:'Peer Two'};
 const row=await s.create('Route class','plains',learner),w=s.world(row.id);s.teams.enroll(row,learner,1);s.teams.enroll(row,peer,1);for(let n=0;n<25;n++)s.tick(w);
 s.command(row.id,'blue',{type:'attack',targetID:null,troops:10},'route-order',learner);s.tick(w);const order=s.store.events(row.id).find(e=>e.kind==='command'&&e.actor==='sub-learner')!;
 const instructor:Session={identity:{subject:'sub-instructor',name:'Instructor',role:'instructor',organization:'Synthetic',mode:'kamiwaza'},activeId:row.id,playbackTick:null,selectedSide:'blue'};
 let session:Session=instructor;const app=express();app.use(express.json());app.use((_q,r,n)=>{r.locals.session=session;n();});
 app.locals.guards={requireActive:(_q:any,_r:any,n:any)=>n(),requireWrite:(_q:any,_r:any,n:any)=>n()};mountReviewRoutes(app,s);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));clean.push(()=>server.close());const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const get=(p:string)=>fetch(base+p);const post=(b:unknown)=>fetch(base+'/api/review/assessment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
 return {s,row,order,get,post,as:(x:Session)=>{session=x;},instructor,learnerSession:{...instructor,identity:learner} as Session,peerSession:{...instructor,identity:peer} as Session};
}
const judgment=(o:Record<string,unknown>)=>({criterionId:'C1',baseVersion:0,score:2,disposition:'confirmed',rationale:'The order was placed after the release and shows the commitment.',evidenceIds:[] as string[],...o});

it('validates the target on read and write, denies learner writes by server-held role, and hides a peer\'s finding over HTTP',async()=>{
 const f=await serve();
 expect((await f.get('/api/review/assessment?participant=')).status).toBe(200);
 expect((await f.get('/api/review/assessment?participant='+'x'.repeat(201))).status).toBe(400);
 expect((await f.get('/api/review/assessment?participant=a&participant=b')).status).toBe(400);
 expect((await f.get('/api/review/assessment?participant=sub-nobody')).status).toBe(404);
 expect((await f.post(judgment({participantSubject:42,evidenceIds:[f.order.id]}))).status).toBe(400);
 expect((await f.post(judgment({participantSubject:'sub-peer',evidenceIds:[f.order.id]}))).status).toBe(400);
 const saved=await f.post(judgment({participantSubject:'sub-learner',evidenceIds:[f.order.id]}));expect(saved.status).toBe(201);expect((await saved.json()).participantSubject).toBe('sub-learner');
 expect((await f.post(judgment({evidenceIds:[f.order.id],rationale:'Exercise-wide: the group committed early.'}))).status).toBe(201);
 const view=await (await f.get('/api/review/assessment?participant=sub-learner')).json();expect(view.target).toMatchObject({kind:'participant',subject:'sub-learner'});expect(view.current[0].judgment.version).toBe(1);expect(view.targets).toHaveLength(3);
 f.as(f.peerSession);
 expect((await f.post({...judgment({participantSubject:'sub-peer',evidenceIds:[f.order.id]}),role:'instructor'})).status).toBe(403);
 expect((await f.post(judgment({participantSubject:'sub-peer',evidenceIds:[f.order.id]}))).status).toBe(403);
 expect((await f.get('/api/review/assessment?participant=sub-learner')).status).toBe(403);
 const peerView=await (await f.get('/api/review/assessment')).json();expect(peerView.targets.map((t:any)=>t.subject)).toEqual([null,'sub-peer']);expect(peerView.history.every((r:any)=>!r.participantSubject)).toBe(true);
 f.s.world(f.row.id).row.status='completed';
 const md=await (await f.get('/api/review/export.md')).text();expect(md).toContain('# Exercise-wide findings');expect(md).not.toContain('# Participant findings');expect(md).not.toContain('shows the commitment');
 const json=await (await f.get('/api/review/export.json')).json();expect(json.payload.assessment.history.map((r:any)=>r.participantSubject??null)).toEqual([null]);expect(JSON.stringify(json)).not.toContain('"participantSubject":"sub-learner"');
 f.as(f.instructor);expect(JSON.stringify(await (await f.get('/api/review/export.json')).json())).toContain('"participantSubject":"sub-learner"');
});

it('does not release another participant personal debrief through completed-exercise exports',async()=>{
 const f=await serve();f.s.world(f.row.id).row.status='completed';
 const put=(prefix:string,author:string,hash:string,text:string)=>f.s.store.db.prepare('INSERT INTO settings VALUES(?,?)').run(`${prefix}:${f.row.id}:${hash}`,JSON.stringify({hash,author,markdown:text}));
 put('learning.debrief','sub-learner','one','Learner private coaching');
 put('learning.debrief-history','sub-learner','old','Earlier learner coaching');
 put('learning.debrief','sub-peer','two','Peer private coaching');
 f.as(f.peerSession);const peer=await (await f.get('/api/review/export.json')).json();
 expect(peer.payload.debriefs.map((d:any)=>d.author)).toEqual(['sub-peer']);expect(JSON.stringify(peer)).not.toContain('Learner private coaching');expect(JSON.stringify(peer)).not.toContain('Earlier learner coaching');
 f.as(f.learnerSession);expect((await (await f.get('/api/review/export.json')).json()).payload.debriefs.map((d:any)=>d.hash).sort()).toEqual(['old','one']);
 f.as(f.instructor);expect((await (await f.get('/api/review/export.json')).json()).payload.debriefs).toHaveLength(3);
});
