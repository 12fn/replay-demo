/** Read the actual native demo records through normal application authentication. No inference. */
import fs from 'node:fs';
import {nativeAppClient} from './native-app-client';
const app=await nativeAppClient();
try {
 const ov=await(await app.request('/api/overview')).json() as any;
 const ids=['dc8224b6-1a3d-4b0c-ba5f-30c5c31e1bdc',...ov.exercises.filter((e:any)=>e.parentId==='467bdded-c0f0-4dee-bdd0-14804f53350b').map((e:any)=>e.id)];
 for (const exerciseId of ids) {
  await app.request('/api/select',{exerciseId});
  const bundle=await(await app.request('/api/review/export.json')).json() as any;
  fs.writeFileSync(`evidence/poc/demo-${exerciseId}.json`,JSON.stringify(bundle));
  const events=bundle.payload.events;
  console.log(JSON.stringify({exercise:bundle.payload.exercise,engine:bundle.payload.engine.fingerprint,models:events.filter((e:any)=>e.kind==='model_decision').map((e:any)=>({tick:e.tick,summary:e.summary})),errors:events.filter((e:any)=>e.kind.includes('error')),receiptCount:bundle.payload.receipts.length,bundleHash:bundle.sha256}));
 }
 const recordings=await(await app.request('/api/recordings')).json();
 fs.writeFileSync('evidence/video/native-recordings.json',JSON.stringify(recordings,null,2));
 console.log(JSON.stringify({recordings,budget:ov.budget??ov.platform?.budget??null}));
} finally {await app.close();}
