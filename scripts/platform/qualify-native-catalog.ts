/** Native read-only preset catalog qualification, real member identities, zero inference. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';import {KamiwazaClient} from '../../src/platform';
const version=process.argv[2];assert.match(version??'',/^\d+\.\d+\.\d+$/);const file=`evidence/platform/native-catalog-${version}.json`;assert(!fs.existsSync(file));
const proof:any={at:new Date().toISOString(),version,status:'running',modelCalls:0,exerciseWrites:0,members:[]};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');let before:any,rowsBefore='';
const owner=await nativeAppClient();try{const build=await(await owner.request('/replay-build.json')).json() as any;assert.equal(build.version,version);proof.build=build;before=(await(await owner.request('/api/agents/tools')).json() as any).budget;rowsBefore=hash((await(await owner.request('/api/overview')).json() as any).exercises);}finally{await owner.close();}
try{
 const anon=await fetch('http://127.0.0.1:5183/api/catalog');assert([401,403].includes(anon.status));proof.anonymousStatus=anon.status;
 for(const role of ['commander','intelligence']){
  const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8')),u=users.find((x:any)=>x.role===role);assert(u?.username&&u.password);const credentials={username:u.username,password:u.password};for(const x of users)x.password='';
  let summary:any,page:any,detail:any,prior:any;const web=await nativeAppClient(credentials);
  try{
   const response=await web.request('/api/catalog');assert.match(response.headers.get('cache-control')??'',/no-store/);summary=await response.json();assert.equal(summary.currentRole,role);assert(summary.total>1700);assert.equal(summary.counts.persona,36);assert.equal(summary.counts.case,108);assert.equal(summary.nativeOntologyIngested,false);
   for(const aorId of ['taiwan','caribbean','hormuz']){const r=await(await web.request(`/api/catalog/search?aorId=${aorId}&kind=persona`)).json() as any;assert.equal(r.total,12);assert(r.items.every((x:any)=>x.aorId===aorId&&x.provenance==='synthetic'));}
   page=await(await web.request('/api/catalog/search?query=reserve&aorId=taiwan&limit=5')).json();assert(page.items.length>0);
   detail=await(await web.request('/api/catalog/records/'+encodeURIComponent(page.items[0].id))).json();assert.equal(detail.record.id,page.items[0].id);
   const reports=await(await web.request('/api/catalog/search?aorId=taiwan&kind=report&limit=100')).json() as any;
   const original=reports.items.find((r:any)=>typeof r.fields.supersededByReportId==='string');assert(original);
   prior=await(await web.request('/api/catalog/records/'+encodeURIComponent(original.id)+'?cutoffTick='+original.availableAtTick)).json();assert.equal(prior.record.fields.supersededByReportId,null);assert(!prior.backlinks.some((l:any)=>l.relation==='supersedes'));
   const correction=await web.requestRaw('/api/catalog/records/'+encodeURIComponent(original.fields.supersededByReportId)+'?cutoffTick='+original.availableAtTick);assert.equal(correction.status,404);
  }finally{await web.close();}
  const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));let token='';let entered=false;
  const core=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,workroomId:binding.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
  try{
   token=(await core.login(credentials)).data.access_token;credentials.password='';const entry=await core.enterWorkroom(binding.workroom.id);entered=true;if(entry.data.access_token)token=entry.data.access_token;
   let id=0;const rpc=async(method:string,params:unknown)=>{const r=await fetch('http://127.0.0.1:5184/mcp',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'x-workroom-id':binding.workroom.id},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});assert.equal(r.status,200);return r.json() as Promise<any>;};
   const listed=await rpc('tools/list',{});for(const name of ['search_catalog','get_catalog_record'])assert.equal(listed.result.tools.find((t:any)=>t.name===name).annotations.readOnlyHint,true);
   const result=await rpc('tools/call',{name:'search_catalog',arguments:{query:'reserve',aorId:'taiwan',limit:5}});assert.equal(result.result.isError,false);assert.deepEqual(result.result.structuredContent.items.map((r:any)=>r.id),page.items.map((r:any)=>r.id));
   const d=await rpc('tools/call',{name:'get_catalog_record',arguments:{recordId:detail.record.id}});assert.equal(d.result.isError,false);assert.deepEqual(d.result.structuredContent.record,detail.record);
   proof.members.push({role,subject:u.subject,summary,searchIds:page.items.map((r:any)=>r.id),httpMcpParity:true,timeCutoff:true,earliestReport:prior.record.id});
  }finally{credentials.password='';try{if(entered)await core.leaveWorkroom();}finally{token='';}}
 }
 const after=await nativeAppClient();try{proof.budget=(await(await after.request('/api/agents/tools')).json() as any).budget;assert.deepEqual(proof.budget,before);assert.equal(hash((await(await after.request('/api/overview')).json() as any).exercises),rowsBefore);proof.exerciseRowsUnchanged=true;}finally{await after.close();}
 proof.status='passed';
}catch(e){proof.status='failed';proof.failure=e instanceof Error?e.message:'Qualification failed';}
fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file,status:proof.status,members:proof.members.map((m:any)=>({role:m.role,total:m.summary.total,parity:m.httpMcpParity})),modelCalls:0,failure:proof.failure}));if(proof.status!=='passed')process.exitCode=1;
