/** Create two dedicated synthetic qualification identities through the installed native APIs. */
import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
import {installationAdmin} from './admin-client';
import {operatorClient,binding} from './operator-client';
import {KamiwazaClient} from '../../src/platform';
const file='data/platform/team-qualification-users.json';
type User={username:string;email:string;password:string;role:'commander'|'intelligence';id?:string;subject?:string;member?:boolean};
const users:User[]=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):['commander','intelligence'].map(role=>({username:`replay-qual-${role}`,email:`replay-qual-${role}@example.com`,password:randomBytes(24).toString('base64url'),role:role as User['role']}));
const save=()=>fs.writeFileSync(file,JSON.stringify(users),{mode:0o600});save();
const admin=await installationAdmin(),op=await operatorClient(),c=op.resolved.platformClient as KamiwazaClient,room=binding.workroom.id;
const receipts:unknown[]=[];
try{
 for(const u of users){
  if(!u.id){
   const existing=await admin.client.request<any[]>({method:'GET',path:'/auth/users/'});
   if(existing.data.some(v=>v.username===u.username))throw new Error('Qualification username already exists without a recorded private binding; refusing to alter it');
   // Installed 1.2 local-store default is the real realm role "user". "authenticated"
   // describes authorization state, not a provisionable Keycloak realm role.
   const created=await admin.client.request<any>({method:'POST',path:'/auth/users/local',body:{username:u.username,email:u.email,password:u.password,roles:['user']}});
   if(typeof created.data.id!=='string')throw new Error('Native user creation returned no durable ID');
   u.id=created.data.id;save();receipts.push({action:'created-local-qualification-user',subject:u.id,receipt:created.receipt});
  }
  if(!u.subject){
   let token='';const userClient=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,forwardedHost:'kamiwaza-harness.localhost'});
   try{token=(await userClient.login({username:u.username,password:u.password})).data.access_token;const signed=await userClient.me();u.subject=signed.identity.userId;save();receipts.push({action:'resolved-native-sign-in-subject',localAccount:u.id,subject:u.subject,receipt:signed.receipt});}
   finally{token='';}
  }
  if(!u.member){
   // Installed source performs known-user lookup + durable native membership; no outbound invitation delivery.
   const members=await c.request<any>({method:'GET',path:`/workrooms/${room}/members`,workroomId:room});
   let existingMember=members.data.items.find((m:any)=>m.user_id===u.subject&&m.active&&m.role==='editor');
   if(!existingMember){const added=await c.request<any>({method:'POST',path:`/workrooms/${room}/members`,body:{email:u.email,role:'editor',attested:true},workroomId:room});existingMember=added.data;receipts.push({action:'native-editor-membership',subject:u.subject,receipt:added.receipt});}
   if(existingMember.user_id!==u.subject)throw new Error('Native membership resolved an unexpected signed-in subject');
   u.member=true;save();
  }
 }
 const current=await c.request<any>({method:'GET',path:`/workrooms/${room}`,workroomId:room});
 const attrs={...current.data.attributes},profiles={...attrs.replay_profiles};
 for(const u of users)profiles[u.subject!]={role:u.role,name:`Qualification ${u.role}`,organization:'REPLAY synthetic team qualification'};
 const updated=await c.request({method:'PATCH',path:`/workrooms/${room}`,body:{attributes:{...attrs,replay_profiles:profiles}},workroomId:room});
 receipts.push({action:'operator-scenario-profiles',receipt:updated.receipt});
 const evidence={at:new Date().toISOString(),workroomId:room,syntheticQualificationOnly:true,identities:users.map(u=>({subject:u.subject,localAccountId:u.id,username:u.username,scenarioRole:u.role,nativeRole:'editor'})),receipts};
 fs.writeFileSync('evidence/platform/team-identities.json',JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
}finally{admin.close();op.sessions.close();}
