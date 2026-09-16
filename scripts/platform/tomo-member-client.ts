/** Temporary operator connection to private Tomo using the named member's actual signed authority. */
import fs from 'node:fs';import {KamiwazaClient} from '../../src/platform';import {buildForwardAuthHeaders,extractSignedIdentity} from '../../src/platform/forward-auth';
export async function tomoMemberClient(role='commander'){
 const b=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));const user=users.find((u:any)=>u.role===role);if(!user)throw new Error('Qualification member not found');let token='';
 const core=new KamiwazaClient({apiBase:b.apiBase,getToken:()=>token,workroomId:b.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
 try{token=(await core.login({username:user.username,password:user.password})).data.access_token;const entered=await core.enterWorkroom(b.workroom.id);if(entered.data.access_token)token=entered.data.access_token;}finally{for(const u of users)u.password='';}
 return {async request(method:'GET'|'POST'|'PUT',path:string,body?:unknown){
  if(!path.startsWith('/api/'))throw new Error('Expected Tomo API path');
  const check=await fetch(b.apiBase+'/auth/forward/validate',{headers:buildForwardAuthHeaders({token,method,uri:'/runtime/apps/replay-tomo'+path,host:'kamiwaza-harness.localhost',proto:'https',workroomId:b.workroom.id}),signal:AbortSignal.timeout(15000)});if(check.status!==200)throw new Error('Native Tomo authority refused');
  const signed=extractSignedIdentity(check.headers);if(signed.identity.workroomId!==b.workroom.id)throw new Error('Unexpected signed workroom');
  const r=await fetch('http://127.0.0.1:5185'+path,{method,headers:{authorization:'Bearer '+token,...signed.forwardHeaders,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const data=await r.json();if(!r.ok)throw new Error(`Tomo ${method} returned HTTP ${r.status}`);
  return {data,receipt:{method,path,status:r.status,subject:signed.identity.userId,workroomId:signed.identity.workroomId,signatureTs:signed.signatureTs}};
 },async close(){try{await core.leaveWorkroom();}finally{token='';}}};
}
