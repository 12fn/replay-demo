/** Integration client for the application's normal native login. It never reuses browser cookies. */
import {execFileSync} from 'node:child_process';
export async function nativeAppClient(credentials?:{username:string;password:string}){
 const base='http://127.0.0.1:5183';let cookie='';
 const requestRaw=async(path:string,body?:unknown,options?:{idempotencyKey?:string;afterCursor?:string;signal?:AbortSignal})=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',signal:options?.signal,headers:{Origin:base,...(options?.idempotencyKey?{'Idempotency-Key':options.idempotencyKey}:{}),...(options?.afterCursor?{'Last-Event-ID':options.afterCursor}:{}),...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const next=r.headers.get('set-cookie');if(next)cookie=next.split(';')[0];return r;};
 const request=async(path:string,body?:unknown,options?:{idempotencyKey?:string;afterCursor?:string;signal?:AbortSignal})=>{const r=await requestRaw(path,body,options);if(!r.ok)throw new Error(`Application request ${path} failed: HTTP ${r.status}`);return r;};
 let password=credentials?.password??'';
 if(!credentials){let raw=execFileSync('podman',['machine','ssh','kamiwaza-harness-poc',"sudo k0s kubectl get secret kamiwaza-user-poc-viewer -n kamiwaza -o jsonpath='{.data.password}'"],{encoding:'utf8',stdio:['ignore','pipe','pipe']});password=Buffer.from(raw.trim(),'base64').toString('utf8');raw='';}
 try{await request('/api/native/login',{username:credentials?.username??'poc-viewer',password});}finally{password='';}
 return {request,requestRaw,close:async()=>{try{await request('/api/native/logout',{});}finally{cookie='';}}};
}
