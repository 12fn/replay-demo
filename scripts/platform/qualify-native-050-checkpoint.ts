/** Native cache/auth and final runtime/source qualification; no new inference. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {nativeAppClient} from './native-app-client';
const c=await nativeAppClient(),j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
try{
 await j('/api/select',{exerciseId:'467bdded-c0f0-4dee-bdd0-14804f53350b'});const before=await j('/api/review/export.json'),budget=(await j('/api/agents/tools')).budget;
 assert.equal(before.payload.engine.fingerprint,'e72d20d9a67f09f799c1c62b6c5eaaedef98e60272b390d98084de6add56895d');const record=before.payload.debriefs.find((d:any)=>d.eventId);assert(record);
 const cached=await j('/api/learning/debrief/'+record.eventId);assert.equal(cached.status,'cached');
 // A legacy prompt/evidence hash can be stale. Preserve it; never turn this verification into paid regeneration.
 const delivered=cached.stale?null:await j('/api/learning/debrief',{eventId:record.eventId});if(delivered)assert.equal(delivered.status,'cached');const after=await j('/api/review/export.json');assert.equal(after.payload.receipts.length,before.payload.receipts.length);
 const checks=after.payload.events.filter((e:any)=>e.sequence>Math.max(...before.payload.events.map((x:any)=>x.sequence))&&e.kind==='agent_authorized'&&e.details.slot==='debrief');if(delivered)assert(checks.length>=2);assert.equal((await j('/api/agents/tools')).budget.requestsUsed,budget.requestsUsed);
 const o=await j('/api/overview');assert(!o.exercises.some((e:any)=>e.status==='running'||e.agentEnabled));let paidStaff=0;for(const e of o.exercises){await j('/api/select',{exerciseId:e.id});const v=await j('/api/overview');paidStaff+=v.tasks.filter((t:any)=>t.modelEnabled===true).length;}assert.equal(paidStaff,0);
 const build=await j('/replay-build.json');const bytes=Buffer.from(await(await c.request('/replay-source.tar.gz')).arrayBuffer()),hash=createHash('sha256').update(bytes).digest('hex');assert.equal(hash,build.sourceArchive.sha256);fs.writeFileSync('data/platform/replay-0.5.0-source.tar.gz',bytes);
 const proof={at:new Date().toISOString(),build,sourceSha256:hash,allExercisesEnded:true,allPaidControllersOff:true,exercises:o.exercises.length,budget,debrief:{eventId:record.eventId,status:cached.status,stale:cached.stale,postDeliveryQualified:!!delivered,regenerationSkipped:cached.stale,receiptId:cached.record.receipt.id,freshNativeAuthorizations:checks.map((e:any)=>({id:e.id,details:e.details})),newInference:0},originalDemoFingerprint:after.payload.engine.fingerprint};fs.writeFileSync('evidence/platform/native-050-checkpoint.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}finally{await c.close();}
