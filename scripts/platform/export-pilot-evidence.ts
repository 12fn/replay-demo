import fs from 'node:fs';import {nativeAppClient} from './native-app-client';
const app=await nativeAppClient();try{
 await app.request('/api/select',{exerciseId:'467bdded-c0f0-4dee-bdd0-14804f53350b'});
 fs.mkdirSync('evidence/pilot',{recursive:true});
 for(const [route,file] of [['/api/review/export.json','instructor-bundle.json'],['/api/review/export.md','instructor-review.md'],['/api/learning/dossier.md','personal-dossier.md'],['/api/recordings','native-recordings.json'],['/api/agents/tools','current-tools-and-budget.json']]) {
  const body=await(await app.request(route)).text();fs.writeFileSync('evidence/pilot/'+file,body);
 }
 const b=JSON.parse(fs.readFileSync('evidence/pilot/instructor-bundle.json','utf8'));
 console.log(JSON.stringify({exerciseId:b.payload.exercise.id,fingerprint:b.payload.engine.fingerprint,judgments:b.payload.assessment.history.map((j:any)=>({id:j.id,disposition:j.disposition,score:j.score,version:j.version,rationale:j.rationale})),receipts:b.payload.receipts.length,sha256:b.sha256}));
}finally{await app.close();}
