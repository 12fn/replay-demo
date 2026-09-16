/** One new ended exercise; actual member MCP free-watch creation, retry and source alert. No inference. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
import {nativeAppClient} from './native-app-client';import {KamiwazaClient} from '../../src/platform';
const version=process.argv[2];assert(/^\d+\.\d+\.\d+$/.test(version));
const file=`evidence/platform/mcp-watch-${version}.json`;const proof:any={at:new Date().toISOString(),version,status:'running',automated:true,humanValidated:false,modelCalls:0,transport:'Direct native member MCP; not a Tomo conversation',requests:[]};
fs.writeFileSync(file,JSON.stringify(proof),{flag:'wx'});const save=()=>fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n');
let owner:Awaited<ReturnType<typeof nativeAppClient>>|undefined,joiner:Awaited<ReturnType<typeof nativeAppClient>>|undefined,token='',core:KamiwazaClient|undefined,entered=false,id:string|undefined,creating=false;
const name=`Automated native MCP watch ${version} ${randomUUID().slice(0,8)}`;
const j=async(p:string,b?:unknown)=>{const r=await owner!.requestRaw(p,b,{signal:AbortSignal.timeout(15000)});assert(r.ok,`HTTP ${r.status} at ${p}`);return await r.json() as any;};
try{
 owner=await nativeAppClient();assert.equal((await j('/replay-build.json')).version,version);proof.before=(await j('/api/agents/tools')).budget;
 creating=true;const ex=await j('/api/exercises',{name,scenarioId:'crosscurrent-evidence/1'});id=ex.id;proof.exerciseId=id;save();
 const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8')),user=users.find((u:any)=>u.role==='commander');assert(user);
 const invitation=await j('/api/team/code',{});joiner=await nativeAppClient(user);await joiner.request('/api/team/join',{code:invitation.code});invitation.code='';await joiner.close();joiner=undefined;
 const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));
 core=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,workroomId:binding.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
 token=(await core.login(user)).data.access_token;for(const u of users)u.password='';const entrance=await core.enterWorkroom(binding.workroom.id);entered=true;if(entrance.data.access_token)token=entrance.data.access_token;
 const identity=(await core.workroomContext(binding.workroom.id)).identity;proof.subject=identity.userId;
 let n=0;const rpc=async(method:string,params:unknown)=>{const r=await fetch('http://127.0.0.1:5183/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'x-workroom-id':binding.workroom.id},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params}),signal:AbortSignal.timeout(15000)});proof.requests.push({method,status:r.status});assert.equal(r.status,200);return await r.json() as any;};
 const catalog=await rpc('tools/list',{});assert.equal(catalog.result.tools.length,8);assert.equal(catalog.result.tools.find((t:any)=>t.name==='create_watch').annotations.readOnlyHint,false);
 const args={exerciseId:id,requestId:randomUUID(),title:'Monitor report provenance'};
 const call=async(arguments_:unknown)=>rpc('tools/call',{name:'create_watch',arguments:arguments_});
 const first=await call(args);assert.equal(first.result.isError,false);const created=first.result.structuredContent;proof.created=created;save();assert.equal(created.task.modelEnabled,false);
 const repeat=await call(args);assert.equal(repeat.result.structuredContent.task.id,created.task.id);assert.equal(repeat.result.structuredContent.receipt.replayed,true);
 const wrong=await call({...args,requestId:randomUUID(),side:'red'});assert.equal(wrong.error.code,-32602);
 let overview:any,alert:any;const until=Date.now()+45000;
 do{overview=await j('/api/overview');alert=overview.timeline.find((e:any)=>e.kind==='staff_update'&&e.details.taskId===created.task.id&&e.details.sourceIds?.length);if(alert)break;await delay(1000);}while(Date.now()<until);
 assert(alert,'Expected a real released-report watch alert');assert.equal(overview.tasks.filter((t:any)=>t.id===created.task.id).length,1);assert.equal(overview.tasks.find((t:any)=>t.id===created.task.id).owner,identity.userId);
 proof.alert=alert;proof.taskCount=overview.tasks.length;proof.extraSideRefused=true;await j(`/api/exercises/${id}/finish`,{});proof.ended=true;
 const afterEnd=await call(args);assert.equal(afterEnd.result.structuredContent.task.id,created.task.id);proof.retryAfterEnd=true;
 proof.status='passed';
}catch(e){proof.status='failed';proof.failure=e instanceof Error?e.message:'Failure';}
finally{
 if(joiner)await joiner.close().catch(()=>{});if(core&&entered)await core.leaveWorkroom().catch(()=>{});token='';
 if(owner){try{if(creating&&!id){const o=await j('/api/overview');const rows=o.exercises.filter((e:any)=>e.name===name);if(rows.length===1){id=rows[0].id;proof.exerciseId=id;}}if(id&&!proof.ended){await j(`/api/exercises/${id}/finish`,{});proof.ended=true;}proof.after=(await j('/api/agents/tools')).budget;assert.equal(proof.after.requestsUsed,proof.before.requestsUsed);}catch(e){proof.status='failed';proof.cleanupFailure=e instanceof Error?e.message:'Cleanup failed';}await owner.close().catch(()=>{});}
 proof.finishedAt=new Date().toISOString();save();
}
console.log(JSON.stringify({file,status:proof.status,exerciseId:id,ended:proof.ended,failure:proof.failure,cleanupFailure:proof.cleanupFailure}));if(proof.status!=='passed')process.exitCode=1;
