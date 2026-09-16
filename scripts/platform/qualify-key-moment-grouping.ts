/** Compare the deployed selector with the candidate selector over an unchanged recorded load exercise. */
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {nativeAppClient} from './native-app-client';import {selectKeyMoments} from '../../src/learning/key-moments';
const artifact='evidence/poc/key-moment-grouping-0.11.0.json';assert(!fs.existsSync(artifact));
const c=await nativeAppClient();const j=async(p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
try{
 await j('/api/select',{exerciseId:'e42ea69a-6428-45b3-ae25-e0d4c5ee4d1b'});await j('/api/replay',{tick:null});
 const before=await j('/api/overview'),build=await j('/replay-build.json'),bundle=(await j('/api/review/export.json')).payload;
 const canonical=JSON.stringify(await j('/api/record/'+before.activeId));
 const record={exercise:bundle.exercise,events:bundle.events,reports:bundle.reports};
 const start=performance.now();const result=selectKeyMoments({record,scope:{kind:'shared'},viewerSide:before.selectedSide,bothSidesVisible:true,cutoff:{tick:before.state.tick}});const elapsed=performance.now()-start;
 assert(result.candidates.length<before.keyMoments.candidateCount,'Repeated fixed-share traffic should yield fewer candidates');
 const grouped=result.candidates.filter(m=>m.repeatCount>1);assert(grouped.some(m=>m.repeatKind==='equivalent'));
 for(const m of grouped){const ids=m.evidence.filter(e=>e.kind==='command').map(e=>e.id);assert.equal(new Set(ids).size,m.repeatCount);for(const id of ids)assert(bundle.events.some((e:any)=>e.id===id));}
 assert.equal(JSON.stringify(await j('/api/record/'+before.activeId)),canonical);
 const proof={at:new Date().toISOString(),deployedBefore:build.version,candidate:'0.11.0 working source',exerciseId:before.activeId,tick:before.state.tick,scope:'instructor shared',canonicalSha256:createHash('sha256').update(canonical).digest('hex'),sourceUnchanged:true,beforeCandidates:before.keyMoments.candidateCount,afterCandidates:result.candidates.length,selected:result.selected.length,elapsedMs:elapsed,groups:grouped.map(m=>({id:m.id,count:m.repeatCount,kind:m.repeatKind,range:m.repeatRange})),inferenceRequested:false,humanValidated:false};
 fs.writeFileSync(artifact,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify(proof));
}finally{await c.close();}
