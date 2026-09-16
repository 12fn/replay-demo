/** Installation-only administration using the existing local installer account. */
import {execFileSync} from 'node:child_process';
import {KamiwazaClient} from '../../src/platform/index';
import {binding} from './operator-client';
export async function installationAdmin(){
 let raw=execFileSync('podman',['machine','ssh','kamiwaza-harness-poc',"sudo k0s kubectl get secret kamiwaza-user-admin -n kamiwaza -o jsonpath='{.data.password}'"],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 let password=Buffer.from(raw.trim(),'base64').toString('utf8');raw='';let token='';
 const client=new KamiwazaClient({apiBase:binding.apiBase,getToken:()=>token,forwardedHost:'kamiwaza-harness.localhost'});
 try{const login=await client.login({username:'admin',password});token=login.data.access_token;}finally{password='';}
 return {client,close:()=>{token='';}};
}
