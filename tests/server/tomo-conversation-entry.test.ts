import {afterEach,describe,it,expect,vi} from 'vitest';import express from 'express';import type {Server} from 'node:http';
import {createTomoEntry,TOMO_PREFIX} from '../../src/server/tomo-entry';import {NativeSessionError} from '../../src/server/native-session';import type {NativeSessionPort} from '../../src/server/native-http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createTomoBindingRegistry,TOMO_BINDINGS_FILE,TOMO_BINDINGS_SCHEMA} from '../../src/server/tomo-pilot-bindings';
const ID='00000000-0000-4000-8000-000000000001',MODEL='00000000-0000-4000-8000-000000000002',INPUT='00000000-0000-4000-8000-000000000003';
const servers:Server[]=[];afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));});
async function setup(streamAuthorityIntervalMs?:number,bindings?:any){
 const receipt={requestId:'native-request'};
 const invoke=vi.fn(async(_spec:any)=>({status:202,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify({id:ID,input_id:INPUT})),receipt}));
 const cancel=vi.fn();let streamController!:ReadableStreamDefaultController<Uint8Array>;
 const events=vi.fn(async(_spec:any)=>({status:200,contentType:'text/event-stream',body:new ReadableStream<Uint8Array>({start(c){streamController=c;},cancel}),cancel,receipt}));
 const resolve=vi.fn(async(_id:string,_opts?:unknown)=>({identity:{subject:'member'},context:{workroomId:'room'},platformClient:{runtimeInvoke:invoke,runtimeEvents:events}}));const onDispatch=vi.fn();
 const app=express();app.use(TOMO_PREFIX,createTomoEntry({native:{resolve} as unknown as NativeSessionPort,frontendOrigin:'http://frontend',apiOrigin:'http://tomo',conversation:{modelId:MODEL,toolNames:['read_state'],subjects:['member'],onDispatch,streamAuthorityIntervalMs,bindings}}));
 const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);const origin=`http://127.0.0.1:${(server.address() as any).port}`,base=origin+TOMO_PREFIX;
 const post=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{origin,cookie:'replay_session='+ID,'idempotency-key':'stable-input-key','content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {post,base,origin,resolve,invoke,events,cancel,onDispatch,push:(s:string)=>streamController.enqueue(new TextEncoder().encode(s))};
}
const COMPACT='54edeaaf04645a89a71bd1703715b9f9';
describe('Bounded Tomo durable conversation entry',()=>{
 it('preserves room/input idempotency and selects the actual registered capped model',async()=>{
  const h=await setup();expect((await h.post('/api/conversations')).status).toBe(202);expect(h.invoke.mock.calls[0][0]).toMatchObject({path:'/api/conversations',idempotencyKey:'stable-input-key',subject:'member'});
  const r=await h.post(`/api/conversations/${ID}/inputs`,{kind:'message',message:'Read tick 5.'});expect(r.status).toBe(202);
  expect(h.invoke.mock.calls[1][0].body).toEqual({kind:'message',message:'Read tick 5.',model:MODEL,agent:'default',platform_tool_names:['read_state'],connector_ids:[],subagent_ids:[],resource_reference_ids:[],effort:'low'});
  expect(h.onDispatch).toHaveBeenCalledWith(expect.objectContaining({conversationId:ID,inputId:INPUT,subject:'member',status:202}));
  expect(h.resolve.mock.calls.every(c=>(c[1] as any).requireAgents===true)).toBe(true);
 });
 it('dispatches native compact room IDs and preserves them in audit receipts',async()=>{
  const h=await setup();h.invoke.mockResolvedValueOnce({status:201,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify({id:COMPACT})),receipt:{requestId:'native-request'}});
  expect((await h.post('/api/conversations')).status).toBe(201);
  expect(h.onDispatch).toHaveBeenCalledWith(expect.objectContaining({conversationId:COMPACT}));
  expect((await h.post(`/api/conversations/${COMPACT}/inputs`,{kind:'message',message:'Read tick 5.'})).status).toBe(202);
  expect(h.invoke.mock.calls[1][0].path).toBe(`/api/conversations/${COMPACT}/inputs`);
 });
 it.each<Record<string,string>>([{origin:'https://evil.invalid'},{origin:'not-url'},{origin:''},{'idempotency-key':''},{cookie:''}])('denies invalid request authority before dispatch: %j',async headers=>{
  const h=await setup();const r=await h.post('/api/conversations',undefined,headers);expect([400,401,403]).toContain(r.status);expect(h.invoke).not.toHaveBeenCalled();
 });
 it.each([{model:ID},{agent:'arbitrary'},{subagent_ids:['other']},{platform_tool_names:['write_order']},{resource_reference_ids:['upload']},{approval_mode:'never_ask',approval_risk_acknowledged:true}])('refuses model/capability expansion: %j',async override=>{
  const h=await setup();const r=await h.post(`/api/conversations/${ID}/inputs`,{kind:'message',message:'Hello',...override});expect([400,403]).toContain(r.status);expect(h.invoke).not.toHaveBeenCalled();
 });
 it('preserves an explicit no-tools request and accepts a separate cancel control',async()=>{
  const h=await setup();expect((await h.post(`/api/conversations/${ID}/inputs`,{kind:'message',message:'Hello',platform_tool_names:[]})).status).toBe(202);expect(h.invoke.mock.calls[0][0].body.platform_tool_names).toEqual([]);
  expect((await h.post(`/api/conversations/${ID}/inputs`,{kind:'cancel'})).status).toBe(202);expect(h.invoke.mock.calls[1][0].body).toEqual({kind:'cancel'});
 });
 it('checks fresh native authority after body parsing and retains actual accepted receipt after later revocation',async()=>{
  const h=await setup();const normal=await h.resolve(ID);h.resolve.mockClear();h.resolve.mockResolvedValueOnce(normal).mockResolvedValueOnce(normal).mockRejectedValueOnce(new NativeSessionError('access_blocked',403,'revoked'));
  const r=await h.post('/api/conversations');expect(r.status).toBe(403);expect(h.invoke).toHaveBeenCalledOnce();expect(h.onDispatch).toHaveBeenCalledOnce();expect(await r.text()).not.toContain(INPUT);
 });
 it('blocks all unrelated Tomo mutations',async()=>{const h=await setup();expect((await h.post('/api/agents',{name:'other'})).status).toBe(403);expect(h.invoke).not.toHaveBeenCalled();});
 it.each([ID,COMPACT])('streams room %s before EOF and withholds new data on revocation',async(roomId)=>{
  const h=await setup();const controller=new AbortController();const r=await fetch(h.base+`/api/conversations/${roomId}/events`,{headers:{cookie:'replay_session='+ID,'last-event-id':'17'},signal:controller.signal});expect(r.status).toBe(200);expect(h.events.mock.calls[0][0].path).toBe(`/api/conversations/${roomId}/events?after=17`);
  const reader=r.body!.getReader();h.push('id: 18\ndata: visible\n\n');const first=await reader.read();expect(new TextDecoder().decode(first.value)).toContain('visible');
  h.resolve.mockRejectedValue(new NativeSessionError('access_blocked',403,'revoked'));h.push('id: 19\ndata: private-later\n\n');expect((await reader.read()).done).toBe(true);expect(h.cancel).toHaveBeenCalled();controller.abort();
 });
 it('refuses conflicting reconnect cursors without opening a stream',async()=>{
  const h=await setup();const r=await fetch(h.base+`/api/conversations/${ID}/events?after=17`,{headers:{cookie:'replay_session='+ID,'last-event-id':'18'}});expect(r.status).toBe(400);expect(h.events).not.toHaveBeenCalled();
 });
});
const COMMANDER_SESSION='00000000-0000-4000-8000-0000000000a0',INTEL_SESSION='00000000-0000-4000-8000-0000000000b0',OUTSIDER_SESSION='00000000-0000-4000-8000-0000000000d0';
const COMMANDER_AGENT='00000000-0000-4000-8000-0000000000a1',INTEL_AGENT='00000000-0000-4000-8000-0000000000b2',LEGACY_AGENT='00000000-0000-4000-8000-0000000000c3';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
async function registrySetup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tomo-entry-bindings-'));dirs.push(dir);const file=path.join(dir,TOMO_BINDINGS_FILE);fs.mkdirSync(path.dirname(file));
 const write=(bindings:unknown[],workroomId='room-0001')=>{fs.writeFileSync(file+'.tmp',JSON.stringify({schema:TOMO_BINDINGS_SCHEMA,workroomId,bindings}),{mode:0o600});fs.renameSync(file+'.tmp',file);};
 const bindings=createTomoBindingRegistry({file,workroomId:'room-0001',legacy:{subjects:['commander'],agentId:LEGACY_AGENT}});
 const invoke=vi.fn(async(_spec:any)=>({status:202,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify({id:ID,input_id:INPUT})),receipt:{requestId:'native-request'}}));
 const subjects:Record<string,string>={[COMMANDER_SESSION]:'commander',[INTEL_SESSION]:'intelligence',[OUTSIDER_SESSION]:'outsider'};
 const authority={canEdit:true,canRunAgents:true};
 const resolve=vi.fn(async(id:string,opts?:{requireWrite?:boolean;requireAgents?:boolean})=>{
  if(opts?.requireWrite&&!authority.canEdit)throw new NativeSessionError('read_only',403,'no edit');
  if(opts?.requireAgents&&!authority.canRunAgents)throw new NativeSessionError('agents_blocked',403,'no agents');
  return {identity:{subject:subjects[id]},context:{workroomId:'room-0001'},platformClient:{runtimeInvoke:invoke}};
 });
 const app=express();app.use(TOMO_PREFIX,createTomoEntry({native:{resolve} as unknown as NativeSessionPort,frontendOrigin:'http://frontend',apiOrigin:'http://tomo',conversation:{modelId:MODEL,agentId:LEGACY_AGENT,toolNames:['read_state'],subjects:['commander'],bindings}}));
 const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const send=(session:string,agent:string)=>fetch(origin+TOMO_PREFIX+`/api/conversations/${ID}/inputs`,{method:'POST',headers:{origin,cookie:'replay_session='+session,'idempotency-key':'stable-input-key','content-type':'application/json'},body:JSON.stringify({kind:'message',message:'Read tick 5.',agent})});
 return {write,file,invoke,resolve,authority,send};
}
describe('Tomo conversation entry with per-subject helper registry',()=>{
 it('keeps the env single helper when no registry file exists',async()=>{
  const h=await registrySetup();expect((await h.send(COMMANDER_SESSION,LEGACY_AGENT)).status).toBe(202);expect(h.invoke.mock.calls[0][0].body.agent).toBe(LEGACY_AGENT);
  expect((await h.send(INTEL_SESSION,LEGACY_AGENT)).status).toBe(403);expect(h.invoke).toHaveBeenCalledOnce();
 });
 it('forwards only each subject\'s own mapped helper and adds a participant without restart',async()=>{
  const h=await registrySetup();h.write([{subject:'commander',agentId:COMMANDER_AGENT,agentName:'Commander observer'}]);
  expect((await h.send(INTEL_SESSION,INTEL_AGENT)).status).toBe(403);
  expect((await h.send(COMMANDER_SESSION,LEGACY_AGENT)).status).toBe(400);
  h.write([{subject:'commander',agentId:COMMANDER_AGENT,agentName:'Commander observer'},{subject:'intelligence',agentId:INTEL_AGENT,agentName:'Intelligence observer'}]);
  expect((await h.send(INTEL_SESSION,INTEL_AGENT)).status).toBe(202);expect((await h.send(COMMANDER_SESSION,COMMANDER_AGENT)).status).toBe(202);
  expect(h.invoke.mock.calls.map(c=>[c[0].subject,c[0].body.agent])).toEqual([['intelligence',INTEL_AGENT],['commander',COMMANDER_AGENT]]);
 });
 it('refuses a foreign mapped helper submitted by another member',async()=>{
  const h=await registrySetup();h.write([{subject:'commander',agentId:COMMANDER_AGENT,agentName:'Commander observer'},{subject:'intelligence',agentId:INTEL_AGENT,agentName:'Intelligence observer'}]);
  const r=await h.send(INTEL_SESSION,COMMANDER_AGENT);expect(r.status).toBe(400);expect((await r.json()).error.code).toBe('choose_replay_agent');
  expect((await h.send(OUTSIDER_SESSION,INTEL_AGENT)).status).toBe(403);expect(h.invoke).not.toHaveBeenCalled();
 });
 it.each([['empty',[] as unknown[],'room-0001',403],['wrong workroom',[{subject:'commander',agentId:COMMANDER_AGENT,agentName:'Commander observer'}],'room-0002',503],['duplicate',[{subject:'commander',agentId:COMMANDER_AGENT,agentName:'a'},{subject:'commander',agentId:INTEL_AGENT,agentName:'b'}],'room-0001',503]] as const)('denies the env subject for %s registry',async(_label,bindings,room,status)=>{
  const h=await registrySetup();h.write([...bindings],room);expect((await h.send(COMMANDER_SESSION,LEGACY_AGENT)).status).toBe(status);expect((await h.send(COMMANDER_SESSION,COMMANDER_AGENT)).status).toBe(status);expect(h.invoke).not.toHaveBeenCalled();
 });
 it('denies malformed registry text without falling back to env',async()=>{
  const h=await registrySetup();fs.writeFileSync(h.file,'{"schema":',{mode:0o600});const r=await h.send(COMMANDER_SESSION,LEGACY_AGENT);expect(r.status).toBe(503);expect((await r.json()).error.code).toBe('tomo_binding_registry_invalid');expect(h.invoke).not.toHaveBeenCalled();
 });
 it('keeps native edit and agent authority required for a mapped subject',async()=>{
  const h=await registrySetup();h.write([{subject:'intelligence',agentId:INTEL_AGENT,agentName:'Intelligence observer'}]);
  h.authority.canEdit=false;expect((await h.send(INTEL_SESSION,INTEL_AGENT)).status).toBe(403);
  h.authority.canEdit=true;h.authority.canRunAgents=false;expect((await h.send(INTEL_SESSION,INTEL_AGENT)).status).toBe(403);expect(h.invoke).not.toHaveBeenCalled();
 });
 it('refuses dispatch when the binding is revoked mid-operation',async()=>{
  const h=await registrySetup();h.write([{subject:'intelligence',agentId:INTEL_AGENT,agentName:'Intelligence observer'}]);
  let calls=0;const base=h.resolve.getMockImplementation()!;
  h.resolve.mockImplementation(async(id,opts)=>{if(++calls===2)h.write([{subject:'intelligence',agentId:COMMANDER_AGENT,agentName:'Swapped helper'}]);return base(id,opts);});
  const r=await h.send(INTEL_SESSION,INTEL_AGENT);expect(r.status).toBe(403);expect((await r.json()).error.code).toBe('tomo_binding_changed');expect(h.invoke).not.toHaveBeenCalled();
 });
});

it('closes an idle conversation stream after binding revocation without another frame',async()=>{
 let bound:any={source:'registry',state:'bound',binding:{subject:'member',agentId:ID,agentName:'Test helper'}};
 const h=await setup(10,{resolve:async()=>bound});
 const r=await fetch(h.base+`/api/conversations/${ID}/events`,{headers:{cookie:'replay_session='+ID}});expect(r.status).toBe(200);
 bound={source:'registry',state:'unbound',binding:null};
 await vi.waitFor(()=>expect(h.cancel).toHaveBeenCalled(),{timeout:1000});expect(await r.text()).toBe('');
});
