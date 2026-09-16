import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetLedger,BudgetCapError} from '../../src/inference/ledger';
import {LunaClient} from '../../src/inference/luna-client';
import {LunaChatClient} from '../../src/inference/luna-chat-client';
import {readModelRoute} from '../../src/server/model-config';

const dirs:string[]=[];const ledgers:BudgetLedger[]=[];
const env:NodeJS.ProcessEnv={REPLAY_MODEL_BILLING:'external',REPLAY_MODEL_TRANSPORT:'responses',REPLAY_MODEL_CREDENTIAL_MODE:'sponsored',REPLAY_MODEL_ALLOWANCE:'unlimited',OPENAI_API_KEY:'synthetic-offline-sponsored-key',OPENAI_PROJECT:'proj_syntheticUnlimited',REPLAY_MODEL_ID:'gpt-5.6-sol',REPLAY_MODEL_REASONING:'low',REPLAY_CHAT_REASONING:'low'};
function dir(){const d=mkdtempSync(join(tmpdir(),'replay-unlimited-'));dirs.push(d);return d;}
function ledger(d:string,unlimited=false){const l=new BudgetLedger({path:join(d,'inference.sqlite'),...(unlimited?{maxUsd:'unlimited' as const,maxRequests:'unlimited' as const}:{})});ledgers.push(l);return l;}
const reserve=(l:BudgetLedger,micro:number)=>l.reserve({purpose:'synthetic.allowance-test',modelRequested:'gpt-5.6-sol',reservedMicro:micro});
const settle=(l:BudgetLedger,id:string,micro:number)=>l.settle(id,{settledMicro:micro,inputTokens:1,cachedInputTokens:0,outputTokens:1,modelReturned:'gpt-5.6-sol',providerResponseId:null,providerRequestId:null,durationMs:1,httpStatus:200});
afterEach(()=>{for(const l of ledgers.splice(0))l.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.unstubAllGlobals();});

describe('explicit sponsored allowance admission',()=>{
 it('requires opt-in and leaves standard, sponsored-default and local defaults capped',()=>{
  const d=dir();expect(readModelRoute(d,{})).toMatchObject({maxUsd:5,maxRequests:100});
  expect(readModelRoute(d,{...env,REPLAY_MODEL_ALLOWANCE:undefined})).toMatchObject({maxUsd:5,maxRequests:100});
  expect(readModelRoute(d,{...env,REPLAY_MODEL_ALLOWANCE:undefined,REPLAY_MODEL_BILLING:'local',REPLAY_MODEL_TRANSPORT:'chat-completions',REPLAY_MODEL_BASE_URL:'http://127.0.0.1:9999/v1',REPLAY_MODEL_ID:'local-fixture'})).toMatchObject({maxUsd:0,maxRequests:100,ledgerFile:'local-inference.sqlite'});
  expect(readModelRoute(d,env)).toMatchObject({sponsored:true,model:'gpt-5.6-sol',maxUsd:'unlimited',maxRequests:'unlimited',ledgerFile:'inference.sqlite',timeoutMs:60000,reasoningEffort:'low',chatReasoningEffort:'low'});
 });
 it.each([
  {REPLAY_MODEL_CREDENTIAL_MODE:'standard'},{REPLAY_MODEL_CREDENTIAL_MODE:undefined},{REPLAY_MODEL_CREDENTIAL_MODE:'unknown'},
  {OPENAI_API_KEY:undefined},{OPENAI_API_KEY:''},{OPENAI_API_KEY:'   '},
  {OPENAI_PROJECT:undefined},{OPENAI_PROJECT:''},{OPENAI_PROJECT:'not-a-project'},
  {REPLAY_MODEL_ALLOWANCE:'Infinity'},{REPLAY_MODEL_ALLOWANCE:''},{REPLAY_MODEL_BILLING:'local'},
  {REPLAY_MODEL_BASE_URL:'https://other-provider.invalid/v1'},
 ])('refuses incomplete or unsupported configuration before network: %j',override=>{
  const d=dir();writeFileSync(join(d,'luna.env'),'OPENAI_API_KEY=synthetic-personal-fallback\n');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  expect(()=>readModelRoute(d,{...env,...override})).toThrow();expect(fetch).not.toHaveBeenCalled();
 });
});

it('preserves durable rows across capped→unlimited→capped restarts and accounts above both old limits',()=>{
 const d=dir();let l=ledger(d);const old=reserve(l,100);settle(l,old.id,73);const previous=l.listReceipts();l.close();
 l=ledger(d,true);expect(l.listReceipts()).toEqual(previous);
 const paid=reserve(l,6_000_000);settle(l,paid.id,5_500_000);
 const pending=reserve(l,110);const uncertain=reserve(l,220);l.markUncertain(uncertain.id,{durationMs:1,errorCode:'synthetic-timeout'});
 const failed=reserve(l,330);l.release(failed.id,{durationMs:1,httpStatus:429,errorCode:'http_429'});
 for(let i=0;i<100;i++)reserve(l,0);
 const expected=l.listReceipts();const summary=l.summary();
 expect(summary).toMatchObject({allowance:'unlimited',requestsUsed:105,maxUsd:'unlimited',maxRequests:'unlimited',maxMicro:'unlimited',remainingRequests:'unlimited',remainingMicro:'unlimited',completedMicro:5_500_073,reservedMicro:110,uncertainMicro:220,committedMicro:5_500_403});
 expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);expect(l.get(pending.id)?.status).toBe('reserved');
 l.close();l=ledger(d,true);expect(l.listReceipts()).toEqual(expected);expect(l.summary()).toEqual(summary);
 l.reconcile(uncertain.id,150);expect(l.summary().committedMicro).toBe(5_500_333);
 l.close();l=ledger(d);expect(()=>reserve(l,0)).toThrow(BudgetCapError);expect(l.listReceipts()).toHaveLength(105);
});

it('rejects mixed unlimited limits and malformed reservations instead of weakening accounting',()=>{
 expect(()=>new BudgetLedger({path:':memory:',maxUsd:'unlimited'})).toThrow('both request and dollar');
 expect(()=>new BudgetLedger({path:':memory:',maxRequests:'unlimited'})).toThrow('both request and dollar');
 const l=ledger(dir(),true);for(const n of [-1,Infinity,NaN,0.5])expect(()=>reserve(l,n)).toThrow();expect(l.listReceipts()).toHaveLength(0);
});

describe.each([false,true])('per-request limits with unlimited ledger, chat=%s',chat=>{
 it('retains input/output limits before reservation and a single uncertain receipt on timeout',async()=>{
  const l=ledger(dir(),true);const fetch=vi.fn(()=>new Promise<Response>(()=>{}));
  const options={apiKey:env.OPENAI_API_KEY!,openaiProject:env.OPENAI_PROJECT!,sponsored:true,model:'gpt-5.6-sol',ledger:l,fetchImpl:fetch,timeoutMs:15,maxInputBytes:32768};
  const call=async(input:string,maxOutputTokens=100)=>chat?new LunaChatClient(options).complete({messages:[{role:'user',content:input}],purpose:'synthetic.limits',maxOutputTokens}):new LunaClient(options).complete({instructions:'x',input,purpose:'synthetic.limits',maxOutputTokens});
  await expect(call('x'.repeat(40000))).rejects.toThrow();await expect(call('x',999999)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();expect(l.listReceipts()).toHaveLength(0);
  await expect(call('x')).rejects.toMatchObject({code:'timeout'});expect(fetch).toHaveBeenCalledTimes(1);
  const [receipt]=l.listReceipts();expect(receipt).toMatchObject({status:'uncertain',errorCode:'timeout'});expect(receipt!.reservedMicro).toBeGreaterThan(0);expect(l.summary().uncertainMicro).toBe(receipt!.reservedMicro);
 });
});
