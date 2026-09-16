/** Actual member API/catalog qualification for the private Tomo envelope compatibility image. */
import fs from 'node:fs';import assert from 'node:assert/strict';
import {KamiwazaClient} from '../../src/platform';
import {buildForwardAuthHeaders,extractSignedIdentity} from '../../src/platform/forward-auth';
const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
let credentials=users.find((u:any)=>u.role==='commander');let token='';
const core=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,workroomId:binding.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
const receipts:any[]=[];
async function request(path:string){
 const validate=await fetch(binding.apiBase+'/auth/forward/validate',{headers:buildForwardAuthHeaders({token,method:'GET',uri:'/runtime/apps/replay-tomo'+path,host:'kamiwaza-harness.localhost',proto:'https',workroomId:binding.workroom.id}),redirect:'error',signal:AbortSignal.timeout(15000)});
 assert.equal(validate.status,200,'Core ForwardAuth must admit the member');const signed=extractSignedIdentity(validate.headers);
 assert.equal(signed.identity.workroomId,binding.workroom.id);
 const r=await fetch('http://127.0.0.1:5185'+path,{headers:{Authorization:`Bearer ${token}`,...signed.forwardHeaders},redirect:'error',signal:AbortSignal.timeout(30000)});
 const body=await r.json() as any;receipts.push({path,status:r.status,identity:signed.identity,signatureTs:signed.signatureTs,body});return {r,body};
}
try{
 token=(await core.login(credentials)).data.access_token;for(const u of users)u.password='';credentials=null;
 const entered=await core.enterWorkroom(binding.workroom.id);if(entered.data.access_token)token=entered.data.access_token;
 const me=await request('/api/auth/me');assert.equal(me.r.status,200);
 const catalog=await request('/api/agents/capability-catalog');
 const replay=catalog.body.tools.filter((t:any)=>t.server_id==='replay-tools_replay');assert.equal(catalog.r.status,200);assert.equal(replay.length,6);assert(replay.every((t:any)=>t.capability==='read'));assert.equal(me.body.role,'member');
 const admin=await request('/api/ops/kamiwaza-tools');assert.equal(admin.r.status,403);
 const unauth=await fetch('http://127.0.0.1:5185/api/auth/me',{signal:AbortSignal.timeout(15000)});assert.equal(unauth.status,401);
 const proof={at:new Date().toISOString(),runtime:'Supplied Tomo Kaizen0.4.1/release1.2.0 with private seven-header envelope.1 compatibility patch',transport:'Calling commander login/workroom entry; actual Core ForwardAuth for each target; unchanged signed envelope sent to actual Tomo API through private localhost tunnel',receipts,readToolsDiscovered:replay.map((t:any)=>t.id),ordinaryMemberAdminDenied:true,missingEnvelopeDenied:true,conversation:false,inferenceRequested:false};
 const content=JSON.stringify(proof,null,2);assert(!content.includes(token));
 fs.writeFileSync('evidence/platform/tomo-native-member-1.2.0-envelope.1.json',content+'\n',{flag:'wx'});console.log(content);
}finally{if(token)try{await core.leaveWorkroom();}catch{}token='';}
