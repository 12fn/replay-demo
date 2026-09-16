/** Real commander session through REPLAY's authenticated Tomo browser entry. No inference. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(version);const revision=process.argv[3]??'';assert(/^(?:-[a-z0-9-]+)?$/.test(revision));const artifact=`evidence/platform/tomo-browser-entry-${version}${revision}.json`;assert(!fs.existsSync(artifact));
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));const u=users.find((x:any)=>x.role==='commander');assert(u);
const c=await nativeAppClient(u);for(const x of users)x.password='';const base='/runtime/apps/replay-tomo';
try{
 const build=await(await c.request('/replay-build.json')).json() as any;assert.equal(build.version,version);
 await c.request('/api/overview');const before=(await(await c.request('/api/agents/tools')).json() as any).budget;
 const status=await(await c.request('/api/tomo/status')).json() as any;assert.equal(status.enabled,true);
 const page=await c.request(base+'/');assert.match(page.headers.get('content-type')??'',/text\/html/);const html=await page.text();assert(html.includes('__KAIZEN_APP_BASE_PATH__'));
 const matches=[...html.matchAll(/(?:src|href)="([^" ]*assets\/[^" ]+)"/g)].map(m=>m[1]);assert(matches.length>0);
 const assets=[];for(const src of matches){const path=src.startsWith('./')?src.slice(1):src.startsWith('/')?src:'/'+src;const target=path.startsWith(base+'/')?path:base+path;const r=await c.request(target);const content=await r.arrayBuffer();assert(content.byteLength>0);assert.match(r.headers.get('content-type')??'',/javascript|css/);assets.push({path:target,status:r.status,bytes:content.byteLength,contentType:r.headers.get('content-type')});}
 const me=await(await c.request(base+'/api/auth/me')).json() as any;assert.equal(me.role,'member');
 const catalog=await(await c.request(base+'/api/agents/capability-catalog')).json() as any;const reads=catalog.tools.filter((t:any)=>t.server_id==='replay-tools_replay');assert.equal(reads.length,6);
 const blocked=await c.requestRaw(base+'/api/chat',{message:'Must not be dispatched'});assert.equal(blocked.status,403);
 const anonymous=await fetch('http://127.0.0.1:5183'+base+'/api/auth/me');assert.equal(anonymous.status,401);
 const after=(await(await c.request('/api/agents/tools')).json() as any).budget;assert.deepEqual(after,before);
 const proof={at:new Date().toISOString(),build,nativeBrowserEntry:base+'/',mode:status.mode,htmlServed:true,assets,memberRole:me.role,tools:reads.map((t:any)=>t.id),anonymousDenied:true,writesDenied:true,budget:after,newPaidRequests:0,limitations:['HTTP workflow qualification; actual browser rendering is checked separately.','No conversation, agent tool invocation or paired player trial.']};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{await c.close();}
