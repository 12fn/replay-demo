/** Real durable clock plus two native readers. Automated activity; never a human pacing result. */
import fs from 'node:fs';import assert from 'node:assert/strict';
import {ReplayEngine} from '../../src/engine/engine';
import {nativeAppClient} from './native-app-client';
import {selectScenario} from '../../src/scenarios/catalog';

const version=process.argv[2];assert(version&&/^\d+\.\d+\.\d+$/.test(version),'Expected deployed version required');
const users=JSON.parse(fs.readFileSync('data/platform/team-qualification-users.json','utf8'));
const commander=await nativeAppClient(users.find((u:any)=>u.role==='commander'));
const analyst=await nativeAppClient(users.find((u:any)=>u.role==='intelligence'));
const instructor=await nativeAppClient();
const j=async(c:typeof commander,p:string,b?:unknown)=>(await c.request(p,b)).json() as Promise<any>;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ids:string[]=[],runs:any[]=[];
const artifact=`evidence/soak/native-maneuver-${version}.json`;assert(!fs.existsSync(artifact),'Do not overwrite a previous qualification');
try{
 const build=await j(commander,'/replay-build.json');assert.equal(build.version,version);
 await j(commander,'/api/overview'); // Resolve an accessible initial exercise for this fresh native session.
 const budget=(await j(commander,'/api/agents/tools')).budget;
 for(const scenarioId of ['crosscurrent-maneuver/1','crosscurrent-crossing/1']){
  const row=await j(commander,'/api/exercises',{name:`Automated native qualification · ${scenarioId}`,scenarioId});ids.push(row.id);
  const expected=selectScenario(scenarioId);assert.deepEqual(row.options.scenario,expected);assert.equal(row.options.scenarioId,expected.learningScenarioId);
  await j(instructor,'/api/select',{exerciseId:row.id});const invite=await j(instructor,'/api/team/code',{});
  await j(analyst,'/api/team/join',{code:invite.code});invite.code='';
  const initial=await j(commander,'/api/overview');const samples:{ms:number;tick:number;seat:string}[]=[],seeks:{tick:number;ms:number}[]=[],errors:string[]=[];
  const start=performance.now(),durationMs=120000;let ended=false;
  async function reader(seat:string,c:typeof commander){
   let n=0;while(performance.now()-start<durationMs&&!ended){const t=performance.now();
    try{
     if(seat==='intelligence'&&n>0&&n%20===0){const tick=Math.max(1,Math.floor((samples.filter(s=>s.seat==='commander').at(-1)?.tick??1)/2)),at=performance.now();await j(c,'/api/replay',{tick});const hist=await j(c,'/api/overview');assert.equal(hist.state.tick,tick);seeks.push({tick,ms:performance.now()-at});await j(c,'/api/replay',{tick:null});}
     const o=await j(c,'/api/overview');ended=o.exercises.find((e:any)=>e.id===row.id)?.status!=='running';
     if(seat==='commander'&&!ended&&n%9===0&&!o.state.spawning){
      const blue=o.state.players.find((p:any)=>p.side==='blue'),red=o.state.players.find((p:any)=>p.side==='red');const owners=o.state.owners,width=o.state.width;let adjacent=false;
      for(let tile=0;tile<owners.length&&!adjacent;tile++)if(owners[tile]===blue.smallId)adjacent=(tile%width+1<width&&owners[tile+1]===red.smallId)||(tile%width>0&&owners[tile-1]===red.smallId)||owners[tile-width]===red.smallId||owners[tile+width]===red.smallId;
      if(blue.alive&&blue.troops>100)await j(c,'/api/commands',{side:'blue',idempotencyKey:row.id+':baseline:'+n,intent:{type:'attack',targetID:adjacent?red.id:null,troops:Math.floor(blue.troops*.18)},observationReceipt:o.observationReceipt,rationale:'Automated API load: scripted18percent baseline. Not a human decision or learning assessment.'});
     }
     samples.push({seat,ms:performance.now()-t,tick:o.state.tick});
    }catch(e){errors.push(`${seat}: ${(e as Error).message}`);ended=true;}
    n++;await delay(Math.max(0,500-(performance.now()-t)));
   }
  }
  await Promise.all([reader('commander',commander),reader('intelligence',analyst)]);
  const elapsedMs=performance.now()-start;await j(commander,'/api/replay',{tick:null});const final=await j(commander,'/api/overview');
  const naturalEnd=final.exercises.find((e:any)=>e.id===row.id)?.status!=='running';
  if(!naturalEnd)await j(instructor,`/api/exercises/${row.id}/finish`,{});
  const record=await j(instructor,`/api/record/${row.id}`);const bundle=await j(instructor,'/api/review/export.json');
  const restore=[];for(const tick of [...new Set([Math.min(45,record.turns.length),Math.min(600,record.turns.length),record.turns.length])]){
   assert(record.fingerprints[tick]);const at=performance.now(),e=await ReplayEngine.restore(record,tick,'checkpoints');assert.equal(e.state().fingerprint,record.fingerprints[tick]);restore.push({tick,ms:performance.now()-at,fingerprint:e.state().fingerprint});
  }
  const commands=bundle.payload.events.filter((e:any)=>e.kind==='command'),decisions=bundle.payload.events.filter((e:any)=>e.kind==='scripted_decision');
  assert(decisions.length>0,'New opponent never acted');assert(commands.some((e:any)=>e.details.origin==='scripted-maneuver'),'No scripted maneuver order executed');
  const sorted=samples.map(s=>s.ms).sort((a,b)=>a-b),p=(f:number)=>Math.round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*f))]??0);
  const ratio=(final.state.tick-initial.state.tick)/(elapsedMs/100);
  const run={exerciseId:row.id,scenario:expected,automated:true,humanPlaytest:false,blueActivity:'scripted18percent baseline',requestedDurationMs:durationMs,elapsedMs:Math.round(elapsedMs),end:naturalEnd?'natural elimination':'facilitator end after load interval',fullLoadDuration:!naturalEnd&&elapsedMs>=durationMs,reads:samples.length,seeks,latencyMs:{p50:p(.5),p95:p(.95),max:p(1)},clock:{initial:initial.state.tick,final:final.state.tick,ratio},errors,decisionCategories:Object.fromEntries([...new Set(decisions.map((e:any)=>e.details.category))].map(category=>[String(category),decisions.filter((e:any)=>e.details.category===category).length])),executedManeuverOrders:commands.filter((e:any)=>e.details.origin==='scripted-maneuver').length,rejectedEvents:bundle.payload.events.filter((e:any)=>e.kind==='scripted_rejected').length,restore,bundleSha256:bundle.sha256,fingerprint:bundle.payload.engine.fingerprint};
  runs.push(run);fs.writeFileSync(`data/platform/native-maneuver-${row.id}.json`,JSON.stringify({record,bundle}));
  console.log(JSON.stringify(run));assert.equal(errors.length,0);if(!naturalEnd)assert(ratio>.85,'Durable clock fell below85percent');
 }
 const after=(await j(commander,'/api/agents/tools')).budget;assert.equal(after.requestsUsed,budget.requestsUsed);
 fs.writeFileSync(artifact,JSON.stringify({at:new Date().toISOString(),build,runs,budget:after,newPaidRequests:0,limitations:['Two native signed-in readers with occasional historical seeks; scripted Blue orders. No human play or learning-efficacy evidence.','Early elimination is reported as incomplete duration coverage, never hidden by changing victory rules.','No model latency in this qualification; accelerated policy comparisons are separate.']},null,2),{flag:'wx'});
}finally{
 for(const id of ids)try{await j(instructor,'/api/select',{exerciseId:id});const o=await j(instructor,'/api/overview');if(o.exercises.find((e:any)=>e.id===id)?.status==='running')await j(instructor,`/api/exercises/${id}/finish`,{});}catch{}
 for(const c of [commander,analyst,instructor])await c.close().catch(()=>{});
}
