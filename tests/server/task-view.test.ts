import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GameService,type Session} from '../../src/server/service';
import {DeterministicClient} from '../../src/inference';
import {taskView} from '../../src/server/task-view';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).reverse().forEach(f=>f()));
const identity={subject:'staff-learner',name:'Learner',role:'commander' as const,organization:'Synthetic',mode:'local-demo' as const};
async function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-task-view-'));clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}));const s=new GameService(dir);clean.push(()=>s.close());const row=await s.create('Staff retention','plains',identity);const session:Session={identity,activeId:row.id,selectedSide:'blue',playbackTick:null};return {s,dir,row,session,w:s.world(row.id)};}
it('retains a validated model answer after a free update and restart, without new inference',async()=>{
 const {s,dir,row,session,w}=await setup();for(let i=0;i<25;i++)s.tick(w);
 const report=s.store.reports(row.id).find(r=>r.side==='blue');
 const model=new DeterministicClient({respond:()=>({summary:'Compare the available estimate with its stated uncertainty.',sourceIds:[report.id],done:true,calls:[]})});s.luna=model;
 const task=s.createTask(row.id,identity,'Monitor report provenance','blue');
 s.setTaskModel(session,task.id,true);
 for(let i=0;i<40&&!s.store.events(row.id).some(e=>e.kind==='staff_update'&&e.details.method==='model staff agent');i++)await new Promise(r=>setTimeout(r,5));
 const modelEvent=s.store.events(row.id).find(e=>e.kind==='staff_update'&&e.details.method==='model staff agent');expect(modelEvent).toBeDefined();
 s.setTaskModel(session,task.id,false);for(let i=0;i<3;i++)s.tick(w);s.injectReport(row.id);
 const view=(await s.overview(session)).tasks.find(t=>t.id===task.id);
 expect(view).toMatchObject({lastMethod:'deterministic provenance watcher',lastReceiptId:null,modelResult:{eventId:modelEvent!.id,tick:modelEvent!.tick,text:modelEvent!.summary,sourceIds:[report.id],receiptId:'synthetic-0'}});
 expect(view.provenanceResult.tick).toBeGreaterThan(view.modelResult.tick);
 expect(model.history).toHaveLength(1);expect(s.ledger.summary().requestsUsed).toBe(0);
 const reopened=new GameService(dir);clean.push(()=>reopened.close());await reopened.init(false);
 const restored=(await reopened.overview(session)).tasks.find(t=>t.id===task.id);expect(restored.modelResult).toEqual(view.modelResult);expect(restored.provenanceResult).toEqual(view.provenanceResult);
});
it('reconstructs historical results without future model content, cursors or status',()=>{
 const task={id:'t',owner:'a',side:'blue',title:'watch',createdTick:1,status:'cancelled',modelEnabled:true,kind:'model-staff-agent',baseline:{tick:999},seenReportIds:['future'],lastResult:'future answer',lastReceiptId:'future-receipt',lastModelTick:999};
 const event=(id:string,tick:number,method:string)=>({id,tick,kind:'staff_update',side:'blue',summary:id,details:{taskId:'t',method,sourceIds:[id+'-source'],receiptId:method==='model staff agent'?id+'-receipt':null}});
 const events=[event('first-free',3,'deterministic provenance watcher'),event('first-model',5,'model staff agent'),event('later-free',7,'deterministic provenance watcher'),event('future',20,'model staff agent')];
 const before=taskView(task,events,4);expect(before).toMatchObject({status:'historical',phase:'historical',modelEnabled:false,lastResult:'first-free',lastReceiptId:null,modelResult:null,lastModelTick:null});expect(JSON.stringify(before)).not.toContain('future');expect(before.baseline).toBeUndefined();expect(before.seenReportIds).toBeUndefined();
 const middle=taskView(task,events,7);expect(middle).toMatchObject({lastResult:'later-free',modelResult:{text:'first-model',tick:5},provenanceResult:{text:'later-free',tick:7}});expect(JSON.stringify(middle)).not.toContain('future');
 expect(taskView(task,events,1).lastResult).toBeNull();expect(task.lastResult).toBe('future answer');
});
it('shows only validated updates for the exact task and side, not rejected model drafts',()=>{
 const task={id:'t',side:'blue',createdTick:1};
 const e={id:'bad',tick:3,kind:'staff_model_decision',side:'blue',summary:'invalid draft',details:{taskId:'t',method:'model staff agent'}};
 expect(taskView(task,[e,{...e,id:'other-task',kind:'staff_update',details:{...e.details,taskId:'different'}},{...e,id:'other-side',kind:'staff_update',side:'red'}]).modelResult).toBeNull();
});
it('uses the recorded watch interpretation at creation without future comparison state',()=>{
 const config={schema:'replay.watch-config/1',kind:'reserve',threshold:{unit:'forces',value:1000},defaultThreshold:false};
 const task={id:'t',side:'blue',createdTick:3,title:'Watch reserves below 1000',watchConfig:{...config,threshold:{unit:'forces',value:9999}},interpretation:'future edit',watchState:{tick:999,available:999}};
 const creation={id:'created',tick:3,kind:'task_created',side:'blue',summary:'Watch assigned',details:{taskId:'t',watchConfig:config,interpretation:'Below 1000 own available forces'}};
 const historic=taskView(task,[creation],3);
 expect(historic.watchConfig).toEqual(config);expect(historic.interpretation).toBe(creation.details.interpretation);
 expect(historic.watchState).toBeUndefined();expect(historic.lastResult).toBeNull();
 expect(taskView(task,[creation],2).watchConfig).toBeUndefined();
 expect(taskView(task,[{...creation,side:'red'}],3).watchConfig).toBeUndefined();
 expect(taskView(task,[],3).watchConfig).toBeUndefined();
});
