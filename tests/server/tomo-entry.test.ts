import {afterEach,describe,it,expect,vi} from 'vitest';
import express from 'express';
import type {Server} from 'node:http';
import {createTomoEntry,TOMO_PREFIX} from '../../src/server/tomo-entry';
import {NativeSessionError} from '../../src/server/native-session';
import type {NativeSessionPort} from '../../src/server/native-http';
const cookie='replay_session=00000000-0000-4000-8000-000000000001';
const servers:Server[]=[];afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(r=>s.close(()=>r()))));});
async function setup(){
 const read=vi.fn(async(spec:any)=>({status:200,body:new TextEncoder().encode(spec.path),contentType:'text/plain',identity:{userId:'member'},receipt:{}}));
 const resolve=vi.fn(async()=>({identity:{subject:'member'},context:{workroomId:'workroom'},platformClient:{runtimeRead:read}}));
 const app=express();app.use(TOMO_PREFIX,createTomoEntry({native:{resolve} as unknown as NativeSessionPort,frontendOrigin:'http://frontend:8080',apiOrigin:'http://backend:8000'}));
 const server=await new Promise<Server>(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});servers.push(server);
 const base=`http://127.0.0.1:${(server.address() as any).port}${TOMO_PREFIX}`;
 return {read,resolve,get:(path:string,init:RequestInit={})=>fetch(base+path,{...init,headers:{cookie,...init.headers}})};
}
describe('Tomo browser entry',()=>{
 it('uses fresh session identity for native API and discards incoming identity/credentials',async()=>{
  const h=await setup();const r=await h.get('/api/auth/me',{headers:{authorization:'Bearer forged','x-user-id':'admin','x-workroom-id':'other'}});
  expect(r.status).toBe(200);expect(h.read).toHaveBeenCalledWith({extension:'replay-tomo',origin:'http://backend:8000',path:'/api/auth/me',subject:'member'});
  expect(h.resolve).toHaveBeenCalledTimes(2);expect(h.resolve.mock.calls.every((call:any[])=>call[1]?.fresh)).toBe(true);
  expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('set-cookie')).toBeNull();
 });
 it('does not contact the runtime without a unique native cookie',async()=>{
  const h=await setup();const r=await h.get('/',{headers:{cookie:cookie+'; '+cookie}});expect(r.status).toBe(401);expect(h.read).not.toHaveBeenCalled();
 });
 it('blocks editing and model requests before body parsing or upstream calls',async()=>{
  const h=await setup();const r=await h.get('/api/chat',{method:'POST',body:'invalid json'});expect(r.status).toBe(403);expect(h.resolve).not.toHaveBeenCalled();expect(h.read).not.toHaveBeenCalled();
 });
 it('serves SPA fallback for extensionless routes, not missing API resources',async()=>{
  const h=await setup();h.read.mockImplementation(async(spec:any)=>({status:spec.path==='/'?200:404,body:new Uint8Array(),contentType:'text/html',identity:{userId:'member'},receipt:{}}));
  expect((await h.get('/chat/saved-id')).status).toBe(200);expect(h.read.mock.calls.map(c=>c[0].path)).toEqual(['/chat/saved-id','/']);
  h.read.mockClear();expect((await h.get('/api/missing')).status).toBe(404);expect(h.read).toHaveBeenCalledTimes(1);
 });
 it('does not release fetched private data after membership is revoked',async()=>{
  const h=await setup();h.resolve.mockImplementationOnce(async()=>({identity:{subject:'member'},context:{workroomId:'workroom'},platformClient:{runtimeRead:h.read}})).mockRejectedValueOnce(new NativeSessionError('access_blocked',403,'revoked'));
  const r=await h.get('/api/conversations');expect(r.status).toBe(403);expect(await r.text()).not.toContain('/api/conversations');
 });
 it('redacts unexpected upstream failures',async()=>{
  const h=await setup();h.read.mockRejectedValue(new Error('Bearer private-token cookie=private'));const r=await h.get('/api/auth/me');expect(r.status).toBe(502);expect(await r.text()).not.toContain('private');
 });
});
