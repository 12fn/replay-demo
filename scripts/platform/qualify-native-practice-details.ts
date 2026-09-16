/** Native read-only HTTP/MCP parity. No conversation, model request or exercise mutation. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';import {KamiwazaClient} from '../../src/platform';
const version=process.argv[2];assert.match(version??'',/^0\.23\.[1-9]\d*$/);const file=`evidence/platform/native-practice-details-${version}.json`;assert(!fs.existsSync(file));
const proof:any={at:new Date().toISOString(),version,status:'running',modelCalls:0,exerciseWrites:0,checks:{}};
let before:any;const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const owner=await nativeAppClient();try{const b=await(await owner.request('/replay-build.json')).json() as any;assert.equal(b.version,version);proof.build=b;before=await(await owner.request('/api/agents/tools')).json();const o=await(await owner.request('/api/overview')).json() as any;assert(o.exercises.every((e:any)=>e.status!=='running'&&!e.agentEnabled));proof.exercisesBefore=hash(o.exercises);}finally{await owner.close();}
try{
 const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8')),u=users.find((x:any)=>x.role==='commander');assert(u?.username&&u?.password);const subject=u.subject,credentials={username:u.username,password:u.password};for(const x of users)x.password='';
 const web=await nativeAppClient(credentials);let page:any;try{const r=await web.request('/api/practice/history/details?scope=mine&limit=5');assert.match(r.headers.get('cache-control')??'',/no-store/);page=await r.json();assert.equal(page.schema,'replay.practice-history/2');assert(page.items.length>0);assert(page.items.every((i:any)=>i.actor===subject));assert(JSON.stringify(page).length<=6000);const denied=await web.requestRaw('/api/practice/history/details?scope=workroom');assert.equal(denied.status,403);}finally{await web.close();}
 const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));let token='';const core=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,workroomId:binding.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});let entered=false;
 try{
  token=(await core.login(credentials)).data.access_token;credentials.password='';const entry=await core.enterWorkroom(binding.workroom.id);entered=true;if(entry.data.access_token)token=entry.data.access_token;
  let n=0;const rpc=async(method:string,params:unknown)=>{const r=await fetch('http://127.0.0.1:5184/mcp',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'x-workroom-id':binding.workroom.id},body:JSON.stringify({jsonrpc:'2.0',id:++n,method,params})});assert.equal(r.status,200);assert(!r.headers.has('set-cookie'));return r.json() as Promise<any>;};
  const catalog=await rpc('tools/list',{}),tool=catalog.result.tools.find((t:any)=>t.name==='search_practice_details');assert.equal(tool.annotations.readOnlyHint,true);
  const output=await rpc('tools/call',{name:'search_practice_details',arguments:{scope:'mine',limit:5}});assert.equal(output.result.isError,false);assert.deepEqual(output.result.structuredContent,page);
  const denied=await rpc('tools/call',{name:'search_practice_details',arguments:{scope:'workroom'}});assert.equal(denied.result.isError,true);
  proof.checks={httpMcpParity:true,scopedSubject:subject,workroomRefused:true,readOnlyCatalog:true,responseChars:JSON.stringify(page).length,page,transport:'native member bearer through existing MCP extension proxy'};
 }finally{credentials.password='';try{if(entered)await core.leaveWorkroom();}finally{token='';}}
 const after=await nativeAppClient();try{const budget=await(await after.request('/api/agents/tools')).json();assert.deepEqual(budget.budget,before.budget);proof.budget=budget.budget;const o=await(await after.request('/api/overview')).json() as any;assert.equal(hash(o.exercises),proof.exercisesBefore);proof.checks.exerciseRowsUnchanged=true;}finally{await after.close();}
 proof.status='passed';
}catch(e){proof.status='failed';proof.failure=e instanceof Error?e.message:'Qualification failed';}
fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file,status:proof.status,checks:{parity:proof.checks.httpMcpParity,records:proof.checks.page?.items.length,chars:proof.checks.responseChars,rowsUnchanged:proof.checks.exerciseRowsUnchanged},modelCalls:0,failure:proof.failure}));if(proof.status!=='passed')process.exitCode=1;
