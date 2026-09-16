import {afterEach,describe,it,expect,vi} from 'vitest';import express from 'express';import type {Server} from 'node:http';
import {createTomoNativeModelRoute} from '../../src/server/tomo-native-model-route';import {McpAuthError} from '../../src/server/mcp-auth';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createTomoBindingRegistry,TOMO_BINDINGS_FILE,TOMO_BINDINGS_SCHEMA} from '../../src/server/tomo-pilot-bindings';
const ID='2d3eb592-0b82-48e9-bc3f-efe896e9158e',SERVE='/64800810-7c73-4cd9-a36c-3106fe48776d',TOKEN='synthetic-bearer-token';const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));});
const principal=()=>({identity:{subject:'member'},context:{workroomId:'room',fresh:true,accessState:'active',canRunAgents:true},nativeReceipts:[{requestId:'member-check'}]});
async function setup(){
 const resolve=vi.fn(async()=>principal()),cancel=vi.fn(),audit=vi.fn();let push!:ReadableStreamDefaultController<Uint8Array>;
 const transport=vi.fn(async(_opts:any)=>({status:200,contentType:'text/event-stream',receipt:{clientRequestId:'route-request',requestId:'native-model-auth',target:{method:'POST',path:`/runtime/models/${ID}/v1/chat/completions`}},body:new ReadableStream<Uint8Array>({start(c){push=c;},cancel}),cancel}));
 const app=express();app.use('/route',createTomoNativeModelRoute({auth:{workroomId:'room',resolve} as any,apiBase:'http://core:7777/api',forwardedHost:'native.local',deploymentId:ID,servePath:SERVE,subjects:['member'],transport:transport as any,onAudit:audit}));
 const s=await new Promise<Server>(r=>{const x=app.listen(0,'127.0.0.1',()=>r(x));});servers.push(s);const base=`http://127.0.0.1:${(s.address() as any).port}/route`;
 const post=(path=`/runtime/models/${ID}/v1/chat/completions`,body:unknown={model:'replay-tomo-luna',messages:[]})=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer '+TOKEN,'x-workroom-id':'room','x-user-id':'forged','content-type':'application/json'},body:JSON.stringify(body)});
 return {resolve,transport,cancel,audit,post,base,push:(v:string)=>push.enqueue(new TextEncoder().encode(v)),end:()=>push.close()};
}
describe('Local native model route',()=>{
 it('uses only the pinned Core deployment and preserves the member bearer without logging it',async()=>{
  const h=await setup();const r=await h.post();expect(r.status).toBe(200);expect(h.transport.mock.calls[0][0]).toMatchObject({apiBase:'http://core:7777/api',deploymentId:ID,servePath:SERVE,subject:'member',token:TOKEN,method:'POST'});
  h.push('data: evidence\n\n');h.end();expect(await r.text()).toContain('evidence');await vi.waitFor(()=>expect(h.audit).toHaveBeenCalled());expect(h.audit.mock.calls[0][0]).toMatchObject({subject:'member',completed:true,nativeReceipt:{requestId:'native-model-auth'},memberRequestIds:['member-check']});expect(JSON.stringify(h.audit.mock.calls)).not.toContain(TOKEN);expect(JSON.stringify(h.audit.mock.calls)).not.toContain('forged');
 });
 it('discards later streamed output after actual membership revocation',async()=>{
  const h=await setup();const r=await h.post(),reader=r.body!.getReader();h.push('data: first\n\n');expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');h.resolve.mockRejectedValue(new McpAuthError('access_blocked',403,'revoked'));h.push('data: hidden\n\n');expect((await reader.read()).done).toBe(true);expect(h.cancel).toHaveBeenCalled();
 });
 it.each(['other-member','no-agent','stale','wrong-room'])('denies %s before native serving',async(reason)=>{
  const h=await setup();const p=principal();if(reason==='other-member')p.identity.subject='other';if(reason==='no-agent')p.context.canRunAgents=false;if(reason==='stale')p.context.fresh=false;if(reason==='wrong-room')p.context.workroomId='elsewhere';h.resolve.mockResolvedValue(p);expect((await h.post()).status).toBe(403);expect(h.transport).not.toHaveBeenCalled();
 });
 it('requires the original native bearer and never trusts forged identity headers',async()=>{const h=await setup();const r=await fetch(h.base+`/runtime/models/${ID}/v1/models`,{headers:{'x-user-id':'member'}});expect(r.status).toBe(401);expect(h.transport).not.toHaveBeenCalled();});
 it.each(['/runtime/models/other/v1/chat/completions',`/runtime/models/${ID}/v1/chat/completions?upstream=evil`,`/runtime/models/${ID}/v1/responses`])('refuses unconfigured target %s',async(path)=>{const h=await setup();expect((await h.post(path)).status).toBe(404);expect(h.transport).not.toHaveBeenCalled();});
 it('denies oversized input before native serving',async()=>{const h=await setup();expect((await h.post(undefined,{message:'x'.repeat(66000)})).status).toBe(413);expect(h.transport).not.toHaveBeenCalled();});
 it('does not expose upstream errors or retry a failed call',async()=>{const h=await setup();h.transport.mockImplementationOnce(async()=>({status:500,contentType:'application/json',receipt:{requestId:'failed'},body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(TOKEN));c.close();}}),cancel:h.cancel}) as any);const r=await h.post();expect(r.status).toBe(502);expect(await r.text()).not.toContain(TOKEN);expect(h.transport).toHaveBeenCalledOnce();expect(h.cancel).toHaveBeenCalled();});
});
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const MEMBER_AGENT='00000000-0000-4000-8000-0000000000a1',OTHER_AGENT='00000000-0000-4000-8000-0000000000b2';
async function registrySetup(streamAuthorityIntervalMs?:number){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tomo-route-bindings-'));dirs.push(dir);const file=path.join(dir,TOMO_BINDINGS_FILE);fs.mkdirSync(path.dirname(file));
 const write=(bindings:unknown[],workroomId='room-0001')=>{fs.writeFileSync(file+'.tmp',JSON.stringify({schema:TOMO_BINDINGS_SCHEMA,workroomId,bindings}),{mode:0o600});fs.renameSync(file+'.tmp',file);};
 const bindings=createTomoBindingRegistry({file,workroomId:'room-0001',legacy:{subjects:['member']}});
 const p=()=>({identity:{subject:'intelligence'},context:{workroomId:'room-0001',fresh:true,accessState:'active',canRunAgents:true},nativeReceipts:[{requestId:'member-check'}]});
 const resolve=vi.fn(async()=>p()),cancel=vi.fn();let push!:ReadableStreamDefaultController<Uint8Array>;
 const transport=vi.fn(async(_opts:any)=>({status:200,contentType:'text/event-stream',receipt:{requestId:'native-model-auth'},body:new ReadableStream<Uint8Array>({start(c){push=c;},cancel}),cancel}));
 const app=express();app.use('/route',createTomoNativeModelRoute({auth:{workroomId:'room-0001',resolve} as any,apiBase:'http://core:7777/api',forwardedHost:'native.local',deploymentId:ID,servePath:SERVE,subjects:['member'],bindings,streamAuthorityIntervalMs,transport:transport as any}));
 const s=await new Promise<Server>(r=>{const x=app.listen(0,'127.0.0.1',()=>r(x));});servers.push(s);
 const post=()=>fetch(`http://127.0.0.1:${(s.address() as any).port}/route/runtime/models/${ID}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},body:JSON.stringify({model:'replay-tomo-luna',messages:[]})});
 return {write,file,resolve,transport,cancel,post,p,push:(v:string)=>push.enqueue(new TextEncoder().encode(v))};
}
describe('Native model route with per-subject helper registry',()=>{
 it('uses the same registry as the conversation entry: unmapped subject denied, mapping added without restart',async()=>{
  const h=await registrySetup();expect((await h.post()).status).toBe(403);
  h.write([{subject:'intelligence',agentId:MEMBER_AGENT,agentName:'Intelligence observer'}]);expect((await h.post()).status).toBe(200);expect(h.transport.mock.calls[0][0]).toMatchObject({subject:'intelligence',token:TOKEN});
 });
 it.each([['malformed',503],['empty',403],['wrong-workroom',503]] as const)('denies before serving for %s registry without env fallback',async(kind,status)=>{
  const h=await registrySetup();h.resolve.mockResolvedValue({...h.p(),identity:{subject:'member'}});
  if(kind==='malformed')fs.writeFileSync(h.file,'[',{mode:0o600});else if(kind==='empty')h.write([]);else h.write([{subject:'member',agentId:MEMBER_AGENT,agentName:'Member observer'}],'room-0002');
  expect((await h.post()).status).toBe(status);expect(h.transport).not.toHaveBeenCalled();
 });
 it('keeps native agent authority required for a mapped subject',async()=>{
  const h=await registrySetup();h.write([{subject:'intelligence',agentId:MEMBER_AGENT,agentName:'Intelligence observer'}]);const p=h.p();p.context.canRunAgents=false;h.resolve.mockResolvedValue(p);
  expect((await h.post()).status).toBe(403);expect(h.transport).not.toHaveBeenCalled();
 });
 it.each([['revoked',[]],['changed',[{subject:'intelligence',agentId:OTHER_AGENT,agentName:'Swapped helper'}]]] as const)('stops streaming when the binding is %s mid-stream',async(_label,next)=>{
  const h=await registrySetup();h.write([{subject:'intelligence',agentId:MEMBER_AGENT,agentName:'Intelligence observer'}]);
  const r=await h.post();expect(r.status).toBe(200);const reader=r.body!.getReader();h.push('data: first\n\n');expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');
  h.write([...next]);h.push('data: hidden\n\n');expect((await reader.read()).done).toBe(true);expect(h.cancel).toHaveBeenCalled();
 });
});

it('cancels an idle model stream after its registry binding is revoked',async()=>{
 const h=await registrySetup(10);h.write([{subject:'intelligence',agentId:MEMBER_AGENT,agentName:'Intelligence observer'}]);
 const r=await h.post();expect(r.status).toBe(200);h.write([]);
 await vi.waitFor(()=>expect(h.cancel).toHaveBeenCalled(),{timeout:1000});expect(await r.text()).toBe('');
});
