/** Export the actual automated-browser provenance check through normal native application login. No inference. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {nativeAppClient} from './native-app-client';
const exerciseId='1423b4fb-dfc3-4869-a77b-5bb5f47958de';
const parentId='467bdded-c0f0-4dee-bdd0-14804f53350b';
const app=await nativeAppClient();
try{
 await app.request('/api/select',{exerciseId});
 const bundle=await(await app.request('/api/review/export.json')).json() as any;
 const event=bundle.payload.events.find((e:any)=>e.kind==='command'&&e.details.commandId==='b1794d6d-55d5-47e7-84c9-722598be1ba5');
 assert(event,'Actual browser command missing');
 const d=event.details;
 assert.equal(d.observation.basis,'app-snapshot-returned-with-order');
 assert.equal(d.observation.tick,162);assert.equal(d.admittedTick,172);assert.equal(event.tick,173);
 assert.equal(d.intent.troops/d.observation.player.troops,.5);
 assert.notEqual(d.observation.player.troops,d.before.troops);
 assert.equal(bundle.payload.exercise.status,'completed');
 assert.equal(bundle.payload.receipts.length,0);
 const tools=await(await app.request('/api/agents/tools')).json() as any;
 assert.equal(tools.budget.requestsUsed,73);assert.equal(tools.opponent.enabled,false);
 await app.request('/api/select',{exerciseId:parentId});
 const original=await(await app.request('/api/review/export.json')).json() as any;
 assert.equal(original.payload.engine.fingerprint,'e72d20d9a67f09f799c1c62b6c5eaaedef98e60272b390d98084de6add56895d');
 const build=await(await app.request('/replay-build.json')).json();
 const proof={at:new Date().toISOString(),operation:'automated native browser qualification; not human playtest',build,exerciseId,command:event,engine:bundle.payload.engine,bundleSha256:bundle.sha256,sourceExerciseUnchanged:parentId,originalFingerprint:original.payload.engine.fingerprint,budget:tools.budget,newPaidRequests:0};
 fs.writeFileSync('evidence/poc/native-observation.json',JSON.stringify(proof,null,2));
 console.log(JSON.stringify({exerciseId,observedTick:d.observation.tick,admittedTick:d.admittedTick,executedTick:event.tick,clientForces:d.observation.player.troops,admissionForces:d.before.troops,commitment:d.intent.troops,bundleSha256:bundle.sha256,newPaidRequests:0}));
}finally{await app.close();}
