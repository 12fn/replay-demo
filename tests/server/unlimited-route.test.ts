import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetLedger} from '../../src/inference/ledger';
import {GameService,type Identity} from '../../src/server/service';

let service:GameService|undefined;let dir:string|undefined;
afterEach(()=>{service?.close();service=undefined;if(dir)rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('retains the 98 paid and two local synthetic history rows, exposes allowance, and pauses paid agents on restart',async()=>{
 dir=mkdtempSync(join(tmpdir(),'replay-unlimited-service-'));
 const paid=new BudgetLedger({path:join(dir,'inference.sqlite')});
 for(let i=0;i<98;i++){const r=paid.reserve({purpose:'synthetic.history',modelRequested:'gpt-5.6-luna',reservedMicro:1000});paid.settle(r.id,{settledMicro:i===0?804:802,inputTokens:1,cachedInputTokens:0,outputTokens:1,modelReturned:'gpt-5.6-luna',providerResponseId:null,providerRequestId:null,durationMs:1,httpStatus:200});}
 const history=paid.listReceipts();expect(paid.summary().committedMicro).toBe(78598);paid.close();
 const local=new BudgetLedger({path:join(dir,'local-inference.sqlite'),maxUsd:0});
 for(let i=0;i<2;i++){const r=local.reserve({purpose:'synthetic.local-history',modelRequested:'local-fixture',reservedMicro:0});local.markUncertain(r.id,{durationMs:1,errorCode:'synthetic-timeout'});}
 const localHistory=local.listReceipts();local.close();
 for(const name of ['REPLAY_MODEL_BASE_URL','REPLAY_MODEL_API_KEY','REPLAY_KEY_FILE','OPENAI_ORGANIZATION'])vi.stubEnv(name,undefined);
 for(const [k,v] of Object.entries({REPLAY_MODEL_BILLING:'external',REPLAY_MODEL_TRANSPORT:'responses',REPLAY_MODEL_CREDENTIAL_MODE:'sponsored',REPLAY_MODEL_ALLOWANCE:'unlimited',OPENAI_API_KEY:'synthetic-unlimited-service-key',OPENAI_PROJECT:'proj_syntheticUnlimitedService',REPLAY_MODEL_ID:'gpt-5.6-sol',REPLAY_MODEL_REASONING:'low',REPLAY_CHAT_REASONING:'low'}))vi.stubEnv(k,v);
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);service=new GameService(dir);
 expect(service.ledger.listReceipts()).toEqual(history);expect(service.ledger.summary()).toMatchObject({allowance:'unlimited',requestsUsed:98,maxRequests:'unlimited',maxUsd:'unlimited',committedMicro:78598});
 const identity:Identity={subject:'synthetic-owner',name:'Synthetic Owner',role:'commander',organization:'Synthetic workshop',mode:'local-demo'};
 const row=await service.create('Synthetic restart fixture','plains',identity);const w=service.world(row.id);service.tick(w);
 const task=service.createTask(row.id,identity,'Watch report provenance','blue');task.modelEnabled=true;task.kind='model-staff-agent';service.store.putTask(row.id,task);
 row.agentEnabled=true;service.store.putExercise(row);service.close();service=undefined;
 service=new GameService(dir);await service.init(false);
 expect(service.world(row.id).row.agentEnabled).toBe(false);expect(service.store.tasks(row.id)[0]).toMatchObject({modelEnabled:false,kind:'provenance-watch'});
 expect(service.ledger.listReceipts()).toEqual(history);
 const unchanged=new BudgetLedger({path:join(dir,'local-inference.sqlite'),maxUsd:0});expect(unchanged.listReceipts()).toEqual(localHistory);unchanged.close();
 expect(fetch).not.toHaveBeenCalled();
 const budget=service.availableTools({identity,activeId:row.id,playbackTick:null,selectedSide:'blue'},'blue').budget;
 expect(budget).toMatchObject({allowance:'unlimited',requestsUsed:98,maxRequests:'unlimited',committedUsd:0.078598,maxUsd:'unlimited'});
});
