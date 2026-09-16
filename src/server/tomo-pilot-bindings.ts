/** Operator-managed per-subject Tomo helper bindings.
 * One resolver authorizes both the conversation entry and the native model route, so a mapping can never
 * enable only one layer. The registry file is read on every call (no restart, no stale cache); its presence
 * selects registry mode. A missing file keeps the legacy env subjects/single-agent behavior. Any unreadable,
 * malformed, oversized, loosely permissioned or wrong-workroom registry denies everyone and never falls back.
 * The file only names which private helper a subject may select; native member authority is still checked
 * fresh by the routes, and Tomo itself enforces that the helper belongs to the calling member.
 */
import {promises as fs,constants} from 'node:fs';
export const TOMO_BINDINGS_SCHEMA='replay.tomo-member-bindings/v1';
export const TOMO_BINDINGS_FILE='tomo/member-bindings.json';
export const TOMO_BINDINGS_MAX_BYTES=16384;
export const TOMO_BINDINGS_MAX_ENTRIES=32;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SUBJECT=/^[A-Za-z0-9._~@:-]{1,128}$/;
const WORKROOM=/^[A-Za-z0-9._~-]{8,128}$/;
const NAME=/^[\p{L}\p{N} ._()'-]{1,80}$/u;
export interface TomoBinding {subject:string;agentId?:string;agentName:string;}
export type TomoBindingResolution=
 |{source:'environment'|'registry';state:'bound';binding:TomoBinding}
 |{source:'environment'|'registry';state:'unbound';binding:null}
 |{source:'registry';state:'registry-invalid';binding:null};
export interface TomoBindingResolver {resolve(query:{subject:string;workroomId?:string}):Promise<TomoBindingResolution>;}
/** Same agent (or same legacy default) for the same subject; used by renew loops to detect mid-operation changes. */
export const sameTomoBinding=(a:TomoBindingResolution,b:TomoBindingResolution)=>a.state==='bound'&&b.state==='bound'&&a.source===b.source&&a.binding.subject===b.binding.subject&&a.binding.agentId===b.binding.agentId;
export interface LegacyTomoBindings {subjects:readonly string[];agentId?:string;agentName?:string;}
export function legacyTomoBindings(legacy:LegacyTomoBindings):TomoBindingResolver {
 const subjects=new Set(legacy.subjects),agentName=legacy.agentName??'REPLAY evidence observer';
 return {async resolve({subject}){return subjects.has(subject)?{source:'environment',state:'bound',binding:{subject,...(legacy.agentId?{agentId:legacy.agentId}:{}),agentName}}:{source:'environment',state:'unbound',binding:null};}};
}
export class TomoBindingsFormatError extends Error{constructor(readonly code:string){super(code);}}
const exactKeys=(x:unknown,keys:readonly string[]):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(x,k));
/** Pure validation of registry text; throws TomoBindingsFormatError with a non-sensitive code. */
export function parseTomoBindings(text:string,workroomId:string):Map<string,TomoBinding> {
 if(Buffer.byteLength(text)>TOMO_BINDINGS_MAX_BYTES)throw new TomoBindingsFormatError('oversized');
 let doc:unknown;try{doc=JSON.parse(text);}catch{throw new TomoBindingsFormatError('invalid-json');}
 if(!exactKeys(doc,['schema','workroomId','bindings']))throw new TomoBindingsFormatError('invalid-document');
 if(doc.schema!==TOMO_BINDINGS_SCHEMA)throw new TomoBindingsFormatError('unsupported-schema');
 if(typeof doc.workroomId!=='string'||!WORKROOM.test(doc.workroomId)||doc.workroomId!==workroomId)throw new TomoBindingsFormatError('wrong-workroom');
 if(!Array.isArray(doc.bindings)||doc.bindings.length>TOMO_BINDINGS_MAX_ENTRIES)throw new TomoBindingsFormatError('invalid-bindings');
 const map=new Map<string,TomoBinding>(),agents=new Set<string>();
 for(const entry of doc.bindings){
  if(!exactKeys(entry,['subject','agentId','agentName']))throw new TomoBindingsFormatError('invalid-binding');
  const {subject,agentId,agentName}=entry;
  if(typeof subject!=='string'||!SUBJECT.test(subject))throw new TomoBindingsFormatError('invalid-subject');
  if(typeof agentId!=='string'||!UUID.test(agentId))throw new TomoBindingsFormatError('invalid-agent-id');
  if(typeof agentName!=='string'||!NAME.test(agentName)||agentName.trim()!==agentName)throw new TomoBindingsFormatError('invalid-agent-name');
  if(map.has(subject))throw new TomoBindingsFormatError('duplicate-subject');
  // A private helper has exactly one owner, so one helper id mapped to two subjects is always an operator error.
  if(agents.has(agentId))throw new TomoBindingsFormatError('duplicate-agent');
  map.set(subject,{subject,agentId,agentName});agents.add(agentId);
 }
 return map;
}
export interface TomoBindingRegistryOptions {
 /** Absolute registry path, normally `${REPLAY_DATA_DIR}/tomo/member-bindings.json`. */
 file:string;
 /** Exact configured native workroom; null (local demo) makes any present registry invalid. */
 workroomId:string|null;
 legacy:LegacyTomoBindings;
 onInvalid?:(code:string)=>void;
}
export function createTomoBindingRegistry(opts:TomoBindingRegistryOptions):TomoBindingResolver {
 const legacy=legacyTomoBindings(opts.legacy);let lastInvalid='';
 const invalid=(code:string):TomoBindingResolution=>{if(code!==lastInvalid){lastInvalid=code;try{opts.onInvalid?.(code);}catch{}}return {source:'registry',state:'registry-invalid',binding:null};};
 return {async resolve(query){
  let text:string;
  try{
   // Never follow a symlink: the registry must be a regular file on the operator-managed volume.
   const handle=await fs.open(opts.file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
   try{
    const stat=await handle.stat();
    if(!stat.isFile())return invalid('not-regular-file');
    if(stat.mode&0o022)return invalid('writable-by-group-or-other');
    if(stat.size>TOMO_BINDINGS_MAX_BYTES)return invalid('oversized');
    const buffer=Buffer.alloc(TOMO_BINDINGS_MAX_BYTES+1);let bytesRead=0;
    for(let n=-1;n!==0&&bytesRead<buffer.length;bytesRead+=n)n=(await handle.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead)).bytesRead;
    if(bytesRead>TOMO_BINDINGS_MAX_BYTES)return invalid('oversized');
    text=buffer.subarray(0,bytesRead).toString('utf8');
   }finally{await handle.close().catch(()=>{});}
  }catch(error){
   if((error as NodeJS.ErrnoException)?.code==='ENOENT'){lastInvalid='';return legacy.resolve(query);}
   return invalid('unreadable');
  }
  if(!opts.workroomId)return invalid('workroom-not-configured');
  let map:Map<string,TomoBinding>;
  try{map=parseTomoBindings(text,opts.workroomId);}catch(error){return invalid(error instanceof TomoBindingsFormatError?error.code:'invalid');}
  lastInvalid='';
  if(query.workroomId!==undefined&&query.workroomId!==opts.workroomId)return {source:'registry',state:'unbound',binding:null};
  const binding=map.get(query.subject);
  return binding?{source:'registry',state:'bound',binding:{...binding}}:{source:'registry',state:'unbound',binding:null};
 }};
}
