/** Authorized local operator bridge. Secrets stay in memory or encrypted local storage. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {NativeSessions} from '../../src/server/native-session';
export const binding=JSON.parse(fs.readFileSync('data/kamiwaza-binding.json','utf8'));
export async function operatorClient(){
 const dataDir=path.resolve('data/platform/operator-session');fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const idFile=path.join(dataDir,'session-id');let id=fs.existsSync(idFile)?fs.readFileSync(idFile,'utf8').trim():randomUUID();
 const sessions=new NativeSessions({dataDir,apiBase:binding.apiBase,workroomId:binding.workroom.id,forwardedHost:'kamiwaza-harness.localhost'});
 try{return {sessions,id,resolved:await sessions.resolve(id,{requireWrite:true})};}catch(error){
  if((error as any).code!=='signed_out')throw error;
 }
 let raw=execFileSync('podman',['machine','ssh','kamiwaza-harness-poc',"sudo k0s kubectl get secret kamiwaza-user-poc-viewer -n kamiwaza -o jsonpath='{.data.password}'"],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 let password=Buffer.from(raw.trim(),'base64').toString('utf8');raw='';
 try{await sessions.login(id,{username:'poc-viewer',password});}finally{password='';}
 fs.writeFileSync(idFile,id,{mode:0o600});
 return {sessions,id,resolved:await sessions.resolve(id,{requireWrite:true})};
}
