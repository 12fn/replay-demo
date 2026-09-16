/** Final release/source/budget checks through normal native login. No inference or record mutation. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {nativeAppClient} from './native-app-client';
const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version),'Expected release version required');
const attempt=process.argv[3];assert(process.argv.length<=4&&(!attempt||/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(attempt)),'Optional attempt must be a short alphanumeric/hyphen suffix');
const proofPath=`evidence/platform/native-${version.replaceAll('.','')}${attempt?'-'+attempt:''}-checkpoint.json`;
assert(!fs.existsSync(proofPath),'Preserve existing checkpoint; provide a fresh attempt suffix');
const c=await nativeAppClient(),j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
try{
 const build=await j('/replay-build.json');assert.equal(build.version,version);const budget=(await j('/api/agents/tools')).budget;
 const overview=await j('/api/overview');assert(!overview.exercises.some((e:any)=>e.status==='running'||e.agentEnabled));
 let paidStaff=0;for(const e of overview.exercises){await j('/api/select',{exerciseId:e.id});await j('/api/replay',{tick:null});const o=await j('/api/overview');paidStaff+=o.tasks.filter((t:any)=>t.modelEnabled===true).length;}
 assert.equal(paidStaff,0);
 await j('/api/select',{exerciseId:'467bdded-c0f0-4dee-bdd0-14804f53350b'});const original=await j('/api/review/export.json');
 assert.equal(original.payload.engine.fingerprint,'e72d20d9a67f09f799c1c62b6c5eaaedef98e60272b390d98084de6add56895d');
 const old=original.payload.debriefs.find((d:any)=>d.eventId);assert(old);const cache=await j('/api/learning/debrief/'+old.eventId);assert.equal(cache.status,'cached');
 await j('/api/select',{exerciseId:'bbfe0bcc-24ad-4208-a60a-3f33eedfd65c'});const diagnostic=await j('/api/review/export.json');
 const model=diagnostic.payload.events.find((e:any)=>e.id==='b84f26f7-1e2e-49fc-9144-b95da6837664');assert.equal(model.details.providerDiagnostics.outputTokens,171);
 const source=Buffer.from(await(await c.request('/replay-source.tar.gz')).arrayBuffer());assert.equal(sha(source),build.sourceArchive.sha256);
 const sourcePath=`data/platform/replay-${version}-${sha(source).slice(0,12)}-source.tar.gz`;if(fs.existsSync(sourcePath))assert.equal(sha(fs.readFileSync(sourcePath)),sha(source));else fs.writeFileSync(sourcePath,source,{flag:'wx'});
 const preserved={video:sha(fs.readFileSync('evidence/video/replay-demo.mp4')),originalPilotZip:sha(fs.readFileSync('handoff/REPLAY-pilot-candidate.zip'))};
 assert.equal(preserved.video,'850ea5e587bcfc851d23b103f93408d0c1fad17d383c709dcb8492f422a5c40c');assert.equal(preserved.originalPilotZip,'fb486df64de4a1d2d8a83b7f1c4cbd39e56861e22b8e00d9c8d3082a93398772');
 const afterBudget=(await j('/api/agents/tools')).budget;assert.equal(afterBudget.requestsUsed,budget.requestsUsed);
 const proof={at:new Date().toISOString(),build,allExercisesEnded:true,allPaidControllersOff:true,exercises:overview.exercises.length,statuses:Object.fromEntries(overview.exercises.map((e:any)=>[e.id,e.status])),budget:afterBudget,newPaidRequests:0,originalDemoFingerprint:original.payload.engine.fingerprint,legacyDebrief:{eventId:old.eventId,stale:cache.stale,regenerated:false},diagnosticExport:{eventId:model.id,outputTokens:model.details.providerDiagnostics.outputTokens},sourcePath,sourceSha256:sha(source),preserved};
 fs.writeFileSync(proofPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{await c.close();}
