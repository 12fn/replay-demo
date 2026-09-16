import type express from 'express';
import type {NativeResolved} from './native-session';
import type {GameService,Session} from './service';
export type AgentResolver=()=>Promise<NativeResolved>;
export type DomainKnowledge={status:'native'|'unavailable';checkedAt:string;groupId?:string;requestId?:string;facts?:{id:string|null;content:string;sourceIds:string[];attribution?:'native_sources'|'supplemental_unattributed';evidenceEligible?:boolean}[];query?:string;scopeNote?:string;reason?:string};
export interface DomainRequest {exerciseId?:string;side?:string;tick?:number;sourceIds?:string[];task?:string;}
export function domainQuery(request:DomainRequest={}):string{return `REPLAY rules for ${request.task==='opponent'?'legal player actions':'staff evidence review'}; exercise ${request.exerciseId??'unspecified'}; side ${request.side??'unspecified'}; observed tick ${request.tick??'unspecified'}; ${request.sourceIds?.length??0} released source records. Explain source supersession, repeated reports and legal replay branches. Source bodies are omitted from this query.`;}
/** Ephemeral capability: only the initiating caller can authorize a paid controller. Never persisted. */
export class AgentAuthority {
 private cache:{at:number;query:string;value:DomainKnowledge}|null=null;
 private latest:NativeResolved|null=null;
 constructor(private expected:{subject:string;workroomId:string;canCommand?:boolean},private resolver:AgentResolver,private audit:(kind:string,details:Record<string,unknown>)=>void,private ontologyId?:string){}
 /** Role from the last successful fresh check, never an authorization grant. */
 currentRole(){const role=this.latest?.identity.role;return role==='commander'||role==='intelligence'||role==='instructor'?role:null;}
 matchesSubject(subject:string){return this.expected.subject===subject;}
 async check():Promise<boolean>{
  try{
   const r=await this.resolver();const c=r.context;
   if(r.identity.subject!==this.expected.subject||c.workroomId!==this.expected.workroomId||!c.fresh||!c.canEdit||!c.canRunAgents||(this.expected.canCommand&&r.identity.role==='intelligence'))throw new Error('Native context no longer authorizes this controller');
   this.latest=r;this.audit('agent_authorized',{workroomId:c.workroomId,checkedAt:c.validatedAt,requestIds:r.nativeReceipts.map(x=>x.requestId??x.clientRequestId)});return true;
  }catch{this.latest=null;this.cache=null;this.audit('agent_authorization_denied',{reason:'Native authorization is no longer available for this controller'});return false;}
 }
 async domain(request:DomainRequest={}):Promise<DomainKnowledge>{
  const query=domainQuery(request),scopeNote='Supplemental native rules reference. Facts without joined source attribution cannot support an exercise evidence claim; engine legality and deterministic side/time retrieval remain authoritative.';
  if(!this.latest)return {status:'unavailable',checkedAt:new Date().toISOString(),reason:'Native authorization unavailable'};
  if(!this.ontologyId)return {status:'unavailable',checkedAt:new Date().toISOString(),reason:'No native ontology configured'};
  if(this.cache&&this.cache.query===query&&Date.now()-this.cache.at<30000)return this.cache.value;
  const checkedAt=new Date().toISOString(),groupId=this.expected.workroomId;
  try{
   const r=await this.latest.platformClient.searchOntology(this.ontologyId,{query,group_ids:[groupId],max_results:8},{workroomId:groupId});
   const facts=(r.data.facts??[]).slice(0,8).map(f=>{const sourceIds=(r.data.sources?.find(s=>s.fact_uuid===f.fact_uuid)?.sources??[]).map(s=>s.source_id).slice(0,4);return {id:f.fact_uuid??null,content:String(f.content).slice(0,450),sourceIds,attribution:sourceIds.length?'native_sources' as const:'supplemental_unattributed' as const,evidenceEligible:sourceIds.length>0};});
   const value:DomainKnowledge={status:'native',query,scopeNote,checkedAt,groupId,requestId:r.receipt.requestId??r.receipt.clientRequestId,facts};
   this.cache={at:Date.now(),query,value};this.audit('domain_retrieved',value);return value;
  }catch{const value:DomainKnowledge={status:'unavailable',query,scopeNote,checkedAt,groupId,reason:'Native rules reference unavailable. Do not cite native facts; continue with deterministic tools and released source records.'};this.audit('domain_unavailable',value);this.cache={at:Date.now(),query,value};return value;}
 }
}
/** Called after session resolution and before core /api/agent and optional staff routes. */
export function mountNativeAgentBindings(app:express.Express,service:GameService){
 app.use((req,res,next)=>{
  const match=req.path.match(/^\/api\/agents\/tasks\/([^/]+)\/model$/);
  if(req.method!=='POST'||req.body?.enabled!==true||!(req.path==='/api/agent'||match))return next();
  app.locals.guards.requireActive(req,res,(scopeError?:unknown)=>{
   if(scopeError)return next(scopeError);
   app.locals.guards.requireAgents(req,res,(err?:unknown)=>{
    if(err)return next(err);
    try{const s=res.locals.session as Session;service.bindAgentAuthority(s,match?`task:${match[1]}`:'opponent',res.locals.resolveAgentAuthority);next();}catch(e){next(e);}
   });
  });
 });
}
