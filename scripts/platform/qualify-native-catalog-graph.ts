/** Qualify the deployed graph and live native archive reads as real member identities; no inference or game writes. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';

const version=process.argv[2];assert.match(version??'',/^\d+\.\d+\.\d+$/);
const file=`evidence/platform/native-catalog-graph-${version}.json`;assert(!fs.existsSync(file));
const graphBytes=fs.readFileSync('resources/catalog-ontology/graph.json'),graph=JSON.parse(graphBytes.toString());
const expectedTypes=graph.nodes.reduce((counts:Record<string,number>,node:any)=>{counts[node.type]=(counts[node.type]??0)+1;return counts;},{});
assert(expectedTypes.ActualTrial>0&&expectedTypes.RecordedModelDecision>0&&expectedTypes.BehaviorObservation>0,'Fixture must contain real recorded trials and derived observations');
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const proof:any={at:new Date().toISOString(),version,status:'running',modelCalls:0,exerciseWrites:0,members:[]};
let before:any,rowsBefore='';
try{
 const owner=await nativeAppClient();try{
  const build=await(await owner.request('/replay-build.json')).json() as any;assert.equal(build.version,version);proof.build=build;
  before=(await(await owner.request('/api/agents/tools')).json() as any).budget;
  rowsBefore=hash((await(await owner.request('/api/overview')).json() as any).exercises);
 }finally{await owner.close();}
 for(const route of ['/api/catalog/graph','/api/catalog/graph/storage','/api/catalog/graph/search?type=ActualTrial']){
  const r=await fetch(`http://127.0.0.1:5183${route}`);assert([401,403].includes(r.status));
 }
 proof.anonymousDenied=true;
 for(const role of ['commander','intelligence']){
  const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8')),u=users.find((x:any)=>x.role===role);assert(u?.username&&u.password);
  const credentials={username:u.username,password:u.password};for(const x of users)x.password='';
  const web=await nativeAppClient(credentials);credentials.password='';
  try{
   const read=async(path:string)=>{const r=await web.request(path);assert.match(r.headers.get('cache-control')??'',/no-store/);return r.json() as Promise<any>;};
   const summary=await read('/api/catalog/graph');assert.equal(summary.artifactSha256,graph.graphSha256);
   assert.equal(summary.counts.nodes,graph.nodes.length);assert.equal(summary.counts.edges,graph.edges.length);
   assert.deepEqual(summary.counts.byType,expectedTypes);
   const storage=await read('/api/catalog/graph/storage');assert.equal(storage.status,'matched');assert.equal(storage.objects,8);
   assert.equal(storage.graphFileSha256,createHash('sha256').update(graphBytes).digest('hex'));assert.equal(storage.metadataOnly,true);assert.equal(storage.nativeGraphIngested,false);
   const trials=await read('/api/catalog/graph/search?type=ActualTrial');assert.equal(trials.total,expectedTypes.ActualTrial);
   const sourcePath='results/06/red/response.raw.json',expectedSources=graph.nodes.filter((n:any)=>n.type==='SourceArtifact'&&n.properties.path===sourcePath);
   const sourceHits=await read('/api/catalog/graph/search?type=SourceArtifact&q='+encodeURIComponent(sourcePath));assert.equal(sourceHits.total,expectedSources.length);
   assert.equal(new Set(sourceHits.items.map((n:any)=>n.reviewContext.trialName)).size,expectedSources.length);
   const first=sourceHits.items[0],sourceDetail=await read('/api/catalog/graph/node?id='+encodeURIComponent(first.id));
   assert.deepEqual(sourceDetail.reviewContext,first.reviewContext);assert.equal(sourceDetail.reviewContext.roundIndex,6);assert.equal(sourceDetail.reviewContext.seat,'red');
   const isolated=await read('/api/catalog/graph/search?type=SourceArtifact&q='+encodeURIComponent(sourcePath+' '+first.reviewContext.trialName));assert.equal(isolated.total,1);assert.equal(isolated.items[0].id,first.id);
   const trial=await read('/api/catalog/graph/node?id='+encodeURIComponent(trials.items[0].id));
   const seat=trial.relations.items.find((r:any)=>r.endpoint.type==='ModelSeat');assert(seat);
   const seatDetail=await read('/api/catalog/graph/node?id='+encodeURIComponent(seat.endpoint.id));
   assert(seatDetail.relations.items.some((r:any)=>r.endpoint.type==='RecordedModelDecision'));
   const decisionId=seatDetail.relations.items.find((r:any)=>r.endpoint.type==='RecordedModelDecision').endpoint.id;
   const decision=await read('/api/catalog/graph/node?id='+encodeURIComponent(decisionId));
   for(const key of ['snapshotArtifactId','savedReplyArtifactId'])assert(decision.relations.items.some((r:any)=>r.endpoint.id===decision.node.properties[key]));
   assert(decision.relations.items.some((r:any)=>r.edge.type==='FOLLOWED_BY'));
   const beforeOutcome=await read('/api/catalog/graph/node?'+new URLSearchParams({id:decisionId,clock:decision.node.time.clock,cutoffTick:String(decision.node.time.releasedTick)}));
   assert(!beforeOutcome.relations.items.some((r:any)=>r.edge.type==='FOLLOWED_BY'));
   const future=graph.nodes.find((n:any)=>n.type==='RecordedModelDecision'&&n.time.releasedTick>0);assert(future);
   const cutoff=`clock=${encodeURIComponent(future.time.clock)}&cutoffTick=0`;
   assert.equal((await web.requestRaw(`/api/catalog/graph/node?id=${encodeURIComponent(future.id)}&${cutoff}`)).status,404);
   const cut=await read('/api/catalog/graph?'+cutoff);assert.equal(cut.counts.byType.BehaviorObservation,undefined);
   proof.members.push({role,subject:u.subject,counts:summary.counts,storage,trialToSeatToDecision:true,futureHidden:true,graphSha256:summary.artifactSha256,sourceContext:{distinctTrials:sourceHits.total,selected:sourceDetail.reviewContext,searchByTrial:true},decisionReviewShortcuts:true,outcomeCutoffVerified:true});
  }finally{await web.close();}
 }
 const after=await nativeAppClient();try{
  proof.budget=(await(await after.request('/api/agents/tools')).json() as any).budget;assert.deepEqual(proof.budget,before);
  assert.equal(hash((await(await after.request('/api/overview')).json() as any).exercises),rowsBefore);proof.exerciseRowsUnchanged=true;
 }finally{await after.close();}
 proof.status='passed';
}catch(e){proof.status='failed';proof.failure=e instanceof Error?e.message:'Qualification failed';}
fs.writeFileSync(file,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({file,status:proof.status,members:proof.members.map((m:any)=>({role:m.role,nodes:m.counts.nodes,edges:m.counts.edges,nativeObjects:m.storage.objects})),modelCalls:0,failure:proof.failure}));
if(proof.status!=='passed')process.exitCode=1;
