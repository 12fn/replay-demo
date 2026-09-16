/** Build the prepared, labelled synthetic instructor exercise. Never invokes inference. */
import fs from 'node:fs';import {createHash} from 'node:crypto';import {ReplayEngine} from '../src/engine/engine';
import {EVIDENCE_PACKET} from '../src/scenarios/evidence-packet';import {materializeEvidenceReport} from '../src/scenarios/evidence-records';
console.debug=()=>{};
const engine=await ReplayEngine.create({map:'plains',simulationId:'SHOW0001'});engine.step([{side:'blue',intent:{type:'spawn',tile:2525}},{side:'red',intent:{type:'spawn',tile:7575}}]);
const events:any[]=[],reports=EVIDENCE_PACKET.reports.filter(r=>r.releaseTick<=600).map(r=>materializeEvidenceReport(EVIDENCE_PACKET,r,id=>'showcase:'+id));
const author='fictional-showcase-learner';
for(let tick=2;tick<=650;tick++){
 const commands:any[]=[];
 if([100,320,610].includes(tick)){
  const available=reports.filter(r=>r.side==='blue'&&r.tick<tick);const sourceIds=available.slice(-2).map(r=>r.id);const troops=Math.floor(engine.player('blue').troops()*(tick===320?.55:.15));const intent={type:'attack',targetID:null,troops};commands.push({side:'blue',intent});const before=engine.state().players.find(p=>p.side==='blue');
  events.push({id:'showcase-order-'+tick,tick,kind:'command',actor:author,side:'blue',summary:`Authored rehearsal order: expand with ${troops} forces`,details:{origin:'human',synthetic:true,demonstration:'Scripted fictional participant; not an actual learner action',commandId:'showcase-command-'+tick,intent,observedTick:tick-1,before,sourceIds,rationale:tick===320?'The repeated estimate appears to support this commitment; verify whether the later report is independent.':'Retain reserves while checking the current source.',rationaleTiming:'contemporaneous'}});
 }
 engine.step(commands);
 if(commands.length){events.at(-1).details.after=engine.state().players.find(p=>p.side==='blue');events.at(-1).details.fingerprint=engine.state().fingerprint;}
}
for(const report of reports)events.push({id:'release:'+report.id,tick:Math.max(1,report.tick),kind:'report',actor:'synthetic-source-desk',side:report.side,summary:report.title,details:{reportId:report.id,synthetic:true}});
events.sort((a,b)=>a.tick-b.tick);events.forEach((e,i)=>e.sequence=i+1);
const record=engine.record();const fixture={schema:'replay.showcase/1',version:'2026-09-15.1',seed:'SHOW0001',scenarioDate:'2026-09-15',dataClass:'authored-synthetic',humanValidated:false,name:'Prepared instructor exercise · changing evidence',actor:author,record,events,reports,selectedEventId:'showcase-order-320',reviewTick:320,forkTick:319,finalTick:650,engineFingerprint:engine.state().fingerprint,claim:'Actual deterministic engine execution of authored fictional choices; no model or human learning result is implied.'};
fs.writeFileSync('resources/showcase/fixture.json',JSON.stringify(fixture));
// Native output is preserved in the packaged whitelisted archive; this generator never fetches or rewrites it.
const graph=JSON.parse(fs.readFileSync('resources/catalog-ontology/graph.json','utf8'));const trial=graph.nodes.find((n:any)=>n.type==='ActualTrial'&&/taiwan/i.test(n.label))??graph.nodes.find((n:any)=>n.type==='ActualTrial');
fs.writeFileSync('resources/showcase/manifest.json',JSON.stringify({schema:'replay.showcase-manifest/1',version:fixture.version,fixtureSha256:createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),recordedProofSha256:createHash('sha256').update(fs.readFileSync('resources/showcase/recorded-proof.json')).digest('hex'),recordedDebriefSha256:createHash('sha256').update(fs.readFileSync('resources/showcase/recorded-debrief.json')).digest('hex'),fixture:{events:events.length,reports:reports.length,turns:record.turns.length,reviewTick:fixture.reviewTick,forkTick:fixture.forkTick,selectedEventId:fixture.selectedEventId},archivedTrial:{id:trial?.id,label:trial?.label},sourceClass:fixture.dataClass,paidCalls:0},null,2));
console.log(JSON.stringify({files:4,turns:record.turns.length,events:events.length,reports:reports.length,fingerprint:engine.state().fingerprint,paidCalls:0}));
