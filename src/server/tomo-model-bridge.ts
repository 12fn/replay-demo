/**
 * Bounded Chat Completions facade with explicit member or delegated serving authority.
 * Not mounted by default. Native model registration and browser writes are separate gates.
 * The provider completes once; requested SSE is emitted afterward (no token-streaming claim).
 */
import express from 'express';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {InferenceError} from '../inference/errors';
import type {ChatFailureDiagnostics} from '../inference/chat-failure-diagnostics';
import {MAX_OUTPUT_TOKENS_CEILING} from '../inference/pricing';
import type {Receipt} from '../inference/ledger';
import type {ChatCompleteInput,ChatCompleteResult} from '../inference/luna-chat-client';
import {McpAuthError,type McpAuthPort} from './mcp-auth';

export const TOMO_MODEL_PURPOSE='tomo.model.chat';
export interface TomoModelAudit {
  requestId:string;subject:string;workroomId:string;receiptId:string|null;providerHttpStatus?:number;providerDiagnostics?:ChatFailureDiagnostics;
  authority:'native-member'|'native-serving-workload';requestShape?:{messages?:{role:string;fields:string[];contentType:string;callFields?:string[][]}[];bytes:number;fields:string[];roles:string[];tools:string[]};nativeRequestIds:string[];outcome:'completed'|'failed';code:string|null;
}
export interface TomoModelBridgeOptions {
  auth?:McpAuthPort;
  /** Core external_chat delegates using this dedicated provider credential; never a member identity. */
  workload?:{secret:string;subject:string;workroomId:string};
  luna:{complete(req:ChatCompleteInput):Promise<ChatCompleteResult>};
  ledger:{listReceipts():Receipt[]};
  /** Explicit initial pilot members, never derived from request headers. */
  subjects?:readonly string[];
  /** Exact configured callable IDs; catalog selection is not an inference grant. */
  toolNames:readonly string[];
  exposedModel:string;
  maxRequests?:number;
  onAudit?:(event:TomoModelAudit)=>void;
}
class BridgeError extends Error {constructor(readonly status:number,readonly code:string){super(code);}}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);

function requestDigest(value:unknown):string {
 const stable=(x:unknown,depth=0):unknown=>{if(depth>32)throw new BridgeError(400,'invalid_chat_depth');if(Array.isArray(x))return x.map(v=>stable(v,depth+1));if(object(x))return Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,stable(x[k],depth+1)]));return x;};
 return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function createTomoModelBridge(opts:TomoModelBridgeOptions):express.Router {
  if(!/^[A-Za-z0-9_.-]{1,128}$/.test(opts.exposedModel))throw new Error('Invalid exposed model');
  const cap=opts.maxRequests??6;
  if(!Number.isSafeInteger(cap)||cap<1||cap>26)throw new Error('Invalid Tomo request cap');
  if(Boolean(opts.auth)===Boolean(opts.workload))throw new Error('Exactly one model authority mode is required');
  const subjects=new Set(opts.subjects??[]),tools=new Set(opts.toolNames);
  if(opts.workload&&(!opts.workload.subject||!opts.workload.workroomId||opts.workload.secret.length<32))throw new Error('Dedicated serving credential and scope required');
  const secretHash=opts.workload?createHash('sha256').update(opts.workload.secret).digest():null;
  if(opts.auth&&(!subjects.size||[...subjects].some(x=>!x||x.length>128)))throw new Error('Explicit Tomo subjects required');
  if([...tools].some(x=>!/^[A-Za-z0-9_-]{1,200}$/.test(x)))throw new Error('Invalid callable name');
  const router=express.Router();let busy=false;
  type Principal={subject:string;workroomId:string;authority:'native-member'|'native-serving-workload';nativeRequestIds:string[]};
  const resolve=async(headers:express.Request['headers']):Promise<Principal>=>{
    if(opts.workload){
      const auth=headers.authorization;
      if(typeof auth!=='string'||auth.length>16384||!auth.startsWith('Bearer ')||!timingSafeEqual(secretHash!,createHash('sha256').update(auth.slice(7)).digest()))throw new BridgeError(401,'serving_credential_required');
      return {subject:opts.workload.subject,workroomId:opts.workload.workroomId,authority:'native-serving-workload',nativeRequestIds:[]};
    }
    const p=await opts.auth!.resolve(headers);
    if(!subjects.has(p.identity.subject)||p.context.workroomId!==opts.auth!.workroomId||!p.context.fresh||!p.context.canRunAgents||p.context.accessState!=='active')throw new BridgeError(403,'tomo_model_forbidden');
    return {subject:p.identity.subject,workroomId:p.context.workroomId,authority:'native-member',nativeRequestIds:p.nativeReceipts.map(r=>r.requestId).filter((id):id is string=>!!id)};
  };
  const same=(p:Principal,q:Principal)=>{
    if(p.subject!==q.subject||p.workroomId!==q.workroomId||p.authority!==q.authority)throw new BridgeError(403,'tomo_identity_changed');
  };
  const fail=(res:express.Response,error:unknown,receiptId?:string|null)=>{
    // A refusal must not encourage SDK retries. Durable reservation dedupe is still authoritative.
    if(!res.headersSent)res.set('x-should-retry','false');
    const status=error instanceof BridgeError?error.status:error instanceof McpAuthError?error.httpStatus:error instanceof InferenceError?(['request_cap_exceeded','budget_exceeded'].includes(error.code)?429:error.code==='invalid_request'||error.code==='input_too_large'?400:error.code==='provider_error'&&error.httpStatus&&error.httpStatus>=400&&error.httpStatus<500?error.httpStatus:502):502;
    const code=error instanceof BridgeError||error instanceof McpAuthError||error instanceof InferenceError?error.code:'tomo_model_unavailable';
    if(!res.headersSent)res.status(status).json({error:{code,message:'Tomo model request could not complete.',...(receiptId?{receipt_id:receiptId}:{})}});
    else res.end();
  };
  router.use(async(req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    if(!['/models','/chat/completions'].includes(req.path))return res.status(404).end();
    if((req.path==='/models'&&req.method!=='GET')||(req.path==='/chat/completions'&&req.method!=='POST'))return res.status(405).end();
    try{res.locals.tomoPrincipal=await resolve(req.headers);next();}catch(e){fail(res,e);}
  });
  router.get('/models',(_req,res)=>res.json({object:'list',data:[{id:opts.exposedModel,object:'model',owned_by:'replay'}]}));
  router.post('/chat/completions',express.json({limit:'64kb',strict:true}),async(req,res)=>{
    let acquired=false,receiptId:string|null=null,event:TomoModelAudit|undefined;
    const requestId=randomUUID();res.set('X-REPLAY-Request-Id',requestId);
    try{
      const principal=res.locals.tomoPrincipal as Principal;
      event={requestId,subject:principal.subject,workroomId:principal.workroomId,authority:principal.authority,receiptId:null,nativeRequestIds:[...principal.nativeRequestIds],outcome:'failed',code:null};
      const b=req.body;
      if(object(b))event.requestShape={messages:Array.isArray(b.messages)?b.messages.slice(0,128).filter(object).map(m=>({role:['system','developer','user','assistant','tool'].includes(String(m.role))?String(m.role):'unknown',fields:Object.keys(m).filter(k=>/^[A-Za-z_]{1,40}$/.test(k)),contentType:m.content===null?'null':Array.isArray(m.content)?'array':typeof m.content,...(Array.isArray(m.tool_calls)?{callFields:m.tool_calls.slice(0,64).filter(object).map(c=>Object.keys(c).filter(k=>/^[A-Za-z_]{1,40}$/.test(k)))}:{})})):[],bytes:Buffer.byteLength(JSON.stringify(b)),fields:Object.keys(b).filter(k=>/^[A-Za-z_]{1,40}$/.test(k)),roles:Array.isArray(b.messages)?b.messages.map(m=>object(m)&&['system','developer','user','assistant','tool'].includes(String(m.role))?String(m.role):'unknown'):[],tools:Array.isArray(b.tools)?b.tools.map(t=>object(t)&&object(t.function)&&typeof t.function.name==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(t.function.name)?t.function.name:'unsupported-name'):[]};
      if(!object(b))throw new BridgeError(400,'invalid_chat_request');
      const allowed=new Set(['model','messages','tools','tool_choice','stream','stream_options','max_tokens','max_completion_tokens','n','store','reasoning_effort','temperature','top_p','parallel_tool_calls']);
      if(Object.keys(b).some(k=>!allowed.has(k))||b.model!==opts.exposedModel)throw new BridgeError(400,'unsupported_chat_request');
      if(b.n!==undefined&&b.n!==1||b.store!==undefined&&b.store!==false||b.stream!==undefined&&typeof b.stream!=='boolean')throw new BridgeError(400,'unsupported_chat_options');
      if(b.reasoning_effort!==undefined&&!['none','minimal','low','medium','high','xhigh','max'].includes(String(b.reasoning_effort)))throw new BridgeError(400,'unsupported_chat_options');
      for(const k of ['temperature','top_p'])if(b[k]!==undefined&&(typeof b[k]!=='number'||!Number.isFinite(b[k])))throw new BridgeError(400,'unsupported_chat_options');
      if(b.parallel_tool_calls!==undefined&&typeof b.parallel_tool_calls!=='boolean')throw new BridgeError(400,'unsupported_chat_options');
      if(b.stream_options!==undefined&&(!object(b.stream_options)||Object.keys(b.stream_options).some(k=>k!=='include_usage')||typeof b.stream_options.include_usage!=='boolean'))throw new BridgeError(400,'unsupported_stream_options');
      if(b.max_tokens!==undefined&&b.max_completion_tokens!==undefined)throw new BridgeError(400,'ambiguous_token_limit');
      const requested=b.max_completion_tokens??b.max_tokens??1000;
      if(!Number.isSafeInteger(requested)||Number(requested)<1)throw new BridgeError(400,'invalid_token_limit');
      if(b.tools!==undefined&&(!Array.isArray(b.tools)||b.tools.some(t=>!object(t)||!object(t.function)||typeof t.function.name!=='string'||!tools.has(t.function.name))))throw new BridgeError(403,'tool_not_enabled');
      if(!Array.isArray(b.messages))throw new BridgeError(400,'invalid_messages');
      // A permitted schema cannot smuggle a formerly ungranted tool in its history.
      for(const m of b.messages)if(object(m)&&Array.isArray(m.tool_calls)&&m.tool_calls.some(t=>!object(t)||!object(t.function)||typeof t.function.name!=='string'||!tools.has(t.function.name)))throw new BridgeError(403,'historical_tool_not_enabled');
      const prior=res.locals.tomoPrincipal as Principal;
      const current=await resolve(req.headers);same(prior,current);
      if(busy)throw new BridgeError(429,'tomo_model_busy');
      const requestFingerprint=requestDigest({providerProtocol:'luna-chat-none-effort/1',model:opts.exposedModel,messages:b.messages,tools:b.tools,toolChoice:b.tool_choice,maxOutputTokens:Math.min(Number(requested),MAX_OUTPUT_TOKENS_CEILING),subject:current.subject,workroomId:current.workroomId});
      const priorAttempts=opts.ledger.listReceipts().filter(r=>r.purpose===TOMO_MODEL_PURPOSE);
      if(priorAttempts.some(r=>r.context?.requestFingerprint===requestFingerprint))throw new BridgeError(409,'tomo_duplicate_attempt_refused');
      if(priorAttempts.length>=cap)throw new BridgeError(429,'tomo_request_cap_exceeded');
      busy=true;acquired=true;
      const requestIds=[...prior.nativeRequestIds,...current.nativeRequestIds];
      event={...event,requestId,subject:current.subject,workroomId:current.workroomId,receiptId:null,authority:current.authority,nativeRequestIds:requestIds,outcome:'failed',code:null};
      const result=await opts.luna.complete({messages:b.messages as ChatCompleteInput['messages'],...(b.tools!==undefined?{tools:b.tools as ChatCompleteInput['tools']}:{}),...(b.tool_choice!==undefined?{toolChoice:b.tool_choice as ChatCompleteInput['toolChoice']}:{}),purpose:TOMO_MODEL_PURPOSE,context:{requestId,requestFingerprint,subject:current.subject,workroomId:current.workroomId,authority:current.authority,nativeRequestIds:requestIds},maxOutputTokens:Math.min(Number(requested),MAX_OUTPUT_TOKENS_CEILING)});
      receiptId=result.receipt.id;event.receiptId=receiptId;res.set('X-REPLAY-Receipt-Id',receiptId);
      const fresh=await resolve(req.headers);same(current,fresh);
      event.nativeRequestIds.push(...fresh.nativeRequestIds);
      if(res.destroyed)throw new BridgeError(499,'tomo_client_disconnected');
      const completion={...result.completion,id:`chatcmpl-replay-${receiptId}`,model:opts.exposedModel};
      event.outcome='completed';opts.onAudit?.(event);event=undefined;
      if(b.stream===true){
        res.set({'Content-Type':'text/event-stream','X-Accel-Buffering':'no','X-REPLAY-Delivery':'buffered-completion'});
        for(const frame of completionFrames(completion as unknown as Record<string,unknown>))res.write(frame);
        res.end();
      }else res.json(completion);
    }catch(e){
      if(e instanceof InferenceError){receiptId=e.receiptId??receiptId;if(event){if(e.httpStatus)event.providerHttpStatus=e.httpStatus;if(e.chatDiagnostics)event.providerDiagnostics=e.chatDiagnostics;}}
      if(event){event.outcome='failed';event.receiptId=receiptId;event.code=e instanceof BridgeError||e instanceof McpAuthError||e instanceof InferenceError?e.code:'tomo_model_unavailable';try{opts.onAudit?.(event);}catch{/* ledger is already durable; never repeat inference */}}
      fail(res,e,receiptId);
    }finally{if(acquired)busy=false;}
  });
  router.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>fail(res,new BridgeError(object(error)&&error.status===413?413:400,'invalid_chat_body')));
  return router;
}

/** OpenAI Chat SSE framing of a completed result; never fabricates partial reasoning. */
export function completionFrames(c:Record<string,unknown>):string[]{
  const choices=c.choices as {message:{content?:string|null;tool_calls?:Record<string,unknown>[]};finish_reason:string}[];
  const choice=choices[0];
  const base={id:c.id,object:'chat.completion.chunk',created:c.created,model:c.model};
  const frame=(x:unknown)=>'data: '+JSON.stringify(x)+'\n\n';
  const delta:Record<string,unknown>={role:'assistant'};
  if(choice.message.content!==undefined&&choice.message.content!==null)delta.content=choice.message.content;
  if(choice.message.tool_calls?.length)delta.tool_calls=choice.message.tool_calls.map((call,index)=>({...call,index}));
  return [frame({...base,choices:[{index:0,delta,finish_reason:null}]}),frame({...base,choices:[{index:0,delta:{},finish_reason:choice.finish_reason}]}),...(c.usage?[frame({...base,choices:[],usage:c.usage})]:[]),'data: [DONE]\n\n'];
}
