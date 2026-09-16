/** Direct member-bearer transport qualification; this is NOT a live Tomo conversation. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {KamiwazaClient} from '../../src/platform';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version),'Expected version');
const proxy=process.argv[3]==='proxy';assert(!process.argv[3]||proxy,'Optional mode must be proxy');
const artifact=`evidence/platform/native-mcp-${proxy?'proxy-':''}${version}.json`;assert(!fs.existsSync(artifact),'Preserve prior receipt');
const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
let credentials=users.find((u:any)=>u.role==='commander');assert(credentials);
let token='';
const client=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,workroomId:binding.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
const base=`http://127.0.0.1:${proxy?5184:5183}`;let sequence=0;
const rpc=async(method:string,params:unknown={},headers:Record<string,string>={},notification=false)=>{
 const r=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'x-workroom-id':binding.workroom.id,...headers},body:JSON.stringify({jsonrpc:'2.0',...(!notification?{id:++sequence}:{}),method,params})});
 assert(!r.headers.has('set-cookie'),'MCP must not create a browser session');
 const text=await r.text();return {status:r.status,body:text?JSON.parse(text):null};
};
try{
 const build=await(await fetch('http://127.0.0.1:5183/replay-build.json')).json() as any;assert.equal(build.version,version);
 token=(await client.login(credentials)).data.access_token;
 credentials.password='';credentials=null;for(const u of users)u.password='';
 const enter=await client.enterWorkroom(binding.workroom.id);if(enter.data.access_token)token=enter.data.access_token;
 const identity=await client.workroomContext(binding.workroom.id);
 let discovery=null;
 if(proxy){const listed=await client.listExtensions({workroomId:binding.workroom.id});const tool=listed.data.find(e=>e.name==='replay-tools');assert(tool);assert.equal(tool.type,'tool');assert.equal(tool.phase?.toLowerCase(),'running');discovery={name:tool.name,type:tool.type,phase:tool.phase,endpoints:tool.endpoints,receipt:listed.receipt};}
 const hello=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'REPLAY native qualification',version:'1'}});
 assert.equal(hello.status,200);assert.equal(hello.body.result.serverInfo.version,version);
 const initialized=await rpc('notifications/initialized',{}, {},true);assert.equal(initialized.status,202);
 const catalog=await rpc('tools/list');assert.equal(catalog.status,200);const names=catalog.body.result.tools.map((t:any)=>t.name);assert(names.includes('get_key_moments'));
 assert(catalog.body.result.tools.every((t:any)=>t.annotations.readOnlyHint===true));
 const listed=await rpc('tools/call',{name:'list_exercises',arguments:{}});assert.equal(listed.body.result.isError,false);
 const list=listed.body.result.structuredContent;assert.equal(list.viewer.role,'commander');assert(list.exercises.length>0);
 const target=list.exercises.find((e:any)=>e.currentTick>=1);assert(target);
 const calls=[];
 for(const name of names.filter((n:string)=>n!=='list_exercises')){
  if(name==='search_practice_history'){const r=await rpc('tools/call',{name,arguments:{limit:2}});assert.equal(r.status,200);assert.equal(r.body.result.isError,false);assert.equal(r.body.result.structuredContent.schema,'replay.practice-history/1');calls.push({name,scope:r.body.result.structuredContent.scope,items:r.body.result.structuredContent.items.length});continue;}
  const r=await rpc('tools/call',{name,arguments:{exerciseId:target.id,tick:1}});
  assert.equal(r.status,200);assert.equal(r.body.result.isError,false,`${name} must succeed`);
  const p=r.body.result.structuredContent;assert.equal(p.provenance.cutoffTick,1);assert.equal(p.provenance.position,'historical');
  calls.push({name,position:p.provenance.position,cutoffTick:p.provenance.cutoffTick,bytes:Buffer.byteLength(JSON.stringify(p))});
 }
 const missing=await rpc('tools/list',{}, {Authorization:''});assert.equal(missing.status,401);
 const wrongRoom=await rpc('tools/list',{}, {'x-workroom-id':'different-workroom'});assert.equal(wrongRoom.status,403);
 const spoof=await rpc('tools/call',{name:'list_exercises',arguments:{}},{'x-user-id':'pretend-owner','x-user-roles':'admin'});
 assert.equal(spoof.body.result.structuredContent.viewer.role,'commander');
 const bad=await rpc('tools/call',{name:'get_exercise_state',arguments:{exerciseId:target.id,tick:1,side:'red'}});assert.equal(bad.body.error.code,-32602);
 const after=await rpc('tools/call',{name:'get_exercise_state',arguments:{exerciseId:target.id,tick:target.currentTick+100}});assert.equal(after.body.result.isError,true);
 const result={at:new Date().toISOString(),build,transport:proxy?'Native tool-extension proxy using the calling member bearer; Tomo not used':'Direct Streamable HTTP client using its own native member bearer; Tomo not used',discovery,subject:identity.identity.userId,role:list.viewer.role,workroom:binding.workroom.id,exerciseId:target.id,tools:names,calls,initialize:true,initializedNotification:true,missingBearerDenied:true,wrongRoomDenied:true,spoofedIdentityIgnored:true,extraArgumentsDenied:true,futureTickDenied:true,browserCookieCreated:false,inferenceRequested:false,limitations:['No Tomo deployment or actual conversation/agent selection is proved by this protocol check.','No human fun or learning validation.']};
 fs.writeFileSync(artifact,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
}finally{if(token){try{await client.leaveWorkroom();}catch{/* ephemeral token is discarded even if cleanup cannot reach Core */}}token='';}
