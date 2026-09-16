import {afterEach,beforeAll,describe,expect,it} from 'vitest';import express from 'express';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createPresetCatalog} from '../../src/catalog/seed';
import {buildOntologyGraph,canonicalJson,finalOutcomeNodeId,sha256Hex,trialNodeId,type OntologyGraph} from '../../src/ontology/catalog-projection';
import {syntheticTrial, SYNTHETIC_TRIAL as TRIAL, SYNTHETIC_GAME as GAME} from '../fixtures/synthetic-trial';
import {mountCatalogGraphRoutes,loadCatalogGraph,NODE_MAX_RELATIONS} from '../../src/server/catalog-graph';
import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {CatalogGraphPanel} from '../../src/client/components/CatalogGraphPanel';

const CLOCK=`trial:${GAME}`;
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).reverse().forEach(f=>f()));
let graph:OntologyGraph;
beforeAll(()=>{graph=buildOntologyGraph({catalog:createPresetCatalog(),trials:[syntheticTrial()]});});

const clone=():OntologyGraph=>JSON.parse(JSON.stringify(graph));
/** Re-hashes the whole artifact so a tamper reaches the structural checks instead of stopping at a hash mismatch. */
function rehash(g:OntologyGraph){g.graphSha256=sha256Hex(canonicalJson({schema:g.schema,projection:g.projection,inputs:g.inputs,nodes:g.nodes.map(n=>n.contentSha256),edges:g.edges.map(e=>e.contentSha256),observations:g.observations}));return g;}
function writeArtifact(body:string){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-graph-'));cleanup.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'graph.json');fs.writeFileSync(file,body);return file;}
async function serve(graphPath:string){
 const gate={denied:false,checks:0,native:undefined as any};const app=express();
 app.locals.guards={requireFreshRead:(_req:any,res:any,next:any)=>{gate.checks++;if(gate.denied)return res.sendStatus(403);res.locals.identity={subject:'alice',role:'instructor'};res.locals.native=gate.native;next();}};
 mountCatalogGraphRoutes(app,{graphPath});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));cleanup.push(()=>server.close());
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const get=async(route:string,params:Record<string,string|number>={})=>{const r=await fetch(`${base}${route}?${new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]))}`);return {status:r.status,cache:r.headers.get('cache-control'),body:r.headers.get('content-type')?.includes('json')?await r.json():null};};
 return {gate,get,base};
}
const good=async()=>serve(writeArtifact(JSON.stringify(graph)));

describe('native graph archive metadata',()=>{
 const route='/api/catalog/graph/storage';
 function nativeFixture(){
  const name=`replay-model-evidence-${graph.graphSha256.slice(0,16)}`,urn=`urn:li:dataset:(urn:li:dataPlatform:kamiwaza,${name},DEV)`;
  const metadata={urn,workroom_id:'room-one',content_revision:8,properties:{'replay.graph_sha256':graph.graphSha256,private_detail:'not returned'}};
  const objects=[{logical_path:'graph.json',state:'live',etag:`sha256:${sha256Hex(JSON.stringify(graph))}`},...Array.from({length:7},(_,i)=>({logical_path:`other-${i}`,state:'live',etag:'unused'}))];
  const calls:any[]=[];
  const native={context:{workroomId:'room-one'},platformClient:{catalogDataset:async(urn:string,workroomId:string)=>{calls.push({method:'GET',path:'/catalog/datasets/by-urn',query:{urn},workroomId});return {data:metadata,receipt:{method:'GET',status:200}};},catalogObjects:async(urn:string,workroomId:string)=>{calls.push({method:'GET',path:`/catalog/datasets/v2/${encodeURIComponent(urn)}/objects`,query:{state:'live'},workroomId});return {data:objects,receipt:{method:'GET',status:200}};}}};
  return {name,urn,metadata,objects,calls,native};
 }
 it('requires a fresh native session and refuses an invalid graph',async()=>{
  const f=await good();expect((await f.get(route)).status).toBe(409);
  const bad=await serve(writeArtifact('{}'));expect((await bad.get(route)).status).toBe(503);
 });
 it('matches the native workroom, graph identity and file etag without exposing arbitrary properties',async()=>{
  const f=await good(),n=nativeFixture();f.gate.native=n.native;
  const r=await f.get(route);expect(r.status).toBe(200);expect(r.cache).toContain('no-store');
  expect(r.body).toMatchObject({status:'matched',urn:n.urn,workroomId:'room-one',objects:8,contentRevision:8,graphFileSha256:sha256Hex(JSON.stringify(graph)),metadataOnly:true,nativeGraphIngested:false});
  expect(JSON.stringify(r.body)).not.toContain('private_detail');
  expect(n.calls).toEqual([{method:'GET',path:'/catalog/datasets/by-urn',query:{urn:n.urn},workroomId:'room-one'},{method:'GET',path:`/catalog/datasets/v2/${encodeURIComponent(n.urn)}/objects`,query:{state:'live'},workroomId:'room-one'}]);
  f.gate.denied=true;expect((await f.get(route)).status).toBe(403);expect(n.calls).toHaveLength(2);
 });
 it.each(['workroom','urn','graph hash','file hash','duplicate graph'])('refuses a mismatched %s',async(kind)=>{
  const f=await good(),n=nativeFixture();f.gate.native=n.native;
  if(kind==='workroom')n.metadata.workroom_id='other';
  if(kind==='urn')n.metadata.urn='other';
  if(kind==='graph hash')n.metadata.properties['replay.graph_sha256']='0'.repeat(64);
  if(kind==='file hash')n.objects[0].etag='sha256:'+'0'.repeat(64);
  if(kind==='duplicate graph')n.objects.push({...n.objects[0]});
  expect((await f.get(route)).status).toBe(409);
 });
 it.each([401,403,500])('preserves native authorization failure %i and hides provider exception details',async(httpStatus)=>{
  const f=await good();f.gate.native={context:{workroomId:'room-one'},platformClient:{catalogDataset:async()=>{throw Object.assign(new Error('sensitive provider text'),{httpStatus});},catalogObjects:async()=>({data:[]})}};
  const r=await f.get(route);expect(r.status).toBe(httpStatus===500?502:httpStatus);expect(JSON.stringify(r.body)).not.toContain('sensitive');
 });
});

describe('catalog graph artifact refusal',()=>{
 it('accepts the exported artifact',()=>{expect(loadCatalogGraph(writeArtifact(JSON.stringify(graph))).ok).toBe(true);});
 it.each([
  ['missing file',()=>path.join(os.tmpdir(),'no-such-catalog-graph','graph.json')],
  ['malformed JSON',()=>writeArtifact('{"schema":')],
  ['wrong schema id',()=>writeArtifact(JSON.stringify(rehash({...clone(),schema:'other/1' as any})))],
  ['unexpected top-level field',()=>writeArtifact(JSON.stringify({...clone(),native:true}))],
  ['node content tampered without rehash',()=>{const g=clone();g.nodes[0].label='edited';return writeArtifact(JSON.stringify(g));}],
  ['bad content hash format',()=>{const g=clone();g.nodes[0].contentSha256='not-a-hash';return writeArtifact(JSON.stringify(g));}],
  ['graph hash mismatch',()=>{const g=clone();g.graphSha256='0'.repeat(64);return writeArtifact(JSON.stringify(g));}],
  ['dangling edge endpoint',()=>{const g=clone();const e=g.edges.find(x=>x.target===finalOutcomeNodeId(GAME))!;g.nodes=g.nodes.filter(n=>n.id!==e.target);g.edges=g.edges.filter(x=>x.source!==e.target||x.id===e.id);return writeArtifact(JSON.stringify(rehash(g)));}],
 ])('refuses %s and every route answers 503 without synthesized data',async(_label,make)=>{
  const file=make();expect(loadCatalogGraph(file).ok).toBe(false);
  const f=await serve(file);
  for(const [route,params] of [['/api/catalog/graph',{}],['/api/catalog/graph/search',{q:'trial'}],['/api/catalog/graph/node',{id:trialNodeId(GAME)}]] as const){const r=await f.get(route,params);expect(r.status).toBe(503);expect(r.body).toEqual({error:'Catalog graph unavailable'});expect(r.cache).toContain('no-store');}
 });
 it('names the dangling endpoint in the refusal reason',()=>{const g=clone();const e=g.edges.find(x=>x.target===finalOutcomeNodeId(GAME))!;g.nodes=g.nodes.filter(n=>n.id!==e.target);expect((loadCatalogGraph(writeArtifact(JSON.stringify(rehash(g)))) as any).reason).toMatch(/unresolved endpoint/);});
});

describe('catalog graph routes',()=>{
 it('distinguishes identical source filenames across trials and searches their exact trial names',async()=>{
  const all=buildOntologyGraph({catalog:createPresetCatalog(),trials:[syntheticTrial(),syntheticTrial(true,'synthetic-swapped-game')]});
  const f=await serve(writeArtifact(JSON.stringify(all)));
  const relative='results/06/red/response.raw.json';
  const expected=all.nodes.filter(n=>n.type==='SourceArtifact'&&n.properties.path===relative);
  expect(expected.length).toBeGreaterThan(1);
  const page=(await f.get('/api/catalog/graph/search',{type:'SourceArtifact',q:relative})).body;
  expect(page.total).toBe(expected.length);expect(new Set(page.items.map((n:any)=>n.reviewContext.trialName)).size).toBe(expected.length);
  for(const row of page.items){
   const n=expected.find(n=>n.id===row.id)!;expect(row.reviewContext).toMatchObject({trialId:n.time!.clock,seat:'red',roundIndex:6,releasedTick:n.time!.releasedTick});
   const detail=(await f.get('/api/catalog/graph/node',{id:row.id})).body;
   expect(detail.node).toEqual(n);expect(detail.reviewContext).toEqual(row.reviewContext);
   const single=(await f.get('/api/catalog/graph/search',{type:'SourceArtifact',q:relative+' '+row.reviewContext.trialName})).body;
   expect(single.total).toBe(1);expect(single.items[0].id).toBe(row.id);
  }
 });
 it('keeps outcome shortcuts outside the decision-tick view and never adds context to authored records',async()=>{
  const f=await good(),n=graph.nodes.find(n=>n.type==='RecordedModelDecision'&&n.properties.round===2&&n.properties.seat==='red')!;
  const full=(await f.get('/api/catalog/graph/node',{id:n.id})).body;
  expect(full.reviewContext).toMatchObject({trialName:TRIAL,seat:'red',roundIndex:2});
  expect(full.relations.items.find((r:any)=>r.edge.type==='FOLLOWED_BY').endpoint.reviewContext).toMatchObject({trialName:TRIAL,roundIndex:2});
  const cut=(await f.get('/api/catalog/graph/node',{id:n.id,clock:CLOCK,cutoffTick:n.time!.releasedTick})).body;
  expect(cut.node.contentSha256).toBe(n.contentSha256);expect(cut.relations.items.some((r:any)=>r.edge.type==='FOLLOWED_BY')).toBe(false);
  for(const prop of ['snapshotArtifactId','savedReplyArtifactId'])expect(cut.relations.items.some((r:any)=>r.endpoint.id===n.properties[prop])).toBe(true);
  const authored=(await f.get('/api/catalog/graph/search',{type:'SyntheticPersona'})).body;
  expect(authored.items.every((r:any)=>r.reviewContext===undefined)).toBe(true);
 });
 it('honors query terms after the eighth instead of silently broadening search',async()=>{
  const f=await good();
  const r=await f.get('/api/catalog/graph/search',{q:'trial trial trial trial trial trial trial trial no-such-token-xyz'});
  expect(r.status).toBe(200);expect(r.body.total).toBe(0);
 });

 it('summarises counts, clocks and scope behind fresh authorization with no-store, and never serves the raw artifact',async()=>{
  const f=await good(),s=await f.get('/api/catalog/graph');
  expect(s.status).toBe(200);expect(s.cache).toContain('no-store');expect(s.body.scope).toMatch(/Not native Kamiwaza Graphiti facts/);
  expect(s.body.counts.nodes).toBe(graph.nodes.length);expect(s.body.counts.edges).toBe(graph.edges.length);expect(s.body.artifactSha256).toBe(graph.graphSha256);
  expect(s.body.counts.byType.ActualTrial).toBe(1);expect(s.body.types.slice(0,4)).toEqual(['ActualTrial','ModelSeat','RecordedModelDecision','BehaviorObservation']);
  expect(s.body.clocks.map((c:any)=>c.clock)).toContain(CLOCK);expect(s.body).not.toHaveProperty('nodes');expect(s.body).not.toHaveProperty('edges');
  expect((await fetch(f.base+'/api/catalog/graph.json')).status).toBe(404);
 });

 it('re-checks authorization on every request so revocation between requests denies all routes',async()=>{
  const f=await good();expect((await f.get('/api/catalog/graph/search',{type:'ActualTrial'})).status).toBe(200);
  f.gate.denied=true;const before=f.gate.checks;
  for(const [route,params] of [['/api/catalog/graph',{}],['/api/catalog/graph/search',{type:'ActualTrial'}],['/api/catalog/graph/node',{id:trialNodeId(GAME)}]] as const){const r=await f.get(route,params);expect(r.status).toBe(403);expect(r.body).toBeNull();expect(r.cache).toContain('no-store');}
  expect(f.gate.checks).toBe(before+3);
 });

 it('paginates and filters with compact items, recorded trial path first, and literal bounded queries',async()=>{
  const f=await good();
  const first=(await f.get('/api/catalog/graph/search')).body;expect(first.items).toHaveLength(20);expect(first.items[0].type).toBe('ActualTrial');expect(first.items[1].type).toBe('ModelSeat');
  expect(Object.keys(first.items[0]).sort()).toEqual(['dataClass','id','label','reviewContext','summary','type']);
  const a=(await f.get('/api/catalog/graph/search',{type:'RecordedModelDecision',limit:7})).body,b=(await f.get('/api/catalog/graph/search',{type:'RecordedModelDecision',limit:7,offset:7})).body;
  expect(a.total).toBe(graph.nodes.filter(n=>n.type==='RecordedModelDecision').length);expect(a.nextOffset).toBe(7);expect(b.items.every((x:any)=>x.type==='RecordedModelDecision')).toBe(true);
  expect(new Set([...a.items,...b.items].map((x:any)=>x.id)).size).toBe(14);
  const synthetic=(await f.get('/api/catalog/graph/search',{dataClass:'authored-synthetic',type:'SyntheticPersona',limit:3})).body;expect(synthetic.total).toBeGreaterThan(3);expect(synthetic.items.every((x:any)=>x.dataClass==='authored-synthetic')).toBe(true);
  expect((await f.get('/api/catalog/graph/search',{q:'.*'})).body.total).toBe(0);
  const seat=(await f.get('/api/catalog/graph/search',{q:'SEAT/Blue',type:'ModelSeat'})).body;expect(seat.items.map((x:any)=>x.id)).toEqual([`${trialNodeId(GAME)}/seat/blue`]);
  for(const bad of [{limit:21},{limit:0},{offset:-1},{q:'x'.repeat(121)},{type:'Person'},{dataClass:'private'},{format:'raw'},{cutoffTick:5},{clock:CLOCK},{clock:'trial:unknown',cutoffTick:5}])expect((await f.get('/api/catalog/graph/search',bad as any)).status).toBe(400);
  expect((await fetch(f.base+'/api/catalog/graph/search?q=a&q=b')).status).toBe(400);
 });

 it('cutoff hides future rows, other clocks, hindsight and relations to hidden nodes',async()=>{
  const f=await good();
  const decisions=graph.nodes.filter(n=>n.type==='RecordedModelDecision').sort((x,y)=>x.time!.releasedTick-y.time!.releasedTick);
  const cutoff=decisions[Math.floor(decisions.length/2)].time!.releasedTick,future=decisions.find(d=>d.time!.releasedTick>cutoff)!;
  const view={clock:CLOCK,cutoffTick:cutoff};
  const s=(await f.get('/api/catalog/graph',view)).body;expect(s.view).toEqual(view);expect(s.counts.nodes).toBeLessThan(graph.nodes.length);expect(s.counts.byType.BehaviorObservation).toBeUndefined();expect(s.counts.byType.AuthoredCase).toBeUndefined();
  const seen=(await f.get('/api/catalog/graph/search',{...view,type:'RecordedModelDecision',limit:20})).body;
  expect(seen.total).toBe(decisions.filter(d=>d.time!.releasedTick<=cutoff).length);
  const byId=new Map(graph.nodes.map(n=>[n.id,n]));for(const item of seen.items)expect(byId.get(item.id)!.time!.releasedTick).toBeLessThanOrEqual(cutoff);
  expect((await f.get('/api/catalog/graph/search',{...view,q:future.id})).body.total).toBe(0);
  expect((await f.get('/api/catalog/graph/node',{...view,id:future.id})).status).toBe(404);expect((await f.get('/api/catalog/graph/node',{id:future.id})).status).toBe(200);
  expect((await f.get('/api/catalog/graph/node',{...view,id:finalOutcomeNodeId(GAME)})).status).toBe(404);
  const trial=(await f.get('/api/catalog/graph/node',{...view,id:trialNodeId(GAME),edgeOffset:0})).body;const fullTrial=(await f.get('/api/catalog/graph/node',{id:trialNodeId(GAME)})).body;
  expect(trial.relations.total).toBeLessThan(fullTrial.relations.total);
  let offset=0;for(;;){const page=(await f.get('/api/catalog/graph/node',{...view,id:trialNodeId(GAME),edgeOffset:offset})).body;for(const r of page.relations.items){const end=byId.get(r.endpoint.id)!;expect(end.id).not.toBe(finalOutcomeNodeId(GAME));expect(end.time===null?!end.hindsight:end.time.clock===CLOCK&&end.time.releasedTick<=cutoff).toBe(true);}if(!page.relations.truncated)break;offset+=NODE_MAX_RELATIONS;}
 });

 it('caps adjacent relations at 16 with totals, truncation, stable offset pages and 404 for unknown nodes',async()=>{
  const f=await good();const degree=new Map<string,number>();for(const e of graph.edges)for(const id of new Set([e.source,e.target]))degree.set(id,(degree.get(id)??0)+1);
  const [hub,total]=[...degree].sort((a,b)=>b[1]-a[1])[0];expect(total).toBeGreaterThan(NODE_MAX_RELATIONS*2);
  const p1=(await f.get('/api/catalog/graph/node',{id:hub})).body,p2=(await f.get('/api/catalog/graph/node',{id:hub,edgeOffset:NODE_MAX_RELATIONS})).body;
  expect(p1.node.id).toBe(hub);expect(p1.node.contentSha256).toBe(graph.nodes.find(n=>n.id===hub)!.contentSha256);
  expect(p1.relations).toMatchObject({total,offset:0,limit:16,truncated:true});expect(p1.relations.items).toHaveLength(16);expect(p2.relations.items).toHaveLength(16);
  expect(new Set([...p1.relations.items,...p2.relations.items].map((r:any)=>r.edge.id)).size).toBe(32);
  for(const r of p1.relations.items){expect([r.edge.id,r.endpoint.id].every(Boolean)).toBe(true);expect(r.statement.length).toBeGreaterThan(0);expect(r.edge.contentSha256).toMatch(/^[0-9a-f]{64}$/);}
  const seatPath=(await f.get('/api/catalog/graph/node',{id:trialNodeId(GAME)})).body;expect(seatPath.relations.items[0].endpoint.type).toBe('ModelSeat');expect(seatPath.relations.items[0].edge.type).toBe('HAS_SEAT');
  expect((await f.get('/api/catalog/graph/node',{id:'trial:unknown'})).status).toBe(404);expect((await f.get('/api/catalog/graph/node',{})).status).toBe(400);expect((await f.get('/api/catalog/graph/node',{id:hub,edgeOffset:'x'})).status).toBe(400);
 });

 it('renders an accessible panel shell that labels the projection as non-native and offers the recorded model path first',()=>{
  const html=renderToStaticMarkup(createElement(CatalogGraphPanel,{scopeKey:'alice@workroom'}));
  expect(html).toContain('not native Kamiwaza graph facts');expect(html).toContain('role="search"');expect(html).toContain('aria-label="Recorded model game path"');
  expect(html.indexOf('1. Trials')).toBeLessThan(html.indexOf('2. Model seats'));expect(html.indexOf('3. Model decisions')).toBeLessThan(html.indexOf('4. Behavior observations'));
  expect(html).toContain('maxLength="120"');expect(html).not.toMatch(/href=|download|graph\.json|rewind|replay the game from/i);
 });

 it('requires the fresh-read guard at mount',()=>{const app=express();app.locals.guards={};expect(()=>mountCatalogGraphRoutes(app,{graphPath:'unused.json'})).toThrow(/fresh-read/);});
});
