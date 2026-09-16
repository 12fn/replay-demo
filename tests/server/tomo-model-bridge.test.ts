import {afterEach,describe,expect,it,vi} from 'vitest';
import express from 'express';
import type {Server} from 'node:http';
import {createTomoModelBridge,TOMO_MODEL_PURPOSE} from '../../src/server/tomo-model-bridge';
import {McpAuthError,type McpAuthPort} from '../../src/server/mcp-auth';
import {InferenceError} from '../../src/inference/errors';
import {BudgetLedger,type Receipt} from '../../src/inference/ledger';
import {LunaChatClient} from '../../src/inference/luna-chat-client';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));});
const principal=()=>({identity:{subject:'member'},context:{workroomId:'room',fresh:true,canRunAgents:true,accessState:'active'},nativeReceipts:[{requestId:'core-native-id'}]});
const receipt={id:'receipt-one',purpose:TOMO_MODEL_PURPOSE} as Receipt;
const completion={id:'chat-1',object:'chat.completion',created:1,model:'gpt-5.6-luna',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'read_state',arguments:'{"tick":5}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
async function setup(){
 const resolve=vi.fn(async(_headers:unknown)=>principal());const complete=vi.fn(async(_r:unknown)=>({completion,receipt}));const onAudit=vi.fn();let rows:Receipt[]=[];
 const app=express();app.use('/v1',createTomoModelBridge({auth:{workroomId:'room',resolve} as unknown as McpAuthPort,luna:{complete} as any,ledger:{listReceipts:()=>rows},subjects:['member'],toolNames:['read_state'],exposedModel:'replay-tomo-luna',maxRequests:2,onAudit}));
 const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);
 const url=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const post=(b:unknown)=>fetch(url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer synthetic','x-workroom-id':'room'},body:JSON.stringify(b)});
 return {resolve,complete,onAudit,post,url,setRows:(r:Receipt[])=>{rows=r;}};
}
const body=(overrides:Record<string,unknown>={})=>({model:'replay-tomo-luna',messages:[{role:'user',content:'Read the exercise.'}],tools:[{type:'function',function:{name:'read_state',parameters:{type:'object',properties:{tick:{type:'integer'}}}}}],...overrides});
describe('Tomo metered member model facade',()=>{
 it('preserves structured calls in buffered SSE, settles before display and joins native receipts',async()=>{
  const h=await setup();const r=await h.post(body({stream:true,max_completion_tokens:32768,stream_options:{include_usage:true}}));
  expect(r.status).toBe(200);expect(r.headers.get('x-replay-delivery')).toBe('buffered-completion');expect(r.headers.get('x-replay-receipt-id')).toBe(receipt.id);
  const raw=await r.text();const frames=raw.split('\n\n').filter(Boolean);expect(frames.at(-1)).toBe('data: [DONE]');
  const first=JSON.parse(frames[0].slice(6));expect(first.model).toBe('replay-tomo-luna');expect(first.choices[0].delta.tool_calls[0]).toMatchObject({index:0,id:'call_1',function:{name:'read_state',arguments:'{"tick":5}'}});
  expect(h.complete).toHaveBeenCalledOnce();expect(h.complete.mock.calls[0][0]).toMatchObject({purpose:TOMO_MODEL_PURPOSE,maxOutputTokens:1600,context:{subject:'member',workroomId:'room'}});
  expect(h.resolve).toHaveBeenCalledTimes(3);expect(h.onAudit).toHaveBeenCalledWith(expect.objectContaining({outcome:'completed',receiptId:receipt.id,nativeRequestIds:['core-native-id','core-native-id','core-native-id']}));
  expect(JSON.stringify(h.onAudit.mock.calls)).not.toContain('Read the exercise');
 });
 it('does not parse an unauthenticated request body or call inference',async()=>{
  const h=await setup();h.resolve.mockRejectedValue(new McpAuthError('missing_bearer',401,'required'));
  const r=await fetch(h.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:'not json'});expect(r.status).toBe(401);expect(h.complete).not.toHaveBeenCalled();
 });
 it('denies an unlisted member and denied current agent authority',async()=>{
  const h=await setup();h.resolve.mockResolvedValue({...principal(),identity:{subject:'other'}});expect((await h.post(body())).status).toBe(403);
  h.resolve.mockResolvedValue({...principal(),context:{...principal().context,canRunAgents:false}});expect((await h.post(body())).status).toBe(403);expect(h.complete).not.toHaveBeenCalled();
 });
 it('rechecks after body parsing and denies changed identity before inference',async()=>{
  const h=await setup();h.resolve.mockResolvedValueOnce(principal()).mockRejectedValueOnce(new McpAuthError('access_blocked',403,'revoked'));expect((await h.post(body())).status).toBe(403);expect(h.complete).not.toHaveBeenCalled();
 });
 it('withholds paid output when native membership is revoked in flight',async()=>{
  const h=await setup();h.resolve.mockResolvedValueOnce(principal()).mockResolvedValueOnce(principal()).mockRejectedValueOnce(new McpAuthError('access_blocked',403,'revoked'));
  const r=await h.post(body());expect(r.status).toBe(403);expect(await r.text()).not.toContain('call_1');expect(h.complete).toHaveBeenCalledOnce();expect(h.onAudit).toHaveBeenCalledWith(expect.objectContaining({outcome:'failed',receiptId:receipt.id,code:'access_blocked'}));
 });
 it.each([
  {model:'other'},{tools:[{type:'function',function:{name:'write_orders'}}]},
  {messages:[{role:'assistant',tool_calls:[{id:'bad',type:'function',function:{name:'write_orders',arguments:'{}'}}]}]},
  {max_tokens:4,max_completion_tokens:5},{max_completion_tokens:-1},{store:true},{n:2},{stream:'true'},{response_format:{}},{stream_options:{unexpected:true}},
 ])('rejects unsupported routing/options/tools before model I/O: %j',async overrides=>{
  const h=await setup();expect([400,403]).toContain((await h.post(body(overrides))).status);expect(h.complete).not.toHaveBeenCalled();
 });
 it('counts durable earlier attempts across router reconstruction',async()=>{
  const h=await setup();h.setRows([receipt,{...receipt,id:'receipt-two'}]);expect((await h.post(body())).status).toBe(429);expect(h.complete).not.toHaveBeenCalled();
 });
 it('allows only one in-flight provider request without silently queueing',async()=>{
  const h=await setup();let release!:(r:any)=>void,entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});h.complete.mockImplementation(()=>{entered();return new Promise(r=>{release=r;});});
  const first=h.post(body());await began;expect((await h.post(body())).status).toBe(429);release({completion,receipt});expect((await first).status).toBe(200);expect(h.complete).toHaveBeenCalledOnce();
 });
 it('keeps a failed adapter receipt and does not retry or disclose diagnostics',async()=>{
  const h=await setup();h.complete.mockRejectedValue(new InferenceError('timeout','private input body',{receiptId:receipt.id}));const r=await h.post(body());expect(r.status).toBe(502);expect(await r.text()).not.toContain('private');expect(h.complete).toHaveBeenCalledOnce();expect(h.onAudit).toHaveBeenCalledWith(expect.objectContaining({receiptId:receipt.id,code:'timeout'}));
 });
 it('exposes only the configured model to an authorized caller without inference',async()=>{
  const h=await setup();const r=await fetch(h.url+'/models');expect(r.status).toBe(200);expect((await r.json()).data.map((x:any)=>x.id)).toEqual(['replay-tomo-luna']);expect(h.complete).not.toHaveBeenCalled();
 });
 it('returns safe body errors with no inference',async()=>{
  const h=await setup();const r=await fetch(h.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:'private malformed body'});expect(r.status).toBe(400);expect(await r.text()).not.toContain('private');expect(h.complete).not.toHaveBeenCalled();
 });
});


describe('Tomo facade with real bounded adapter and persistent ledger (offline provider)',()=>{
 it('carries one structured tool exchange and enforces the project cap before the third provider attempt',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-tomo-bridge-'));
  const ledger=new BudgetLedger({path:path.join(dir,'ledger.sqlite'),maxRequests:2,maxUsd:5});
  try{
   const fetchProvider=vi.fn(async(_url:string,init:RequestInit)=>{
    const b=JSON.parse(String(init.body));
    if(b.messages.at(-1).role==='tool')return Response.json({...completion,id:'chat-2',choices:[{index:0,message:{role:'assistant',content:'The recorded tick is 5.'},finish_reason:'stop'}]});
    return Response.json(completion);
   });
   const luna=new LunaChatClient({apiKey:'offline-fixture-key-only',ledger,fetchImpl:fetchProvider});
   const app=express();app.use('/v1',createTomoModelBridge({auth:{workroomId:'room',resolve:async()=>principal()} as unknown as McpAuthPort,luna,ledger,subjects:['member'],toolNames:['read_state'],exposedModel:'replay-tomo-luna'}));
   const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);
   const url=`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`;
   const post=(b:unknown)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
   const first=await post(body());expect(first.status).toBe(200);const selected=await first.json();
   const continued=body({messages:[...body().messages,selected.choices[0].message,{role:'tool',tool_call_id:'call_1',content:'{"tick":5}'}]});
   const second=await post(continued);expect(second.status).toBe(200);expect((await second.json()).choices[0].message.content).toBe('The recorded tick is 5.');
   expect((await post(continued)).status).toBe(409);
   expect((await post(body({messages:[{role:'user',content:'A new request after project cap'}]}))).status).toBe(429);expect(fetchProvider).toHaveBeenCalledTimes(2);
   const rows=ledger.listReceipts();expect(rows).toHaveLength(2);expect(rows.every(r=>r.purpose===TOMO_MODEL_PURPOSE&&r.status==='completed'&&r.settledMicro!==null)).toBe(true);
   expect(fetchProvider.mock.calls[1][1].body).toContain('"tool_call_id":"call_1"');
  }finally{ledger.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
});

describe('Native Core delegated provider authority',()=>{
 it('accepts only the dedicated credential and records service attribution despite spoofed member headers',async()=>{
  const secret='offline-serving-credential-with-at-least-32-characters';const onAudit=vi.fn();const complete=vi.fn(async(_r:unknown)=>({completion,receipt}));
  const app=express();app.use('/v1',createTomoModelBridge({workload:{secret,subject:'native-core-serving',workroomId:'room'},luna:{complete} as any,ledger:{listReceipts:()=>[]},toolNames:['read_state'],exposedModel:'replay-tomo-luna',onAudit}));
  const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);const url=`http://127.0.0.1:${(server.address() as any).port}/v1`;
  for(const authorization of ['', 'Bearer member-token', 'Bearer '+secret+'x']){
   const r=await fetch(url+'/chat/completions',{method:'POST',headers:{authorization,'content-type':'application/json'},body:'unparseable'});expect(r.status).toBe(401);
  }
  expect(complete).not.toHaveBeenCalled();
  const r=await fetch(url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json','x-user-id':'invented-member'},body:JSON.stringify(body())});
  expect(r.status).toBe(200);expect((await r.json()).id).toBe('chatcmpl-replay-'+receipt.id);
  expect(onAudit).toHaveBeenCalledWith(expect.objectContaining({subject:'native-core-serving',authority:'native-serving-workload',nativeRequestIds:[]}));
  expect(JSON.stringify(onAudit.mock.calls)).not.toContain(secret);expect(JSON.stringify(onAudit.mock.calls)).not.toContain('invented-member');
  expect(complete.mock.calls[0][0]).toMatchObject({context:{authority:'native-serving-workload',subject:'native-core-serving'}});
 });
 it('requires exactly one authority mode and a dedicated strong credential',()=>{
  const base={luna:{complete:vi.fn()},ledger:{listReceipts:()=>[]},toolNames:[],exposedModel:'replay-tomo-luna'};
  expect(()=>createTomoModelBridge(base)).toThrow('Exactly one');
  expect(()=>createTomoModelBridge({...base,workload:{secret:'short',subject:'serving',workroomId:'room'}})).toThrow('Dedicated');
 });
});


describe('Provider rejection and retry suppression',()=>{
 it.each([400,401,403,404,409,422,429])('preserves a definitive provider HTTP%s instead of turning it into retryable502',async status=>{
  const h=await setup();h.complete.mockRejectedValueOnce(new InferenceError('provider_error','safe',{httpStatus:status,receiptId:'rejected',chatDiagnostics:{errorType:'invalid_request_error',parameter:'tools',messageClass:'invalid_tool_schema'}}));
  const r=await h.post(body());expect(r.status).toBe(status);expect(r.headers.get('x-should-retry')).toBe('false');expect(h.complete).toHaveBeenCalledOnce();expect(h.onAudit).toHaveBeenCalledWith(expect.objectContaining({providerHttpStatus:status,providerDiagnostics:{errorType:'invalid_request_error',parameter:'tools',messageClass:'invalid_tool_schema'}}));
 });
 it('refuses identical streamed/nonstream retries across facade restart without another reservation',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-tomo-retry-')),ledgerPath=path.join(dir,'ledger.sqlite');let ledger=new BudgetLedger({path:ledgerPath,maxRequests:100,maxUsd:5});
  const provider=vi.fn(async()=>Response.json({error:{type:'invalid_request_error',param:'tools[0].function.parameters',message:'Invalid schema for function secret_name'}},{status:400}));
  const serve=async()=>{const app=express();app.use('/v1',createTomoModelBridge({auth:{workroomId:'room',resolve:async()=>principal()} as unknown as McpAuthPort,luna:new LunaChatClient({apiKey:'offline-fixture-key-only',ledger,fetchImpl:provider}),ledger,subjects:['member'],toolNames:['read_state'],exposedModel:'replay-tomo-luna'}));const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);return (b:unknown)=>fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});};
  try{const post=await serve();expect((await post(body({stream:true,stream_options:{include_usage:true}}))).status).toBe(400);expect(ledger.listReceipts()).toHaveLength(1);expect(ledger.listReceipts()[0].status).toBe('failed');
   for(let i=0;i<3;i++)expect((await post(body({stream:false}))).status).toBe(409);
   ledger.close();ledger=new BudgetLedger({path:ledgerPath,maxRequests:100,maxUsd:5});const restarted=await serve();expect((await restarted(body({stream:true}))).status).toBe(409);expect(provider).toHaveBeenCalledOnce();expect(ledger.summary().requestsUsed).toBe(1);expect(ledger.summary().committedMicro).toBe(0);
   expect(JSON.stringify(ledger.listReceipts())).not.toContain('secret_name');expect(ledger.listReceipts()[0].context?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  }finally{ledger.close();fs.rmSync(dir,{recursive:true,force:true});}
 });
});
