import {afterEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {GameService} from '../../src/server/service';
import {createApp} from '../../src/server/native-http';
import {CampaignService} from '../../src/server/campaign-service';
import {mountCampaignRoutes} from '../../src/server/campaign-routes';
console.debug=()=>{};
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function harness(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-navigation-'));
 cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const service=new GameService(dir);cleanup.push(()=>service.close());await service.init(false);
 const campaigns=new CampaignService(service);
 const app=createApp({service,mountAuthorized:app=>mountCampaignRoutes(app,campaigns,null),config:{mode:'local-demo',allowedOrigins:[],cookieSecure:false},native:null,root:process.cwd()});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cleanup.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;let cookie='';
 async function request(route:string,body?:unknown){
  const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{cookie,'Content-Type':'application/json',origin:base},...(body===undefined?{}:{body:JSON.stringify(body)})});
  cookie=res.headers.get('set-cookie')?.split(';')[0]??cookie;
  return{status:res.status,body:await res.json() as any};
 }
 const initial=(await request('/api/overview')).body;
 const next=await service.create('second','plains');
 return{service,request,initial,next};
}
describe('navigation under slow historical reconstruction',()=>{
 it('creates a requested campaign without replacing navigation that changed while its world was preparing',async()=>{
  const h=await harness(),entered=deferred(),release=deferred();
  const original=h.service.create.bind(h.service);
  h.service.create=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const creating=h.request('/api/campaigns',{name:'Navigation race'});await entered.promise;
  await h.request('/api/select',{exerciseId:h.next.id});
  await h.request('/api/select',{exerciseId:h.initial.activeId});
  await h.request('/api/replay',{tick:1,exerciseId:h.initial.activeId});
  release.resolve();const response=await creating;
  expect(response.status).toBe(201);expect(response.body.navigationSelected).toBe(false);
  expect(response.body.activeExerciseId).not.toBe(h.initial.activeId);
  expect((await h.request('/api/overview')).body).toMatchObject({activeId:h.initial.activeId,playbackTick:1,navigationRevision:3});
 });
 it('does not let a delayed seek overwrite a newer exercise selection',async()=>{
  const h=await harness(),entered=deferred(),release=deferred();
  const original=h.service.historical.bind(h.service);
  h.service.historical=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const seek=h.request('/api/replay',{tick:1,exerciseId:h.initial.activeId});await entered.promise;
  expect((await h.request('/api/select',{exerciseId:h.next.id})).status).toBe(200);
  release.resolve();expect((await seek).status).toBe(409);
  expect((await h.request('/api/overview')).body).toMatchObject({activeId:h.next.id,playbackTick:null});
 });
 it('rejects a delayed seek even after a user leaves and returns to the same live exercise',async()=>{
  const h=await harness(),entered=deferred(),release=deferred();
  const original=h.service.historical.bind(h.service);
  h.service.historical=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const seek=h.request('/api/replay',{tick:1});await entered.promise;
  await h.request('/api/select',{exerciseId:h.next.id});await h.request('/api/select',{exerciseId:h.initial.activeId});
  release.resolve();expect((await seek).status).toBe(409);
  expect((await h.request('/api/overview')).body).toMatchObject({activeId:h.initial.activeId,playbackTick:null,navigationRevision:2});
 });
 it('refuses an automatic selection based on the live view after the user freezes review',async()=>{
  const h=await harness();
  const expected={activeId:h.initial.activeId,playbackTick:null,revision:h.initial.navigationRevision};
  expect((await h.request('/api/replay',{tick:1,exerciseId:h.initial.activeId})).status).toBe(200);
  expect((await h.request('/api/select',{exerciseId:h.next.id,expected})).status).toBe(409);
  expect((await h.request('/api/overview')).body).toMatchObject({activeId:h.initial.activeId,playbackTick:1});
  const ov=(await h.request('/api/overview')).body;
  expect((await h.request('/api/select',{exerciseId:h.next.id,expected:{activeId:ov.activeId,playbackTick:ov.playbackTick,revision:ov.navigationRevision}})).status).toBe(200);
 });
 it('binds a seek to its explicit exercise and preserves existing clients without preconditions',async()=>{
  const h=await harness();
  expect((await h.request('/api/replay',{tick:1,exerciseId:h.next.id})).status).toBe(409);
  expect((await h.request('/api/replay',{tick:1})).status).toBe(200);
  expect((await h.request('/api/select',{exerciseId:h.next.id})).status).toBe(200);
  expect((await h.request('/api/overview')).body).toMatchObject({activeId:h.next.id,playbackTick:null});
 });
});
