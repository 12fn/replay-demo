/** Narrow durable Tomo conversation entry. No automatic input retries or room creation. */
import {watchTomoStreamAuthority} from './tomo-stream-authority';
import express from 'express';import {once} from 'node:events';
import type {NativeSessionPort} from './native-http';import {NativeSessionError} from './native-session';
import {KamiwazaError,type RequestReceipt} from '../platform';
import {legacyTomoBindings,sameTomoBinding,type TomoBindingResolver} from './tomo-pilot-bindings';
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const CONVERSATION_ID=`(?:[a-f0-9]{32}|${UUID})`;
const INPUT=new RegExp(`^/api/conversations/(${CONVERSATION_ID})/inputs$`),EVENTS=new RegExp(`^/api/conversations/(${CONVERSATION_ID})/events$`);
export interface TomoConversationOptions {
 streamAuthorityIntervalMs?:number;
 native:NativeSessionPort;apiOrigin:string;modelId:string;agentId?:string;toolNames:readonly string[];subjects:readonly string[];
 /** Per-subject helper binding; defaults to `subjects`/`agentId`. Must be the same resolver given to the native model route. */
 bindings?:TomoBindingResolver;
 onDispatch?:(event:{at:string;path:string;subject:string;status:number;receipt:RequestReceipt;conversationId:string|null;inputId:string|null})=>void;
}
class EntryError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
const object=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
async function bodyOf(req:express.Request):Promise<unknown>{
 let bytes=0;const chunks:Buffer[]=[];
 for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>16384)throw new EntryError(413,'tomo_input_too_large');chunks.push(b);}
 if(!bytes)return undefined;
 if(!req.is('application/json'))throw new EntryError(415,'tomo_json_required');
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new EntryError(400,'tomo_invalid_json');}
}
export function createTomoConversationEntry(opts:TomoConversationOptions):express.Router {
 if(!new RegExp(`^${UUID}$`).test(opts.modelId)||!opts.bindings&&!opts.subjects.length)throw new Error('Tomo model deployment and pilot subjects required');
 const allowedTools=new Set(opts.toolNames),bindings=opts.bindings??legacyTomoBindings({subjects:opts.subjects,agentId:opts.agentId});const router=express.Router();
 router.use(async(req,res,next)=>{
  const post=req.method==='POST'&&(req.path==='/api/conversations'||INPUT.test(req.path));
  const events=req.method==='GET'&&EVENTS.test(req.path);
  if(!post&&!events)return next();
  const controller=new AbortController();res.on('close',()=>controller.abort());
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-REPLAY-Tomo-Mode':'scoped-conversation'});
  let cancel:(()=>void)|undefined;
  try{
   const cookies=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('replay_session='));
   const sessionId=cookies.length===1?cookies[0].slice(15):'';
   if(!new RegExp(`^${UUID}$`).test(sessionId))throw new EntryError(401,'signed_out');
   if(post){
    const origin=req.headers.origin;
    let parsed:URL;try{if(typeof origin!=='string')throw new Error();parsed=new URL(origin);}catch{throw new EntryError(403,'tomo_cross_origin');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.origin!==origin||parsed.host!==req.headers.host||req.headers['sec-fetch-site']==='cross-site')throw new EntryError(403,'tomo_cross_origin');
    if(req.url!==req.path)throw new EntryError(400,'tomo_query_not_supported');
   }
   const member=await opts.native.resolve(sessionId,{fresh:true,...(post?{requireWrite:true,requireAgents:true}:{})});
   const bound=await bindings.resolve({subject:member.identity.subject,workroomId:member.context.workroomId});
   if(bound.state==='registry-invalid')throw new EntryError(503,'tomo_binding_registry_invalid');
   if(bound.state!=='bound')throw new EntryError(403,'tomo_pilot_not_enabled');
   const agentId=bound.binding.agentId;
   const renew=async()=>{
    const fresh=await opts.native.resolve(sessionId,{fresh:true,...(post?{requireWrite:true,requireAgents:true}:{})});
    if(fresh.identity.subject!==member.identity.subject||fresh.context.workroomId!==member.context.workroomId)throw new EntryError(403,'tomo_identity_changed');
    if(!sameTomoBinding(bound,await bindings.resolve({subject:fresh.identity.subject,workroomId:fresh.context.workroomId})))throw new EntryError(403,'tomo_binding_changed');
    return fresh;
   };
   if(post){
    const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[\x21-\x7e]{1,200}$/.test(key))throw new EntryError(400,'tomo_idempotency_required');
    const b=await bodyOf(req);let body:unknown=undefined;
    if(req.path==='/api/conversations'){
     if(b!==undefined&&(!object(b)||Object.keys(b).length))throw new EntryError(400,'tomo_create_body_not_supported');
    }else{
     if(!object(b))throw new EntryError(400,'tomo_input_required');
     if(b.kind==='stop'||b.kind==='cancel'){
      if(Object.keys(b).some(k=>k!=='kind'))throw new EntryError(400,'tomo_control_options_not_supported');body={kind:b.kind};
     }else{
      const fields=['kind','message','model','agent','platform_tool_names','connector_ids','subagent_ids','resource_reference_ids','effort','approval_mode','approval_risk_acknowledged'];
      if(Object.keys(b).some(k=>!fields.includes(k))||b.kind!=='message'||typeof b.message!=='string'||!b.message.trim()||Buffer.byteLength(b.message)>8192)throw new EntryError(400,'tomo_message_not_supported');
      if(b.model!=null&&b.model!==opts.modelId)throw new EntryError(400,'choose_replay_model');
      if(agentId?b.agent!==agentId:b.agent!=null&&b.agent!=='default')throw new EntryError(400,'choose_replay_agent');
      for(const key of ['connector_ids','subagent_ids','resource_reference_ids'])if(b[key]!=null&&(!Array.isArray(b[key])||b[key].length))throw new EntryError(400,'tomo_capability_not_enabled');
      if(b.approval_mode!=null||b.approval_risk_acknowledged===true)throw new EntryError(400,'tomo_approval_override_not_supported');
      const requested=b.platform_tool_names??opts.toolNames;
      if(!Array.isArray(requested)||requested.some(t=>typeof t!=='string'||!allowedTools.has(t)))throw new EntryError(403,'tomo_tool_not_enabled');
      body={kind:'message',message:b.message,model:opts.modelId,agent:agentId??'default',platform_tool_names:[...new Set(requested)],connector_ids:[],subagent_ids:[],resource_reference_ids:[],effort:'low'};
     }
    }
    const current=await renew();const invoke=current.platformClient.runtimeInvoke?.bind(current.platformClient);if(!invoke)throw new EntryError(503,'tomo_transport_unavailable');
    const result=await invoke({extension:'replay-tomo',origin:opts.apiOrigin,path:req.path,subject:current.identity.subject,body,idempotencyKey:key});
    let data:unknown;try{data=JSON.parse(Buffer.from(result.body).toString());}catch{data=null;}
    const safeId=(v:unknown)=>typeof v==='string'&&new RegExp(`^${CONVERSATION_ID}$`).test(v)?v:null;
    opts.onDispatch?.({at:new Date().toISOString(),path:req.path,subject:current.identity.subject,status:result.status,receipt:result.receipt,conversationId:INPUT.exec(req.path)?.[1]??(object(data)?safeId(data.id):null),inputId:object(data)?safeId(data.input_id):null});
    await renew();if(result.status>=300&&result.status<400)throw new EntryError(502,'tomo_redirect_refused');
    res.status(result.status).set('Content-Type',result.contentType).send(Buffer.from(result.body));return;
   }
   const url=new URL(req.url,'http://tomo.invalid'),keys=[...url.searchParams.keys()];
   if(keys.some(k=>k!=='after')||url.searchParams.getAll('after').length>1)throw new EntryError(400,'tomo_event_cursor_invalid');
   const query=url.searchParams.get('after'),last=req.headers['last-event-id'];
   if(Array.isArray(last)||last!==undefined&&!/^\d{1,15}$/.test(last)||query!==null&&!/^\d{1,15}$/.test(query)||last!==undefined&&query!==null&&last!==query)throw new EntryError(400,'tomo_event_cursor_invalid');
   const after=query??last??'0';
   const stream=member.platformClient.runtimeEvents?.bind(member.platformClient);if(!stream)throw new EntryError(503,'tomo_transport_unavailable');
   const result=await stream({extension:'replay-tomo',origin:opts.apiOrigin,path:req.path+'?after='+after,subject:member.identity.subject,signal:controller.signal});cancel=result.cancel;
   if(result.status!==200||!result.contentType.startsWith('text/event-stream'))throw new EntryError(502,'tomo_events_unavailable');
   await renew();res.status(200).set({'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.flushHeaders();
   const reader=result.body.getReader();let bytes=0;
   const stopAuthorityWatch=watchTomoStreamAuthority(renew,()=>{controller.abort();cancel?.();void reader.cancel().catch(()=>{});res.end();},opts.streamAuthorityIntervalMs);
   try{while(!controller.signal.aborted){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>64*1024*1024)break;await renew();if(controller.signal.aborted)break;if(!res.write(chunk.value))await once(res,'drain',{signal:controller.signal});}}finally{stopAuthorityWatch();await reader.cancel().catch(()=>{});reader.releaseLock();}
   res.end();
  }catch(error){
   if(res.headersSent){res.end();return;}
   const status=error instanceof EntryError?error.status:error instanceof NativeSessionError?error.httpStatus:error instanceof KamiwazaError&&[401,403].includes(error.httpStatus??0)?error.httpStatus!:502;
   res.status(status).json({error:{code:error instanceof EntryError?error.code:'tomo_conversation_unavailable',message:error instanceof EntryError&&error.code==='choose_replay_agent'?'Choose REPLAY evidence observer.':error instanceof EntryError&&error.code==='choose_replay_model'?'Choose REPLAY Tomo capped Luna.':'Tomo conversation request could not complete.'}});
  }finally{cancel?.();controller.abort();}
 });
 return router;
}
