/** Copy one known Commander-owned recording through normal app login. No inference or existing-file overwrite. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';
const [id='',name='',exerciseId='']=process.argv.slice(2);
assert(process.argv.length===5 && /^[a-f0-9-]{36}$/.test(id) && /^[a-f0-9-]{36}$/.test(exerciseId) && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(name),'Expected recording UUID, fresh basename and owning exercise UUID');
const video=`evidence/video/${name}.webm`, receipt=`evidence/video/${name}-capture.json`;
assert(!fs.existsSync(video)&&!fs.existsSync(receipt),'Preserve existing capture');
const credentials=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8')).filter((u:any)=>u.role==='commander');
assert.equal(credentials.length,1);
const client=await nativeAppClient(credentials[0]);credentials[0].password='';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
try{
 const selected=await(await client.request('/api/select',{exerciseId},{signal:AbortSignal.timeout(15000)})).json() as any;assert.equal(selected.selected,exerciseId);
 const records=await(await client.request('/api/recordings',undefined,{signal:AbortSignal.timeout(15000)})).json() as any[];
 const record=records.find(r=>r.id===id);assert(record&&record.ext==='webm'&&record.type==='video/webm'&&record.exerciseId===exerciseId);
 assert(record.bytes>0&&record.bytes<=128*1024*1024);
 const bytes=Buffer.from(await(await client.request(`/api/recordings/${id}/media`,undefined,{signal:AbortSignal.timeout(30000)})).arrayBuffer());
 assert.equal(bytes.length,record.bytes);assert.equal(sha(bytes),record.sha256);
 const {subject,...publicRecord}=record;
 const proof={at:new Date().toISOString(),recording:{...publicRecord,subjectSha256:sha(subject)},video,newInferenceCalls:0,serverDigestMatched:true,contentTypeVerified:true,timing:'Server metadata reports client timing; decoded media timing must be checked separately.'};
 fs.writeFileSync(video,bytes,{flag:'wx'});fs.writeFileSync(receipt,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({video,receipt,bytes:bytes.length,sha256:record.sha256,reportedDurationMs:record.durationMs}));
}finally{await client.close();}
