/** Publish a verified, completed-model-game graph bundle as managed native dataset bytes, without graph extraction. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {checkGraphIntegrity} from '../../src/ontology/catalog-projection';
import {loadCatalogGraph} from '../../src/server/catalog-graph';
import {ownerSession, signedCall, ReceiptLedger, priorState, sha256, stable, type NativeEnv, type CallSpec} from './publish-preset-catalog';

const names=['graph.json','nodes.jsonl','edges.jsonl','observations.json','graphiti-curated-messages.json','README.md','trial-records.tar.gz'];
function regular(dir:string,name:string){
 assert(names.includes(name)||name==='manifest.json','Unexpected bundle entry');
 const p=path.resolve(dir,name),s=fs.lstatSync(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.size<=32*1024*1024,'Invalid bundle file');
 assert.equal(fs.realpathSync(p),p,'Bundle links refused');return fs.readFileSync(p);
}
export function graphPublicationPlan(dir:string){
 assert.equal(fs.realpathSync(dir),path.resolve(dir),'Linked bundle refused');
 assert.deepEqual(fs.readdirSync(dir).sort(),[...names,'manifest.json'].sort(),'Unexpected bundle files');
 const raw=regular(dir,'manifest.json'),m=JSON.parse(raw.toString());
 assert.equal(m.nativeIngestion,false);assert.deepEqual(m.files.map((f:any)=>f.name).sort(),[...names].sort());
 const objects:Array<{name:string;bytes:Buffer;sha256:string}>=m.files.map((f:any)=>{const bytes=regular(dir,f.name);assert.equal(bytes.length,f.bytes);assert.equal(sha256(bytes),f.sha256);return {name:f.name,bytes,sha256:f.sha256};});
 const loaded=loadCatalogGraph(path.resolve(dir,'graph.json'));assert(loaded.ok,'Graph failed validation');
 const g=loaded.full.graph;assert.deepEqual(checkGraphIntegrity(g),[]);assert.equal(g.graphSha256,m.graphSha256);assert.deepEqual(g.inputs,m.inputs);
 assert.equal(g.nodes.length,m.nodes);assert.equal(g.edges.length,m.edges);assert.equal(g.observations.length,m.observations);
 const trials=g.inputs.filter(i=>i.kind==='dual-model-trial');assert(trials.length>0&&trials.every(i=>i.engineReceipt),'Every game needs an independent engine receipt');
 objects.push({name:'manifest.json',bytes:raw,sha256:sha256(raw)});
 const name=`replay-model-evidence-${g.graphSha256.slice(0,16)}`,urn=`urn:li:dataset:(urn:li:dataPlatform:kamiwaza,${name},DEV)`;
 const properties={'replay.graph_sha256':g.graphSha256,'replay.manifest_sha256':sha256(raw),'replay.node_count':String(m.nodes),'replay.edge_count':String(m.edges),'replay.recorded_model_games':String(trials.length),'replay.native_graph_ingestion':'false','replay.data_class':'public-synthetic-and-recorded-model-games'};
 const body={name,platform:'kamiwaza',environment:'DEV',writable:true,storage:{backend:'file'},description:'REPLAY typed evidence graph and complete recorded model-game source archive. Authored examples and recorded model decisions remain distinct. Managed catalog bytes; not native Graphiti facts.',tags:['replay','model-evaluation','evidence-graph'],properties};
 return {name,urn,body,objects,manifestSha256:sha256(raw),graphSha256:g.graphSha256,trials:trials.length,nodes:m.nodes,edges:m.edges};
}

async function apply(p:ReturnType<typeof graphPublicationPlan>){
 const dir=`evidence/platform/model-evidence-publish/${p.name}`;fs.mkdirSync(dir,{recursive:true});
 const lock=path.join(dir,'apply.lock'),fd=fs.openSync(lock,'wx',0o600),ledger=ReceiptLedger.open(dir),runId=randomUUID();
 const report:any={runId,status:'starting',datasetUrn:p.urn,graphSha256:p.graphSha256,nativeGraphIngested:false,modelCalls:0,created:false,uploaded:[],verified:[]};
 let owner:Awaited<ReturnType<typeof ownerSession>>|undefined;
 try{
  owner=await ownerSession(JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8')));
  const env:NativeEnv={fetch:(url,init)=>fetch(url,init),session:owner.session,calls:{count:0,cap:36}};
  report.workroomId=owner.session.workroomId;report.subject=owner.session.subject;
  const call=async(spec:CallSpec,intent?:string)=>{
   if(intent){assert.equal(priorState(ledger.entries,intent),'none','Previous write must be reconciled, not retried');ledger.append({kind:'intent',runId,intentId:intent,method:spec.method,path:spec.path,bodySha256:spec.json?sha256(spec.json):undefined});}
   const r=await signedCall(env,spec);ledger.append({kind:intent?'outcome':'read',runId,...r.receipt,...(intent?{intentId:intent}:{})},[owner!.session.token()]);
   report.nativeCalls=env.calls.count;return r;
  };
  const read=async(url:string,query?:Record<string,string>,maxBytes=2*1024*1024)=>call({method:'GET',path:url,query,maxBytes});
  let d=await read('/catalog/datasets/by-urn',{urn:p.urn});
  if(d.status===404){
   const r=await call({method:'POST',path:'/catalog/datasets/',json:JSON.stringify(p.body),maxBytes:8192},`dataset:${sha256(stable(p.body))}`);
   assert(r.outcome==='succeeded'&&r.status===201&&JSON.parse(r.body!.toString())===p.urn,'Create failed; inspect ledger');report.created=true;
   d=await read('/catalog/datasets/by-urn',{urn:p.urn});
  }
  assert(d.outcome==='succeeded'&&d.status===200,'Dataset unavailable');const ds=JSON.parse(d.body!.toString());
  assert.equal(ds.urn,p.urn);assert.equal(ds.name,p.name);assert.equal(ds.writable,true);assert.equal(ds.environment,'DEV');assert.equal(ds.platform,'kamiwaza');
  assert.equal(ds.workroom_id,owner.session.workroomId);assert.equal(ds.storage_binding?.workroom_id,owner.session.workroomId);assert.equal(ds.storage_binding?.scope,'workroom');assert.equal(ds.storage_binding?.state,'ready');assert.equal(ds.storage_binding?.backend,'file');
  for(const [k,v] of Object.entries(p.body.properties))assert.equal(ds.properties?.[k],v,'Unrelated dataset');
  const base=`/catalog/datasets/v2/${encodeURIComponent(p.urn)}/objects`;
  const list=async()=>{const r=await read(base,{state:'all'});assert.equal(r.outcome,'succeeded');const items=JSON.parse(r.body!.toString());assert(Array.isArray(items));return items;};
  const items=await list();assert(items.every((i:any)=>i.state==='live'&&p.objects.some((o:any)=>o.name===i.logical_path)),'Unexpected or tombstoned object');
  for(const o of p.objects){
   const same=items.filter((i:any)=>i.logical_path===o.name);assert(same.length<=1,'Duplicate object path');let item=same[0];
   if(!item){
    const form=new FormData();form.append('file',new Blob([new Uint8Array(o.bytes)],{type:o.name.endsWith('.gz')?'application/gzip':o.name.endsWith('.jsonl')?'application/x-ndjson':o.name.endsWith('.md')?'text/markdown':'application/json'}),o.name);form.append('logical_path',o.name);
    const r=await call({method:'POST',path:base,form,maxBytes:65536,timeoutMs:120000},`object:${o.name}:${o.sha256}`);
    assert(r.outcome==='succeeded'&&r.status===201,'Upload failed; inspect ledger');item=JSON.parse(r.body!.toString());report.uploaded.push(o.name);
   }
   assert.match(item.item_id,/^[0-9a-f-]{36}$/i);assert.equal(item.logical_path,o.name);assert.equal(item.size_bytes,o.bytes.length);assert.equal(item.state,'live');
   const r=await read(`${base}/${item.item_id}/content`,undefined,o.bytes.length);assert.equal(r.outcome,'succeeded');assert.equal(r.status,200);assert.equal(sha256(r.body!),o.sha256,'Stored content hash differs');
   const v={name:o.name,itemId:item.item_id,sha256:o.sha256,bytes:o.bytes.length,etag:item.etag};report.verified.push(v);ledger.append({kind:'content-verified',runId,...v});
  }
  const final=await list();assert.equal(final.length,p.objects.length);
  for(const i of final){const v=report.verified.find((x:any)=>x.itemId===i.item_id);assert(v&&i.state==='live'&&i.etag===v.etag&&i.size_bytes===v.bytes&&i.logical_path===v.name,'Final object changed');}
  report.status='published';ledger.append({kind:'complete',...report});
 }catch{report.status='stopped';report.error='Inspect retained native request and content receipts; no automatic retry';ledger.append({kind:'stopped',...report});}
 finally{
  try{await owner?.close();}catch{report.status='stopped';report.error='Owner session cleanup failed';ledger.append({kind:'cleanup-failed',runId});}
  fs.writeFileSync(path.join(dir,`run-${runId}.json`),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});ledger.close();fs.closeSync(fd);fs.rmSync(lock);
 }
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [mode,dir]=process.argv.slice(2);assert(['--plan','--apply'].includes(mode)&&dir&&process.argv.length===4,'Usage: --plan|--apply BUNDLE');
 const p=graphPublicationPlan(dir);
 const result=mode==='--apply'?await apply(p):{status:'planned',name:p.name,urn:p.urn,trials:p.trials,nodes:p.nodes,edges:p.edges,manifestSha256:p.manifestSha256,objects:p.objects.map(o=>({name:o.name,bytes:o.bytes.length,sha256:o.sha256})),modelCalls:0};
 console.log(JSON.stringify(result,null,2));if(result.status==='stopped')process.exitCode=1;
}
