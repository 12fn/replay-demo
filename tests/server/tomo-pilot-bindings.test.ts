import {afterEach,describe,it,expect,vi} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createTomoBindingRegistry,parseTomoBindings,sameTomoBinding,TOMO_BINDINGS_SCHEMA,TOMO_BINDINGS_FILE} from '../../src/server/tomo-pilot-bindings';
const ROOM='workroom-0001',COMMANDER='commander-subject',INTEL='intelligence-subject';
const A='00000000-0000-4000-8000-0000000000a1',B='00000000-0000-4000-8000-0000000000b2',LEGACY='00000000-0000-4000-8000-0000000000c3';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const doc=(bindings:unknown[],extra:Record<string,unknown>={})=>JSON.stringify({schema:TOMO_BINDINGS_SCHEMA,workroomId:ROOM,bindings,...extra});
function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tomo-bindings-'));dirs.push(dir);const file=path.join(dir,TOMO_BINDINGS_FILE);fs.mkdirSync(path.dirname(file),{recursive:true});
 const onInvalid=vi.fn();const registry=createTomoBindingRegistry({file,workroomId:ROOM,legacy:{subjects:[COMMANDER],agentId:LEGACY,agentName:'REPLAY evidence observer'},onInvalid});
 // Atomic replace, as documented for operators.
 const write=(text:string,mode=0o640)=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,text,{mode});fs.chmodSync(tmp,mode);fs.renameSync(tmp,file);};
 return {file,registry,write,onInvalid,resolve:(subject:string,workroomId:string=ROOM)=>registry.resolve({subject,workroomId})};
}
describe('Tomo per-subject helper binding registry',()=>{
 it('keeps the env subject and single helper exactly when no registry file exists',async()=>{
  const h=setup();
  expect(await h.resolve(COMMANDER)).toEqual({source:'environment',state:'bound',binding:{subject:COMMANDER,agentId:LEGACY,agentName:'REPLAY evidence observer'}});
  expect(await h.resolve(INTEL)).toEqual({source:'environment',state:'unbound',binding:null});
 });
 it('maps distinct subjects to their own helpers and reloads additions without restart',async()=>{
  const h=setup();h.write(doc([{subject:COMMANDER,agentId:A,agentName:'Commander evidence observer'}]));
  expect((await h.resolve(COMMANDER)).binding).toEqual({subject:COMMANDER,agentId:A,agentName:'Commander evidence observer'});
  expect((await h.resolve(INTEL)).state).toBe('unbound');
  h.write(doc([{subject:COMMANDER,agentId:A,agentName:'Commander evidence observer'},{subject:INTEL,agentId:B,agentName:'Intelligence evidence observer'}]));
  expect((await h.resolve(INTEL)).binding).toEqual({subject:INTEL,agentId:B,agentName:'Intelligence evidence observer'});
  expect((await h.resolve(COMMANDER)).binding?.agentId).toBe(A);
 });
 it('denies everyone for an empty valid registry instead of using env subjects',async()=>{
  const h=setup();h.write(doc([]));
  expect(await h.resolve(COMMANDER)).toEqual({source:'registry',state:'unbound',binding:null});
 });
 it('does not bind a registry subject for a different native workroom',async()=>{
  const h=setup();h.write(doc([{subject:INTEL,agentId:B,agentName:'Intel helper'}]));expect((await h.resolve(INTEL,'other-workroom')).state).toBe('unbound');
 });
 it.each<[string,string]>([
  ['invalid-json','{"schema":'],
  ['unsupported-schema',doc([],{schema:'replay.tomo-member-bindings/v2'})],
  ['wrong-workroom',doc([],{workroomId:'other-workroom'})],
  ['invalid-document',doc([],{defaultAgentId:A})],
  ['invalid-binding',doc([{subject:INTEL,agentId:B,agentName:'x',role:'admin'}])],
  ['invalid-binding',doc([{subject:INTEL,agentId:B}])],
  ['invalid-subject',doc([{subject:'*',agentId:B,agentName:'wildcard'}])],
  ['invalid-agent-id',doc([{subject:INTEL,agentId:B.toUpperCase(),agentName:'upper'}])],
  ['invalid-agent-id',doc([{subject:INTEL,agentId:'default',agentName:'default'}])],
  ['invalid-agent-name',doc([{subject:INTEL,agentId:B,agentName:'<script>'}])],
  ['duplicate-subject',doc([{subject:INTEL,agentId:A,agentName:'one'},{subject:INTEL,agentId:B,agentName:'two'}])],
  ['duplicate-agent',doc([{subject:COMMANDER,agentId:A,agentName:'one'},{subject:INTEL,agentId:A,agentName:'two'}])],
  ['invalid-bindings',doc([],{bindings:{[INTEL]:B}})],
  ['oversized',doc([{subject:INTEL,agentId:B,agentName:'x'}]).replace('{', '{'+' '.repeat(17000))],
 ])('fails closed without env fallback: %s',async(code,text)=>{
  const h=setup();h.write(text);
  expect(await h.resolve(COMMANDER)).toEqual({source:'registry',state:'registry-invalid',binding:null});
  expect(await h.resolve(INTEL)).toEqual({source:'registry',state:'registry-invalid',binding:null});
  expect(h.onInvalid).toHaveBeenCalledWith(code);
 });
 it('refuses group/world-writable, symlinked and non-file registries',async()=>{
  const h=setup();h.write(doc([{subject:INTEL,agentId:B,agentName:'Intel helper'}]),0o666);expect((await h.resolve(INTEL)).state).toBe('registry-invalid');
  const target=h.file+'.real';fs.writeFileSync(target,doc([{subject:INTEL,agentId:B,agentName:'Intel helper'}]),{mode:0o600});fs.rmSync(h.file);fs.symlinkSync(target,h.file);
  expect((await h.resolve(INTEL)).state).toBe('registry-invalid');
  fs.rmSync(h.file);fs.mkdirSync(h.file);expect((await h.resolve(INTEL)).state).toBe('registry-invalid');
 });
 it('refuses a present registry when no native workroom is configured',async()=>{
  const h=setup();h.write(doc([]));const local=createTomoBindingRegistry({file:h.file,workroomId:null,legacy:{subjects:[COMMANDER]}});
  expect((await local.resolve({subject:COMMANDER})).state).toBe('registry-invalid');
 });
 it('treats revocation, helper change and source change as a changed binding',async()=>{
  const h=setup();const legacy=await h.resolve(COMMANDER);
  h.write(doc([{subject:COMMANDER,agentId:A,agentName:'Commander helper'}]));const first=await h.resolve(COMMANDER);
  expect(sameTomoBinding(legacy,first)).toBe(false);
  h.write(doc([{subject:COMMANDER,agentId:A,agentName:'Renamed helper'}]));expect(sameTomoBinding(first,await h.resolve(COMMANDER))).toBe(true);
  h.write(doc([{subject:COMMANDER,agentId:B,agentName:'Commander helper'}]));expect(sameTomoBinding(first,await h.resolve(COMMANDER))).toBe(false);
  h.write(doc([]));expect(sameTomoBinding(first,await h.resolve(COMMANDER))).toBe(false);
 });
 it('validates pure registry text with the same rules',()=>{
  expect(parseTomoBindings(doc([{subject:INTEL,agentId:B,agentName:'Intel helper'}]),ROOM).get(INTEL)?.agentId).toBe(B);
  expect(()=>parseTomoBindings(doc([]),'other-workroom')).toThrow('wrong-workroom');
 });
});
