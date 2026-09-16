/** Native member archive drilldown: exact saved bytes, review cutoffs and unchanged budget/game rows. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert.match(version??'',/^\d+\.\d+\.\d+$/);
const file=`evidence/platform/native-catalog-source-${version}.json`;assert(!fs.existsSync(file));
const graph=JSON.parse(fs.readFileSync('resources/catalog-ontology/graph.json','utf8'));
const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
const proof:any={at:new Date().toISOString(),version,status:'running',modelCalls:0,exerciseWrites:0,members:[]};
const saved=graph.nodes.filter((n:any)=>n.type==='SourceArtifact'&&n.properties.repoPath.includes('held0001-v2-sol-blue-opus-red'));
const selected=['seat-snapshot','seat-prompt','saved-reply','decision-record','round-state','round-outcome'].map(role=>{
 const n=saved.find((n:any)=>n.properties.role===role&&n.properties.path.includes('/06/'));assert(n);return n;
});
const route=(n:any,cut?:number)=>'/api/catalog/graph/source?'+new URLSearchParams({id:n.id,...(cut===undefined?{}:{clock:n.time.clock,cutoffTick:String(cut)})});
let before:any,rowsBefore='';
try{
 const owner=await nativeAppClient();try{
  const build=await(await owner.request('/replay-build.json')).json() as any;assert.equal(build.version,version);proof.build=build;
  before=(await(await owner.request('/api/agents/tools')).json() as any).budget;
  rowsBefore=sha(JSON.stringify((await(await owner.request('/api/overview')).json() as any).exercises));
 }finally{await owner.close();}
 assert([401,403].includes((await fetch('http://127.0.0.1:5183'+route(selected[0]))).status));proof.anonymousDenied=true;
 for(const role of ['commander','intelligence']){
  const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8')),u=users.find((x:any)=>x.role===role);assert(u?.username&&u.password);
  const credentials={username:u.username,password:u.password};for(const x of users)x.password='';
  const web=await nativeAppClient(credentials);credentials.password='';
  try{
   const member:any={role,subject:u.subject,sources:[]};
   for(const n of selected){
    const response=await web.request(route(n));assert.match(response.headers.get('cache-control')??'',/no-store/);
    const b=await response.json() as any,raw=fs.readFileSync(n.properties.repoPath);
    assert.equal(b.text,raw.toString('utf8'));assert.equal(b.bytes,raw.length);assert.equal(b.sha256,sha(raw));assert.equal(b.nodeId,n.id);assert.equal(b.receipts.length,3);
    member.sources.push({id:n.id,path:b.path,bytes:b.bytes,sha256:b.sha256,archive:b.archive,receipts:b.receipts});
   }
   const n=selected[0];assert.equal((await web.requestRaw(route(n,n.time.releasedTick-1))).status,404);
   const at=await(await web.request(route(n,n.time.releasedTick))).json() as any;assert.deepEqual(at.view,{clock:n.time.clock,cutoffTick:n.time.releasedTick});assert.equal(at.sha256,n.provenance.sourceSha256);
   const privateTrace=saved.find((n:any)=>n.properties.role==='provider-raw-record');assert(privateTrace);
   assert.equal((await web.requestRaw(route(privateTrace))).status,404);
   assert.equal((await web.requestRaw(route(n)+'&path=unauthorized')).status,400);
   member.cutoffVerified=true;member.rawProviderRecordRefused=true;member.arbitraryPathRefused=true;proof.members.push(member);
  }finally{await web.close();}
 }
 const after=await nativeAppClient();try{
  proof.budget=(await(await after.request('/api/agents/tools')).json() as any).budget;assert.deepEqual(proof.budget,before);
  assert.equal(sha(JSON.stringify((await(await after.request('/api/overview')).json() as any).exercises)),rowsBefore);proof.exerciseRowsUnchanged=true;
 }finally{await after.close();}
 proof.status='passed';
}catch(e){proof.status='failed';proof.failure=e instanceof Error?e.message:'Qualification failed';}
fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({file,status:proof.status,members:proof.members.map((m:any)=>({role:m.role,sourceFiles:m.sources.length,cutoff:m.cutoffVerified})),modelCalls:0,failure:proof.failure}));
if(proof.status!=='passed')process.exitCode=1;
