/** Free native model-catalog checks for two actual member identities. No chat/model inference. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {KamiwazaClient} from '../../src/platform';
const version=process.argv[2],phase=process.argv[3];assert.match(version??'',/^\d+\.\d+\.\d+$/);assert(['commander','both'].includes(phase));
const artifact=`evidence/platform/tomo-member-model-routes-${version}-${phase}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
const b=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8')),conf=JSON.parse(fs.readFileSync('data/platform/tomo-conversation.json','utf8')),users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const proof:any={at:new Date().toISOString(),version,phase,status:'running',members:[],inferenceRequests:0,exerciseWrites:0};
try{
 const build=await(await fetch('http://127.0.0.1:5183/replay-build.json')).json() as any;assert.equal(build.version,version);proof.sourceSha256=build.sourceArchive.sha256;
 const path=`/internal/tomo-native-route/runtime/models/${conf.deploymentId}/v1/models`,url='http://127.0.0.1:5183'+path;
 const anon=await fetch(url,{signal:AbortSignal.timeout(20000)});assert.equal(anon.status,401);await anon.body?.cancel();proof.anonymousStatus=anon.status;
 for(const role of ['commander','intelligence']){
  const u=users.find((x:any)=>x.role===role);assert(u?.password);let token='',entered=false;
  const core=new KamiwazaClient({apiBase:b.apiBase,getToken:()=>token,workroomId:b.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
  try{
   token=(await core.login({username:u.username,password:u.password})).data.access_token;u.password='';const entry=await core.enterWorkroom(b.workroom.id);entered=true;if(entry.data.access_token)token=entry.data.access_token;
   const expected=role==='commander'||phase==='both'?200:403;
   const response=await fetch(url,{headers:{authorization:'Bearer '+token,'x-workroom-id':b.workroom.id},signal:AbortSignal.timeout(20000)});assert.equal(response.status,expected);
   const data=await response.json() as any;if(expected===200)assert.equal(data.data?.[0]?.id,'replay-tomo-luna');
   proof.members.push({role,subject:u.subject,status:response.status,model:expected===200?data.data[0].id:null});
  }finally{try{if(entered)await core.leaveWorkroom();}finally{token='';}}
 }
 proof.status='passed';
}catch{proof.status='failed';proof.failure='Native member model-catalog check failed';process.exitCode=1;}
finally{for(const u of users)u.password='';fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({artifact,status:proof.status,members:proof.members,inferenceRequests:0}));}
