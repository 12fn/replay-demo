/** Local runtime routing for the installed Core when the optional Istio gateway is absent. */
import {watchTomoStreamAuthority} from './tomo-stream-authority';
import express from 'express';import {once} from 'node:events';
import {openNativeModelRuntime} from '../platform/model-runtime';import {KamiwazaError,type RequestReceipt} from '../platform';
import {McpAuthError,type McpAuthPort,type McpPrincipal} from './mcp-auth';
import {legacyTomoBindings,sameTomoBinding,type TomoBindingResolution,type TomoBindingResolver} from './tomo-pilot-bindings';
export interface TomoNativeRouteOptions {
 streamAuthorityIntervalMs?:number;
 auth:McpAuthPort;apiBase:string;forwardedHost:string;forwardedProto?:string;deploymentId:string;servePath:string;subjects:readonly string[];
 /** Per-subject helper binding; defaults to `subjects`. Must be the same resolver given to the conversation entry. */
 bindings?:TomoBindingResolver;
 transport?:typeof openNativeModelRuntime;
 onAudit?:(event:{at:string;subject:string;workroomId:string;deploymentId:string;method:string;nativeReceipt:RequestReceipt;memberRequestIds:string[];completed:boolean})=>void;
}
class RouteError extends Error{constructor(readonly status:number){super('Native model route unavailable');}}
export function createTomoNativeModelRoute(opts:TomoNativeRouteOptions):express.Router {
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 if(!uuid.test(opts.deploymentId)||!uuid.test(opts.servePath.slice(1))||!opts.servePath.startsWith('/')||!opts.bindings&&!opts.subjects.length)throw new Error('Native model route requires a verified deployment/serve-path pair and pilot subjects');
 const prefix=`/runtime/models/${opts.deploymentId}/v1`,bindings=opts.bindings??legacyTomoBindings({subjects:opts.subjects}),router=express.Router();
 router.use(async(req,res)=>{
  const method=req.method;if(req.url!==req.path||!((method==='GET'&&req.path===prefix+'/models')||(method==='POST'&&req.path===prefix+'/chat/completions')))return res.status(404).end();
  const abort=new AbortController();const lifetime=setTimeout(()=>{abort.abort();res.destroy();},90000);res.on('close',()=>abort.abort());let cancel:(()=>void)|undefined,token='',principal:McpPrincipal|undefined,bound:TomoBindingResolution|undefined,receipt:RequestReceipt|undefined,completed=false;const memberRequestIds:string[]=[];
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-REPLAY-Native-Route':'core-forward-auth'});
  const renew=async()=>{const fresh=await opts.auth.resolve(req.headers);if(fresh.context.workroomId!==opts.auth.workroomId||!fresh.context.fresh||fresh.context.accessState!=='active'||!fresh.context.canRunAgents||principal&&fresh.identity.subject!==principal.identity.subject)throw new RouteError(403);
   const binding=await bindings.resolve({subject:fresh.identity.subject,workroomId:fresh.context.workroomId});if(binding.state==='registry-invalid')throw new RouteError(503);if(binding.state!=='bound'||bound&&!sameTomoBinding(bound,binding))throw new RouteError(403);bound??=binding;for(const r of fresh.nativeReceipts)if(r.requestId)memberRequestIds.push(r.requestId);return fresh;};
  try{
   principal=await renew();const auth=req.headers.authorization;if(typeof auth!=='string'||!/^Bearer [^\s]+$/i.test(auth))throw new RouteError(401);token=auth.slice(7);
   let body:unknown;
   if(method==='POST'){
    if(!req.is('application/json'))throw new RouteError(415);const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw new RouteError(413);chunks.push(Buffer.from(chunk));}
    try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new RouteError(400);}if(!body||typeof body!=='object'||Array.isArray(body))throw new RouteError(400);
   }
   await renew();
   const result=await(opts.transport??openNativeModelRuntime)({apiBase:opts.apiBase,workroomId:opts.auth.workroomId,forwardedHost:opts.forwardedHost,forwardedProto:opts.forwardedProto,deploymentId:opts.deploymentId,servePath:opts.servePath,subject:principal.identity.subject,token,method,body,signal:abort.signal});cancel=result.cancel;receipt=result.receipt;
   if(result.status!==200)throw new RouteError([400,401,403,429].includes(result.status)?result.status:502);
   const media=result.contentType.split(';')[0].trim().toLowerCase();if(!(method==='GET'?media==='application/json':['application/json','text/event-stream'].includes(media)))throw new RouteError(502);
   await renew();res.status(200).set({'Content-Type':result.contentType,'X-Accel-Buffering':'no'});res.flushHeaders();
   const reader=result.body.getReader();const stopAuthorityWatch=watchTomoStreamAuthority(renew,()=>{abort.abort();cancel?.();void reader.cancel().catch(()=>{});res.end();},opts.streamAuthorityIntervalMs);try{while(!abort.signal.aborted){const x=await reader.read();if(x.done){completed=!abort.signal.aborted;break;}await renew();if(abort.signal.aborted)break;if(!res.write(x.value))await once(res,'drain',{signal:abort.signal});}}finally{stopAuthorityWatch();await reader.cancel().catch(()=>{});reader.releaseLock();}res.end();
  }catch(e){if(res.headersSent)res.end();else res.status(e instanceof RouteError?e.status:e instanceof McpAuthError?e.httpStatus:e instanceof KamiwazaError&&[401,403].includes(e.httpStatus??0)?e.httpStatus!:502).json({error:{code:'native_model_route_unavailable',message:'The authorized native model route could not complete.'}});}
  finally{clearTimeout(lifetime);cancel?.();abort.abort();token='';if(receipt&&principal)opts.onAudit?.({at:new Date().toISOString(),subject:principal.identity.subject,workroomId:opts.auth.workroomId,deploymentId:opts.deploymentId,method,nativeReceipt:receipt,memberRequestIds:[...new Set(memberRequestIds)],completed});}
 });return router;
}
