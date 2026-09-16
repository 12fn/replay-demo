import {afterAll,afterEach,describe,expect,it} from 'vitest';
import express from 'express';
import {createHash} from 'node:crypto';
import {mountCatalogGraphRoutes} from '../../src/server/catalog-graph';
const sha=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');
import {syntheticSourceFixture} from '../fixtures/synthetic-source';
const synthetic = syntheticSourceFixture();
const {graphBytes, manifestBytes, archiveBytes, archive, sources, graphPath, manifestPath} = synthetic;
const graph: any = synthetic.graph;
afterAll(() => synthetic.dispose());
const node=graph.nodes.find((n:any)=>n.type==='SourceArtifact'&&n.properties.role==='seat-snapshot'&&n.time.releasedTick>100);
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
async function fixture(){
 const urn=`urn:li:dataset:(urn:li:dataPlatform:kamiwaza,replay-model-evidence-${graph.graphSha256.slice(0,16)},DEV)`,room='room-one',subject='alice';
 const gate={checks:0,denyAt:Infinity},calls:string[]=[];
 const dataset={urn,workroom_id:room,properties:{'replay.graph_sha256':graph.graphSha256,'replay.manifest_sha256':sha(manifestBytes)}};
 const objects=[{logical_path:'graph.json',state:'live',etag:`sha256:${sha(graphBytes)}`},{logical_path:'manifest.json',state:'live',etag:`sha256:${sha(manifestBytes)}`},
  {logical_path:'trial-records.tar.gz',state:'live',etag:`sha256:${archive.sha256}`,size_bytes:archive.bytes,item_id:'11111111-1111-4111-8111-111111111111'}];
 const identity={userId:subject,workroomId:room};let bytes:Uint8Array=archiveBytes;
 const receipt={requestId:'test',status:200};
 const client={catalogDataset:async()=>{calls.push('dataset');return {data:dataset,receipt};},catalogObjects:async()=>{calls.push('objects');return {data:objects,receipt};},
  catalogObjectContent:async(u:string,id:string,r:string,max:number)=>{calls.push('content');expect(u).toBe(urn);expect(id).toBe(objects[2].item_id);expect(r).toBe(room);expect(max).toBe(archive.bytes);return {data:bytes,identity,receipt};}};
 const app=express();app.locals.guards={requireFreshRead:(_req:any,res:any,next:any)=>{
  gate.checks++;if(gate.checks>=gate.denyAt)return res.sendStatus(403);
  res.locals.identity={subject};res.locals.native={platformClient:client,context:{workroomId:room}};next();
 }};
 mountCatalogGraphRoutes(app,{graphPath,manifestPath});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));cleanup.push(()=>server.close());
 const base=`http://127.0.0.1:${(server.address() as any).port}/api/catalog/graph/source`;
 const get=async(params:Record<string,string|number>={id:node.id})=>{
  const r=await fetch(base+'?'+new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])));
  return {status:r.status,cache:r.headers.get('cache-control'),text:await r.text()};
 };
 return {get,gate,calls,dataset,objects,identity,client,corrupt:()=>{bytes=Buffer.from(archiveBytes);bytes[10]^=1;}};
}
describe('native saved-source drilldown',()=>{
 it('returns exactly one saved UTF-8 observation, verified against graph and archive with fresh checks on both sides of the read',async()=>{
  const f=await fixture(),r=await f.get(),body=JSON.parse(r.text);
  expect(r.status).toBe(200);expect(r.cache).toContain('no-store');expect(body.text).toBe(sources.get(node.properties.repoPath));
  expect(body.sha256).toBe(node.provenance.sourceSha256);expect(body.bytes).toBe(node.properties.bytes);expect(body.archive.sha256).toBe(archive.sha256);
  expect(body.nodeId).toBe(node.id);expect(body.view).toBeNull();expect(body).not.toHaveProperty('members');expect(f.gate.checks).toBe(2);expect(f.calls).toEqual(['dataset','objects','content']);
  await f.get();expect(f.calls).toHaveLength(6);expect(f.gate.checks).toBe(4);
 });
 it('retains the review cutoff and refuses future, other-clock, hindsight and non-source records before native reads',async()=>{
  const f=await fixture(),view={clock:node.time.clock,cutoffTick:node.time.releasedTick};
  expect(JSON.parse((await f.get({id:node.id,...view})).text).view).toEqual(view);
  f.calls.length=0;
  for(const params of [{id:node.id,...view,cutoffTick:0},{id:node.id,...view,clock:'preset-catalog/1'},
   {id:graph.nodes.find((n:any)=>n.type==='SourceArtifact'&&n.hindsight).id,...view},{id:graph.nodes.find((n:any)=>n.type==='ActualTrial').id}])
   expect([400,404]).toContain((await f.get(params)).status);
  expect(f.calls).toHaveLength(0);
 });
 it('opens saved structured replies and outcomes, while refusing raw provider traces and replay checkpoints',async()=>{
  const f=await fixture();
  for(const role of ['saved-reply','round-outcome']){
   const n=graph.nodes.find((n:any)=>n.type==='SourceArtifact'&&n.properties.role===role),r=await f.get({id:n.id});expect(r.status).toBe(200);expect(JSON.parse(r.text).text).toBe(sources.get(n.properties.repoPath));
  }
  f.calls.length=0;
  for(const role of ['provider-raw-record','final-replay-checkpoint']){const n=graph.nodes.find((n:any)=>n.type==='SourceArtifact'&&n.properties.role===role);expect((await f.get({id:n.id})).status).toBe(404);}
  expect(f.calls).toHaveLength(0);
 });
 it('accepts only node IDs, no supplied filesystem path or incomplete cutoff',async()=>{
  const f=await fixture();const invalid:Record<string,string|number>[]=[{path:'/etc/passwd'},{id:node.id,path:node.properties.repoPath},{id:node.id,cutoffTick:100},{id:'../../private'}];
  for(const p of invalid)expect([400,404]).toContain((await f.get(p)).status);expect(f.calls).toHaveLength(0);
 });
 it.each(['manifest','workroom','object hash','duplicate','object bytes'])('refuses %s binding mismatch without fetching archive bytes',async(kind)=>{
  const f=await fixture();if(kind==='manifest')f.dataset.properties['replay.manifest_sha256']='0'.repeat(64);
  if(kind==='workroom')f.dataset.workroom_id='elsewhere';if(kind==='object hash')f.objects[2].etag='sha256:'+'0'.repeat(64);
  if(kind==='duplicate')f.objects.push({...f.objects[2]});if(kind==='object bytes')f.objects[2].size_bytes!++;
  expect((await f.get()).status).toBe(409);expect(f.calls).not.toContain('content');
 });
 it('refuses a corrupt archive rather than returning graph summaries as source',async()=>{
  const f=await fixture();f.corrupt();const r=await f.get();expect(r.status).toBe(502);expect(r.text).not.toContain('seat-snapshot');
 });
 it.each([1,2])('honors native revocation at fresh check %i',async(denyAt)=>{
  const f=await fixture();f.gate.denyAt=denyAt;const r=await f.get();expect(r.status).toBe(403);expect(r.text).not.toContain('observation');expect(f.calls.length).toBe(denyAt===1?0:3);
 });
 it('rejects an archive authorized as another subject',async()=>{
  const f=await fixture();f.identity.userId='bob';expect((await f.get()).status).toBe(403);
 });
 it('preserves native denial and hides sensitive exception details',async()=>{
  const f=await fixture();f.client.catalogObjectContent=async()=>{throw Object.assign(new Error('sensitive internal provider detail'),{httpStatus:403});};const r=await f.get();expect(r.status).toBe(403);expect(r.text).not.toContain('sensitive');
 });
});
