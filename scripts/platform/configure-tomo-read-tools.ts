/** Configure only the six discovered REPLAY reads through Tomo's actual admin API. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {KamiwazaClient} from '../../src/platform';import {buildForwardAuthHeaders,extractSignedIdentity} from '../../src/platform/forward-auth';
const artifact='evidence/platform/tomo-read-tool-selection-1.2.0-envelope.1.json';assert(!fs.existsSync(artifact));
const b=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));let token='';
const core=new KamiwazaClient({apiBase:b.apiBase,getToken:()=>token,workroomId:b.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
let raw=execFileSync('podman',['machine','ssh','kamiwaza-harness-poc',"sudo k0s kubectl get secret kamiwaza-user-admin -n kamiwaza -o jsonpath='{.data.password}'"],{encoding:'utf8',stdio:['ignore','pipe','pipe']});let password=Buffer.from(raw.trim(),'base64').toString();raw='';
const receipts:any[]=[];
async function request(method:'GET'|'PUT',body?:unknown){
 const path='/api/ops/kamiwaza-tools';
 const v=await fetch(b.apiBase+'/auth/forward/validate',{headers:buildForwardAuthHeaders({token,method,uri:'/runtime/apps/replay-tomo'+path,host:'kamiwaza-harness.localhost',proto:'https',workroomId:b.workroom.id}),signal:AbortSignal.timeout(15000)});assert.equal(v.status,200);
 const signed=extractSignedIdentity(v.headers);assert(signed.identity.roles.includes('admin'));assert.equal(signed.identity.workroomId,b.workroom.id);
 const r=await fetch('http://127.0.0.1:5185'+path,{method,headers:{Authorization:`Bearer ${token}`,...signed.forwardHeaders,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});
 const value=await r.json() as any;assert.equal(r.status,200,JSON.stringify(value));receipts.push({method,path,status:r.status,identity:signed.identity,signatureTs:signed.signatureTs});return value;
}
try{
 token=(await core.login({username:'admin',password})).data.access_token;password='';
 const entered=await core.enterWorkroom(b.workroom.id);if(entered.data.access_token)token=entered.data.access_token;
 const before=await request('GET');const selected=before.items.filter((t:any)=>t.server_id==='replay-tools_replay');
 const expected=['list_exercises','get_exercise_state','get_station_objectives','get_team_assessments','get_key_moments','get_replay_provenance'];
 assert.deepEqual(selected.map((t:any)=>t.tool_name).sort(),expected.sort());assert(selected.every((t:any)=>t.capability==='read'&&!t.requires_confirm));
 const updated=await request('PUT',{tool_names:selected.map((t:any)=>t.id),enabled:true,cascade:false,expected_version:before.version});
 const after=await request('GET');const replay=after.items.filter((t:any)=>t.server_id==='replay-tools_replay');assert.equal(replay.length,6);assert(replay.every((t:any)=>t.enabled));
 for(const old of before.items.filter((t:any)=>t.server_id!=='replay-tools_replay'))assert.equal(after.items.find((t:any)=>t.id===old.id)?.enabled,old.enabled,'Unrelated tool setting changed');
 const proof={at:new Date().toISOString(),discovered:after.items.length,beforeVersion:before.version,afterVersion:after.version,selected:replay,update:updated,receipts,unrelatedToolSettingsPreserved:true,inferenceRequested:false,limitations:['Administrator configuration, not a member conversation or model tool choice.']};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
}finally{password='';if(token)try{await core.leaveWorkroom();}catch{}token='';}
