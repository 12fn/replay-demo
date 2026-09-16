import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readModelRoute} from '../../src/server/model-config';
import {BudgetLedger} from '../../src/inference/ledger';
import {LunaClient,type FetchImpl} from '../../src/inference/luna-client';
import {LunaChatClient} from '../../src/inference/luna-chat-client';

const env={REPLAY_MODEL_ID:'gpt-5.6-sol',REPLAY_MODEL_CREDENTIAL_MODE:'sponsored',REPLAY_MODEL_ALLOWANCE:'unlimited',OPENAI_API_KEY:'synthetic-offline-deadline-fixture',OPENAI_PROJECT:'proj_syntheticDeadline',REPLAY_MODEL_REASONING:'low',REPLAY_CHAT_REASONING:'low'};
const dirs:string[]=[];const ledgers:BudgetLedger[]=[];
afterEach(()=>{vi.useRealTimers();for(const l of ledgers.splice(0))l.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'replay-sol-deadline-'));dirs.push(dir);const route=readModelRoute(dir,env);const ledger=new BudgetLedger({path:join(dir,route.ledgerFile),maxUsd:route.maxUsd,maxRequests:route.maxRequests});ledgers.push(ledger);return{dir,route,ledger};}
function body(chat:boolean){return chat?{id:'chatcmpl_synthetic',object:'chat.completion',created:1,model:'gpt-5.6-sol',choices:[{index:0,message:{role:'assistant',content:'Synthetic complete answer'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}}:{id:'resp_synthetic',status:'completed',model:'gpt-5.6-sol',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic complete answer'}]}],usage:{input_tokens:100,output_tokens:20}};}
function call(chat:boolean,f:ReturnType<typeof fixture>,fetchImpl:FetchImpl){const options={...f.route,ledger:f.ledger,fetchImpl,maxInputBytes:32768};return chat?new LunaChatClient({...options,reasoningEffort:f.route.chatReasoningEffort}).complete({purpose:'synthetic.sol-deadline',messages:[{role:'user',content:'Fictional practice evidence'}],maxOutputTokens:1600}):new LunaClient(options).complete({purpose:'synthetic.sol-deadline',instructions:'Review fictional evidence',input:'Recorded synthetic order',maxOutputTokens:1600});}

it('selects a fixed model deadline independently of allowance and leaves Luna/local deadlines intact',()=>{
 const {dir}=fixture();
 for(const allowance of ['capped','unlimited'])expect(readModelRoute(dir,{...env,REPLAY_MODEL_ALLOWANCE:allowance})).toMatchObject({timeoutMs:60000,reasoningEffort:'low',chatReasoningEffort:'low'});
 expect(readModelRoute(dir,{...env,REPLAY_MODEL_ID:'gpt-5.6-luna'}).timeoutMs).toBe(25000);
 expect(readModelRoute(dir,{REPLAY_MODEL_BILLING:'local',REPLAY_MODEL_TRANSPORT:'chat-completions',REPLAY_MODEL_BASE_URL:'http://127.0.0.1:9999/v1',REPLAY_MODEL_ID:'synthetic-local'})).toMatchObject({timeoutMs:120000,maxUsd:0,ledgerFile:'local-inference.sqlite'});
});

describe.each([false,true])('Sol deadline chat=%s',chat=>{
 it('can settle one response after the old25s limit with unchanged effort/output and actual usage',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});const f=fixture();let signal:AbortSignal|undefined;
  const fetchImpl=vi.fn<FetchImpl>((_url,init)=>{signal=init.signal as AbortSignal;return new Promise(resolve=>setTimeout(()=>resolve(new Response(JSON.stringify(body(chat)))),35000));});
  const pending=call(chat,f,fetchImpl);await vi.advanceTimersByTimeAsync(25001);
  expect(signal?.aborted).toBe(false);expect(f.ledger.listReceipts()[0]?.status).toBe('reserved');
  await vi.advanceTimersByTimeAsync(10000);const result=await pending;
  expect(result.receipt).toMatchObject({status:'completed',inputTokens:100,outputTokens:20,modelReturned:'gpt-5.6-sol',durationMs:35000});
  const sent=JSON.parse(String(fetchImpl.mock.calls[0]![1].body));expect(chat?sent.reasoning_effort:sent.reasoning.effort).toBe('low');expect(chat?sent.max_completion_tokens:sent.max_output_tokens).toBe(1600);
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect(f.ledger.listReceipts()).toHaveLength(1);expect(f.ledger.summary().uncertainMicro).toBe(0);
 });
 it.each(['headers','body'])('aborts a stalled %s at60s and preserves old uncertain spending, without retry',async phase=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']});const f=fixture();
  const old=f.ledger.reserve({purpose:'synthetic.prior-timeout',modelRequested:'gpt-5.6-sol',reservedMicro:88930});f.ledger.markUncertain(old.id,{durationMs:25000,errorCode:'timeout'});const oldRow=f.ledger.get(old.id);
  let signal:AbortSignal|undefined;let lateResolve!: (r:Response)=>void;
  const fetchImpl=vi.fn<FetchImpl>((_url,init)=>{signal=init.signal as AbortSignal;return phase==='headers'?new Promise(resolve=>{lateResolve=resolve;}):Promise.resolve(new Response(new ReadableStream({start(){}})));});
  const observed=call(chat,f,fetchImpl).then(()=>({success:true}),error=>({error}));
  await vi.advanceTimersByTimeAsync(59999);expect(signal?.aborted).toBe(false);expect(f.ledger.listReceipts().filter(x=>x.status==='reserved')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);expect(await observed).toMatchObject({error:{code:'timeout'}});expect(signal?.aborted).toBe(true);
  const fresh=f.ledger.listReceipts().find(x=>x.id!==old.id)!;expect(fresh).toMatchObject({status:'uncertain',errorCode:'timeout',durationMs:60000});expect(fresh.settledMicro).toBe(fresh.reservedMicro);
  expect(f.ledger.get(old.id)).toEqual(oldRow);expect(f.ledger.summary().uncertainMicro).toBe(88930+fresh.reservedMicro);expect(fetchImpl).toHaveBeenCalledTimes(1);
  if(phase==='headers')lateResolve(new Response(JSON.stringify(body(chat))));
  await vi.advanceTimersByTimeAsync(120000);expect(fetchImpl).toHaveBeenCalledTimes(1);expect(f.ledger.get(fresh.id)).toEqual(fresh);
  f.ledger.close();const reopened=new BudgetLedger({path:join(f.dir,'inference.sqlite'),maxUsd:'unlimited',maxRequests:'unlimited'});ledgers.push(reopened);expect(reopened.get(old.id)).toEqual(oldRow);expect(reopened.get(fresh.id)).toEqual(fresh);
 });
});
