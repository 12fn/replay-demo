import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService,type Session} from '../../src/server/service';
import {DeterministicClient} from '../../src/inference/index';
import {citableIds,staffObservation,newWatch} from '../../src/agents/staff';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
async function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-context-')),s=new GameService(dir);clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}),()=>s.close());const row=await s.create('Context','world',undefined,'crosscurrent-classic/1'),w=s.world(row.id);for(let i=0;i<25;i++)s.tick(w);return{s,w};}
it('carries a retained fictional commander pack through both model completions and joins tool results by pulse',async()=>{
 const{s,w}=await setup();const client=new DeterministicClient({respond:(_req,index)=>({summary:'External choice',sourceIds:[],done:index>0,calls:index===0?[{tool:'observe',arguments:'{}'}]:[]})});s.luna=client;w.row.agentEnabled=true;await s.runOpponent(w);
 expect(client.history).toHaveLength(2);
 const observations=client.history.map(r=>JSON.parse(r.input).observation);expect(observations[0].organizationContext).toMatchObject({role:'commander',status:'provisional-unreviewed'});expect(observations[1]).toEqual(observations[0]);
 const decisions=s.store.events(w.row.id).filter(e=>e.kind==='model_decision'),tools=s.store.events(w.row.id).filter(e=>e.kind==='tool_result');expect(decisions).toHaveLength(2);expect(decisions[0].details.pulseId).toBeTruthy();expect(decisions[1].details.pulseId).toBe(decisions[0].details.pulseId);expect(tools[0].details.pulseId).toBe(decisions[0].details.pulseId);expect(decisions[0].details.observation).toEqual(observations[0]);
});
it('does not admit narrative glossary/report/curriculum IDs as staff evidence',async()=>{
 const{s,w}=await setup(),ctx=s.agentContext(w,'blue','staff');const task=newWatch({id:'task',owner:'user',side:'blue',objective:'Monitor report provenance',tick:w.engine.game.ticks(),ctx});
 const obs=staffObservation(task,{newReports:[],superseded:[],delta:null,reasons:[]},ctx);expect(obs.organizationContext?.role).toBe('intelligence');const allowed=citableIds(ctx,[obs,{eventId:'actual-tool-event'}]);
 expect(allowed.has('actual-tool-event')).toBe(true);expect(allowed.has(obs.organizationContext!.report.id)).toBe(false);for(const term of obs.organizationContext!.glossary)expect(allowed.has(term.id)).toBe(false);for(const ref of obs.organizationContext!.curriculumReferences)expect(allowed.has(ref.id)).toBe(false);
});
it('uses the freshly resolved native seat in one-shot assistance, not a stale session label',async()=>{
 const{s,w}=await setup();const session:Session={activeId:w.row.id,playbackTick:null,selectedSide:'blue',identity:{subject:'user',name:'User',role:'commander',organization:'Example',mode:'kamiwaza'}};w.row.options.workroomId='room';
 const client=new DeterministicClient({respond:()=>({text:'No report conclusion.',sourceIds:[]})});s.luna=client;
 const resolver=async()=>({identity:{...session.identity,role:'intelligence'},context:{workroomId:'room',fresh:true,canEdit:true,canRunAgents:true,validatedAt:'now'},nativeReceipts:[]} as any);
 await s.staff(session,'What context do I have?','blue',resolver);const input=JSON.parse(client.history[0].input);expect(input.role).toBe('intelligence');expect(input.organizationContext.role).toBe('intelligence');expect(s.store.events(w.row.id).find(e=>e.kind==='staff_answer')?.details.organizationContext).toEqual(input.organizationContext);
});

it('keeps unsourced native facts out of citations through nested and direct tool returns',async()=>{
 const{s,w}=await setup(),ctx=s.agentContext(w,'blue','staff');
 const unsourced={id:'unattributed-fact',content:'Supplemental rule',sourceIds:[],evidenceEligible:false};
 const sourced={id:'sourced-fact',content:'Source-backed rule',sourceIds:['native-source'],evidenceEligible:true};
 ctx.domainKnowledge={status:'native',facts:[unsourced,sourced]} as any;
 const allowed=citableIds(ctx,[{domainKnowledge:ctx.domainKnowledge},{facts:[unsourced,sourced]},unsourced,{eventId:'actual-event'}]);
 expect(allowed.has('unattributed-fact')).toBe(false);expect(allowed.has('sourced-fact')).toBe(true);expect(allowed.has('native-source')).toBe(true);expect(allowed.has('actual-event')).toBe(true);
});
