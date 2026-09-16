import {afterEach,expect,it} from 'vitest';import express from 'express';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService,type Identity,type Session} from '../../src/server/service';
import {CampaignService,type CampaignResolver} from '../../src/server/campaign-service';
import {mountCampaignRoutes} from '../../src/server/campaign-routes';
const clean:(()=>void)[]=[];afterEach(()=>{for(const fn of clean.splice(0).reverse())fn();});
const owner:Identity={subject:'sub-owner',name:'Owner One',role:'commander',organization:'Synthetic',mode:'kamiwaza'};
const RULES={id:'test/1',targetTicks:200,maxMissions:3,scenarioIds:['crosscurrent-classic/1']};
const scope={ownerSubject:owner.subject,workroomId:'room'};
function fixture(dir?:string){
 if(!dir){dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-campaign-int-'));const d=dir;clean.push(()=>fs.rmSync(d,{recursive:true,force:true}));}
 const service=new GameService(dir);service.baseline=()=>{};const close=()=>service.close();clean.push(close);
 const campaigns=new CampaignService(service);const auth={allowed:true,checks:0};
 const resolve:CampaignResolver=async()=>{auth.checks++;if(!auth.allowed)throw new Error('Native write revoked');return {identity:owner,workroomId:'room'};};
 const missions=()=>service.store.exercises().filter(e=>typeof e.options?.campaignId==='string');
 const runOut=(id:string)=>{const w=service.world(id);while(w.row.status==='running')service.tick(w);return w;};
 const finishAt=(id:string,tick:number)=>{const w=service.world(id);while(w.engine.game.ticks()<tick)service.tick(w);w.row.status='completed';w.row.kind='recorded';service.store.putExercise(w.row);service.store.event(id,w.engine.game.ticks(),'exercise_ended',owner.subject,'Exercise ended for review');return w;};
 const start=()=>campaigns.create({name:'Practice',identity:owner,workroomId:'room',resolve,rules:RULES});
 return {dir,service,campaigns,auth,resolve,missions,runOut,finishAt,start,close};
}

it('creates mission one atomically, advances after a facilitator end, caps the final mission at the exact canonical tick and preserves earlier history',async()=>{
 const f=fixture();const v1=await f.start();const id=v1.campaign.id;
 expect(v1.enabled).toBe(true);expect(v1.paused).toBeNull();expect(f.missions()).toHaveLength(1);
 const row1=f.missions()[0];expect(v1.activeExerciseId).toBe(row1.id);
 expect(row1.options).toMatchObject({campaignId:id,campaignReservation:`${id}:mission:0`,campaignEndTick:201,ownerSubject:owner.subject,workroomId:'room',scenarioId:'crosscurrent'});
 expect(row1.agentEnabled).toBe(false);expect(f.service.teams.participants(row1).map(p=>p.subject)).toEqual([owner.subject]);
 expect(v1.progress).toMatchObject({completedTicks:0,remainingTicks:200,missionCount:1});expect(v1.transitionNotice).toMatchObject({missionIndex:1,exerciseId:row1.id,previous:null,freshWorld:true});
 f.finishAt(row1.id,61);const source=JSON.stringify(f.service.record(row1.id));
 expect(f.campaigns.view(id,scope).campaign.status).toBe('running');await f.campaigns.settled(id);
 const v2=f.campaigns.view(id,scope);expect(v2.campaign.missions).toHaveLength(2);expect(v2.campaign.missions[0].end).toMatchObject({tick:61,reason:'facilitator-end',elapsedTicks:60});
 const row2=f.missions().find(r=>r.id!==row1.id)!;expect(v2.activeExerciseId).toBe(row2.id);expect(row2.options.campaignEndTick).toBe(141);expect(row2.options.campaignReservation).toBe(`${id}:mission:1`);
 expect(v2.transitionNotice).toMatchObject({missionIndex:2,exerciseId:row2.id,previous:{exerciseId:row1.id,reason:'facilitator-end',elapsedTicks:60}});expect(v2.transitionNotice?.text).toMatch(/fresh map/);
 expect(v2.progress.remainingTicks).toBe(140);
 const w2=f.runOut(row2.id);const lastTurn=f.service.store.turns(row2.id).at(-1)!;expect(lastTurn.tick).toBe(141);
 const ended=f.service.store.events(row2.id).filter(e=>e.kind==='campaign_budget_reached');expect(ended).toHaveLength(1);expect(ended[0].tick).toBe(141);expect(w2.row.status).toBe('completed');
 await f.campaigns.settled(id);const done=f.campaigns.view(id,scope);
 expect(done.campaign).toMatchObject({status:'completed',endReason:'tick-budget',playedTicks:200,reservation:null});expect(done.campaign.missions[1].end).toMatchObject({tick:141,fingerprint:lastTurn.fingerprint,reason:'campaign-budget',elapsedTicks:140});
 expect(done.enabled).toBe(false);expect(done.paused).toBeNull();expect(done.activeExerciseId).toBeNull();expect(done.progress).toMatchObject({remainingTicks:0,budgetReached:true,missionCount:2});
 expect(f.missions()).toHaveLength(2);expect(JSON.stringify(f.service.record(row1.id))).toBe(source);
 const branch=await f.service.branch(row1.id,30,'blue',owner);expect(branch.options.campaignId).toBeUndefined();expect(branch.options.campaignReservation).toBeUndefined();expect(branch.options.campaignEndTick).toBeUndefined();expect(f.missions()).toHaveLength(2);
 expect(f.campaigns.repo.history(id,scope).map(h=>h.kind)).toEqual(['created','mission-attached','mission-completed','mission-attached','mission-completed']);
},40000);

it('overlapping completion notifications and reads create exactly one next mission',async()=>{
 const f=fixture();const v=await f.start();const id=v.campaign.id;const row1=f.service.world(v.activeExerciseId!).row;
 const original=f.service.create.bind(f.service);let creations=0;f.service.create=async(...args:Parameters<GameService['create']>)=>{creations++;return original(...args);};
 f.finishAt(row1.id,61);
 for(let i=0;i<3;i++)for(const l of f.service.onExerciseEnded)l(row1);
 f.campaigns.view(id,scope);f.campaigns.view(id,scope);await f.campaigns.settled(id);
 for(const l of f.service.onExerciseEnded)l(row1);await f.campaigns.settled(id);
 expect(creations).toBe(1);expect(f.missions()).toHaveLength(2);const state=f.campaigns.view(id,scope);expect(state.campaign.missions).toHaveLength(2);expect(state.enabled).toBe(true);
},30000);

it('fresh revocation prevents the next creation and records an observable pause; restored authority resumes from the durable ledger',async()=>{
 const f=fixture();const v=await f.start();const id=v.campaign.id;const row1=f.service.world(v.activeExerciseId!).row;
 f.auth.allowed=false;f.finishAt(row1.id,61);f.campaigns.view(id,scope);await f.campaigns.settled(id);
 const paused=f.campaigns.view(id,scope);expect(paused.enabled).toBe(false);expect(paused.paused?.reason).toMatch(/revoked/);
 expect(paused.campaign.status).toBe('running');expect(paused.campaign.missions).toHaveLength(1);expect(paused.campaign.missions[0].end).toBeUndefined();expect(f.missions()).toHaveLength(1);
 expect(f.service.store.events(row1.id).filter(e=>e.kind==='campaign_progression_paused')).toHaveLength(1);
 await expect(f.campaigns.resume(id,scope,f.resolve)).rejects.toThrow(/revoked/);expect(f.missions()).toHaveLength(1);
 f.auth.allowed=true;const resumed=await f.campaigns.resume(id,scope,f.resolve);
 expect(resumed.enabled).toBe(true);expect(resumed.paused).toBeNull();expect(resumed.campaign.missions).toHaveLength(2);expect(resumed.campaign.missions[0].end?.reason).toBe('facilitator-end');expect(f.missions()).toHaveLength(2);
 await expect(f.campaigns.resume(id,{...scope,ownerSubject:'sub-other'},f.resolve)).rejects.toThrow(/scope/);
},30000);

it('a pause during asynchronous mission preparation commits nothing',async()=>{
 const f=fixture();const state=f.campaigns.repo.create({id:'11111111-1111-4111-8111-111111111111',name:'Gated',...scope,rules:RULES});
 const original=f.service.create.bind(f.service);let started!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r);
 f.service.create=async(...args:Parameters<GameService['create']>)=>{started();await wait;return original(...args);};
 const pending=f.campaigns.resume(state.id,scope,f.resolve);await ready;f.campaigns.pause(state.id,scope);release();
 await expect(pending).rejects.toThrow(/paused/);await f.campaigns.settled(state.id);
 expect(f.missions()).toHaveLength(0);expect(f.campaigns.repo.pendingExercise(state.id,scope)).toBeNull();expect([...f.service.worlds.values()].some(w=>w.row.options?.campaignId)).toBe(false);
 const view=f.campaigns.view(state.id,scope);expect(view.enabled).toBe(false);expect(view.paused?.reason).toMatch(/paused/i);expect(view.campaign.status).toBe('awaiting-mission');
});

it('a mission source fault stops the campaign without counting unrun time or creating another world',async()=>{
 const f=fixture();const v=await f.start();const id=v.campaign.id;const w=f.service.world(v.activeExerciseId!);while(w.engine.game.ticks()<20)f.service.tick(w);
 const record=f.service.store.recordTurn.bind(f.service.store);f.service.store.recordTurn=()=>{throw new Error('Synthetic storage failure');};f.service.tick(w);f.service.store.recordTurn=record;
 expect(w.row.status).toBe('fault');await f.campaigns.settled(id);
 const view=f.campaigns.view(id,scope);expect(view.campaign).toMatchObject({status:'fault',endReason:'fault',playedTicks:0,reservation:null});expect(view.campaign.missions).toHaveLength(1);expect(view.campaign.missions[0].end).toBeUndefined();
 expect(f.missions()).toHaveLength(1);expect(view.enabled).toBe(false);expect(view.paused).toBeNull();expect(f.campaigns.repo.history(id,scope).at(-1)?.kind).toBe('source-fault');
 expect(f.service.store.events(w.row.id).filter(e=>e.kind==='campaign_progression_paused')[0]?.details.reason).toMatch(/fault/);
 await expect(f.campaigns.resume(id,scope,f.resolve)).rejects.toThrow(/fault/);expect(f.missions()).toHaveLength(1);
});

it('restart recovers a created-but-unattached mission without creating another and starts paused',async()=>{
 const f=fixture();const original=f.service.create.bind(f.service);
 f.service.create=async(...args:Parameters<GameService['create']>)=>{const row=await original(...args);f.auth.allowed=false;return row;};
 await expect(f.start()).rejects.toThrow(/revoked/);
 const id=f.campaigns.repo.list(scope)[0].id;expect(f.missions()).toHaveLength(1);expect(f.campaigns.view(id,scope).campaign.missions).toHaveLength(0);
 const reserved=f.missions()[0].id;f.close();clean.splice(clean.indexOf(f.close),1);
 const restarted=new GameService(f.dir);clean.push(()=>restarted.close());await restarted.init(false);restarted.baseline=()=>{};
 const campaigns=new CampaignService(restarted);const before=campaigns.view(id,scope);expect(before.enabled).toBe(false);expect(before.paused?.reason).toMatch(/resume/);
 f.auth.allowed=true;const view=await campaigns.resume(id,scope,f.resolve);
 expect(view.campaign.missions).toHaveLength(1);expect(view.activeExerciseId).toBe(reserved);expect(restarted.store.exercises().filter(e=>e.options?.campaignId)).toHaveLength(1);expect(restarted.worlds.get(reserved)?.row.status).toBe('running');
 expect(campaigns.repo.list({...scope,ownerSubject:'sub-other'})).toEqual([]);
},30000);

async function serve(){
 // Lightweight app without a native port: identities are local-demo, so the route's native canEdit check does not apply.
 const f=fixture();const local:Identity={...owner,mode:'local-demo'},other:Identity={...local,subject:'sub-other',name:'Other'};
 const third:Identity={...local,subject:'sub-third',name:'Third',role:'intelligence'};
 const sessions:Record<string,Session>={s1:{identity:local,activeId:'',playbackTick:null,selectedSide:'blue'},s2:{identity:other,activeId:'',playbackTick:null,selectedSide:'blue'},s3:{identity:third,activeId:'',playbackTick:null,selectedSide:'blue'}};
 for(const [id,s] of Object.entries(sessions))f.service.store.putSession(id,s);
 const app=express();app.use(express.json());app.locals.guards={requireActive:(_q:any,_r:any,n:any)=>n(),requireWrite:(_q:any,_r:any,n:any)=>n(),requireAgents:(_q:any,_r:any,n:any)=>n()};
 app.use((req,res,n)=>{const id=String(req.headers['x-test-session']??'s1');res.locals.sessionId=id;res.locals.session=f.service.store.session(id);res.locals.native=null;n();});
 mountCampaignRoutes(app,f.campaigns,null);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));clean.push(()=>server.close());const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const call=(method:string,p:string,session='s1',body?:unknown)=>fetch(base+p,{method,headers:{'Content-Type':'application/json','x-test-session':session},body:body===undefined?undefined:JSON.stringify(body)});
 return {...f,call,local};
}
it('routes derive owner and workroom from the server-held session and never acknowledge another owner\'s campaign',async()=>{
 const f=await serve();
 expect((await f.call('POST','/api/campaigns','s1',{name:''})).status).toBe(400);
 expect((await f.call('POST','/api/campaigns','s1',{name:'Practice',ownerSubject:'sub-other'})).status).toBe(400);
 const created=await f.call('POST','/api/campaigns','s1',{name:'Practice'});expect(created.status).toBe(201);const body=await created.json();
 expect(Object.keys(body).sort()).toEqual(['activeExerciseId','campaign','enabled','membership','navigationSelected','paused','progress','transitionNotice']);
 expect(body.membership).toMatchObject({viewer:{subject:owner.subject,role:'owner',canManage:true},activeParticipants:0});
 expect(body.campaign).toMatchObject({ownerSubject:owner.subject,workroomId:null,status:'running'});expect(body.enabled).toBe(true);
 expect(f.service.store.session('s1').activeId).toBe(body.activeExerciseId);expect(f.service.store.exercise(body.activeExerciseId)?.options).toMatchObject({ownerSubject:owner.subject,campaignId:body.campaign.id});
 const id=body.campaign.id;
 expect((await f.call('GET',`/api/campaigns/${id}`,'s2')).status).toBe(404);
 expect((await f.call('POST',`/api/campaigns/${id}/resume`,'s2')).status).toBe(404);
 expect((await f.call('POST',`/api/campaigns/${id}/pause`,'s2')).status).toBe(404);
 expect((await f.call('POST',`/api/campaigns/${id}/stop`,'s2')).status).toBe(404);
 expect(await (await f.call('GET','/api/campaigns','s2')).json()).toEqual({campaigns:[]});
 expect((await f.call('GET','/api/campaigns/not-an-id')).status).toBe(400);
 expect((await (await f.call('GET','/api/campaigns')).json()).campaigns.map((c:any)=>c.id)).toEqual([id]);
 const paused=await (await f.call('POST',`/api/campaigns/${id}/pause`)).json();expect(paused.enabled).toBe(false);expect(paused.paused.reason).toMatch(/owner/);
 const resumed=await (await f.call('POST',`/api/campaigns/${id}/resume`)).json();expect(resumed.enabled).toBe(true);expect(resumed.paused).toBeNull();
 // Local persona switch is a fresh-authority failure: the stored session no longer belongs to the owner.
 f.service.store.putSession('s1',{...f.service.store.session('s1'),identity:{...f.local,subject:'demo-instructor'}});
 expect((await f.call('POST',`/api/campaigns/${id}/resume`)).status).toBe(404);
 f.service.store.putSession('s1',{...f.service.store.session('s1'),identity:f.local});
 const stopped=await (await f.call('POST',`/api/campaigns/${id}/stop`)).json();expect(stopped.campaign).toMatchObject({status:'stopped',endReason:'participant-stop'});expect(stopped.enabled).toBe(false);
 expect(f.service.world(body.activeExerciseId).row.status).toBe('running');
 expect((await f.call('POST',`/api/campaigns/${id}/resume`)).status).toBe(409);
 expect(f.missions()).toHaveLength(1);
},30000);

it('shared routes: opaque invite join, member-scoped reads, owner-only controls, revoke/reinstate/rejoin and self-withdrawal, all from server-held sessions',async()=>{
 const f=await serve();const other='sub-other';
 const created=await (await f.call('POST','/api/campaigns','s1',{name:'Shared'})).json();const id=created.campaign.id,m0=created.activeExerciseId;
 const json=async(r:Promise<Response>)=>{const res=await r;return {status:res.status,body:await res.json()};};
 // Nothing is acknowledged to a non-member; malformed and unknown codes are rejected without leaking anything.
 expect((await f.call('GET',`/api/campaigns/${id}`,'s2')).status).toBe(404);
 expect((await f.call('POST',`/api/campaigns/${id}/code`,'s2')).status).toBe(404);
 expect((await f.call('POST','/api/campaigns/join','s2',{code:'nope'})).status).toBe(400);
 expect((await f.call('POST','/api/campaigns/join','s2',{code:'0'.repeat(32)})).status).toBe(404);
 expect((await f.call('POST','/api/campaigns/join','s2',{code:'0'.repeat(32),campaignId:id})).status).toBe(400);
 const code=await json(f.call('POST',`/api/campaigns/${id}/code`));expect(code.status).toBe(200);expect(code.body.code).toMatch(/^[a-f0-9]{32}$/);
 expect(JSON.stringify(f.service.store.db.prepare('SELECT * FROM settings').all())).not.toContain(code.body.code);
 // Join: seat on the running mission, session selects it, and the member view says participant.
 const joined=await json(f.call('POST','/api/campaigns/join','s2',{code:code.body.code}));
 expect(joined.status).toBe(200);expect(joined.body).toMatchObject({campaignId:id,joined:true,activeExerciseId:m0});
 expect(joined.body.view.membership.viewer).toEqual({subject:other,role:'participant',status:'active',canManage:false});
 expect(f.service.store.session('s2').activeId).toBe(m0);expect(f.service.teams.includes(f.service.store.exercise(m0)!,other)).toBe(true);
 expect((await json(f.call('POST','/api/campaigns/join','s2',{code:code.body.code}))).body.joined).toBe(false);
 // Member reads succeed; owner controls are refused with 403 (not 404) because the member legitimately knows the campaign.
 expect((await f.call('GET',`/api/campaigns/${id}`,'s2')).status).toBe(200);
 expect((await (await f.call('GET','/api/campaigns','s2')).json()).campaigns.map((c:any)=>[c.id,c.role])).toEqual([[id,'participant']]);
 for(const action of ['pause','stop','resume','code','limit','revoke','reinstate']){
  const body=action==='limit'?{maxParticipants:2}:['revoke','reinstate'].includes(action)?{subject:'sub-owner'}:undefined;
  expect([action,(await f.call('POST',`/api/campaigns/${id}/${action}`,'s2',body)).status]).toEqual([action,action==='pause'||action==='stop'||action==='resume'?404:403]);
 }
 expect((await f.call('GET',`/api/campaigns/${id}`,'s3')).status).toBe(404);
 // Limit applies to the next joiner; the owner sees the widened roster.
 const limited=await json(f.call('POST',`/api/campaigns/${id}/limit`,'s1',{maxParticipants:1}));expect(limited.status).toBe(200);expect(limited.body.membership.maxParticipants).toBe(1);
 expect((await json(f.call('POST','/api/campaigns/join','s3',{code:code.body.code}))).body.error).toMatch(/already has 1 participants/);
 expect((await f.call('POST',`/api/campaigns/${id}/limit`,'s1',{maxParticipants:16})).status).toBe(400);
 // Revoke: seat deactivated, read access gone, rejoin refused until the owner lifts it; then rejoin is the member's own act.
 expect((await f.call('POST',`/api/campaigns/${id}/revoke`,'s1',{subject:'nobody'})).status).toBe(404);
 const revoked=await json(f.call('POST',`/api/campaigns/${id}/revoke`,'s1',{subject:other}));expect(revoked.status).toBe(200);
 expect(revoked.body.membership.members.find((m:any)=>m.subject===other).status).toBe('revoked');
 expect(f.service.teams.includes(f.service.store.exercise(m0)!,other)).toBe(false);
 expect((await f.call('GET',`/api/campaigns/${id}`,'s2')).status).toBe(404);
 const fresh=await json(f.call('POST',`/api/campaigns/${id}/code`));
 expect((await json(f.call('POST','/api/campaigns/join','s2',{code:code.body.code}))).status).toBe(404);
 expect((await json(f.call('POST','/api/campaigns/join','s2',{code:fresh.body.code}))).body.error).toMatch(/reinstatement must be explicit/);
 const lifted=await json(f.call('POST',`/api/campaigns/${id}/reinstate`,'s1',{subject:other}));expect(lifted.status).toBe(200);expect(lifted.body.rejoinRequired).toBe(true);
 expect(lifted.body.membership.members.find((m:any)=>m.subject===other)).toMatchObject({status:'withdrawn',rejoinRequired:true});
 expect(f.service.teams.includes(f.service.store.exercise(m0)!,other)).toBe(false);
 expect((await json(f.call('POST','/api/campaigns/join','s2',{code:fresh.body.code}))).body.joined).toBe(true);
 expect(f.service.teams.includes(f.service.store.exercise(m0)!,other)).toBe(true);
 // Self-withdrawal needs no owner and no write permission; afterwards the campaign is not acknowledged to them.
 expect(await (await f.call('POST',`/api/campaigns/${id}/withdraw`,'s2')).json()).toEqual({withdrawn:true,campaignId:id});
 expect(f.service.teams.includes(f.service.store.exercise(m0)!,other)).toBe(false);
 expect((await f.call('GET',`/api/campaigns/${id}`,'s2')).status).toBe(404);
 expect((await f.call('POST',`/api/campaigns/${id}/withdraw`,'s2')).status).toBe(404);
 expect(f.service.store.events(m0).filter(e=>['participant_joined','campaign_participant_revoked','campaign_participant_withdrawn'].includes(e.kind)).map(e=>e.kind)).toEqual(['participant_joined','campaign_participant_revoked','participant_joined','campaign_participant_withdrawn']);
 // A stopped campaign issues no invites; the owner still reads the detached-mission projection.
 await f.call('POST',`/api/campaigns/${id}/stop`);
 expect((await f.call('POST',`/api/campaigns/${id}/code`)).status).toBe(409);
 const after=await json(f.call('GET',`/api/campaigns/${id}`));expect(after.body.membership.detached).toMatchObject({exerciseId:m0});
 expect(f.campaigns.members.repo.history(id).map(h=>h.kind)).toEqual(['created','mission-enrolled','enrolled','limit-changed','revoked','revocation-lifted','rejoined','withdrawn']);
},30000);
