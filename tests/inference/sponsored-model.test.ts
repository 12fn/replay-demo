import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetLedger} from '../../src/inference/ledger';
import {LunaClient,type FetchImpl,type LunaClientOptions} from '../../src/inference/luna-client';
import {LunaChatClient} from '../../src/inference/luna-chat-client';
import {readModelRoute} from '../../src/server/model-config';
import {SOL_PRICING,LUNA_PRICING,estimateReservationMicro,settlementMicro} from '../../src/inference/pricing';
import {modelPricing,reasoningEffort} from '../../src/inference/external-model';

// Invented offline values, never credentials from an account or environment.
const KEY='synthetic-server-credential-for-offline-tests';
const PROJECT='proj_syntheticOfflineFixture';
const ORG='org-syntheticOfflineFixture';
const dirs:string[]=[];const ledgers:BudgetLedger[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'replay-sponsored-fixture-'));dirs.push(dir);const ledger=new BudgetLedger({path:join(dir,'inference.sqlite'),maxUsd:5,maxRequests:100});ledgers.push(ledger);return {dir,ledger};}
afterEach(()=>{for(const ledger of ledgers.splice(0))ledger.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});vi.restoreAllMocks();});
const responseRequest={instructions:'x',input:'y',purpose:'synthetic.route-check'};
const chatRequest={messages:[{role:'user' as const,content:'y'}],purpose:'synthetic.route-check'};
function provider(chat:boolean,overrides:Record<string,unknown>={}){return chat?{
  id:'chatcmpl_fixture',object:'chat.completion',created:123,model:'gpt-5.6-sol-2026-08-01',
  choices:[{index:0,message:{role:'assistant',content:'Synthetic answer'},finish_reason:'stop'}],
  usage:{prompt_tokens:120,prompt_tokens_details:{cached_tokens:20},completion_tokens:30},...overrides,
}:{id:'resp_fixture',model:'gpt-5.6-sol-2026-08-01',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic answer'}]}],
  usage:{input_tokens:120,input_tokens_details:{cached_tokens:20},output_tokens:30},...overrides};}
function clientFor(chat:boolean,options:LunaClientOptions){return chat?new LunaChatClient(options):new LunaClient(options);}
async function complete(chat:boolean,client:ReturnType<typeof clientFor>){return chat?(client as LunaChatClient).complete(chatRequest):(client as LunaClient).complete(responseRequest);}

describe('server route configuration',()=>{
  it('preserves Luna defaults and the existing shared ledger limits',()=>{
    const {dir}=fixture();writeFileSync(join(dir,'luna.env'),`OPENAI_API_KEY=${KEY}\n`);
    const route=readModelRoute(dir,{});
    expect(route).toMatchObject({model:'gpt-5.6-luna',reasoningEffort:'low',chatReasoningEffort:'none',apiKey:KEY,ledgerFile:'inference.sqlite',maxUsd:5,timeoutMs:25000});
  });
  it('selects Sol and independently configures the two transport efforts',()=>{
    const {dir}=fixture();const route=readModelRoute(dir,{OPENAI_API_KEY:KEY,REPLAY_MODEL_CREDENTIAL_MODE:'sponsored',REPLAY_MODEL_ID:'gpt-5.6-sol',REPLAY_MODEL_REASONING:'medium',REPLAY_CHAT_REASONING:'none',OPENAI_PROJECT:PROJECT,OPENAI_ORGANIZATION:ORG});
    expect(route).toMatchObject({model:'gpt-5.6-sol',sponsored:true,reasoningEffort:'medium',chatReasoningEffort:'none',openaiProject:PROJECT,openaiOrganization:ORG,ledgerFile:'inference.sqlite',maxUsd:5});
  });
  it('never falls back to an existing personal file or local key in sponsored mode',()=>{
    const {dir}=fixture();const file=join(dir,'personal.env');writeFileSync(file,`OPENAI_API_KEY=${KEY}\n`);writeFileSync(join(dir,'luna.env'),`OPENAI_API_KEY=${KEY}\n`);
    for(const OPENAI_API_KEY of [undefined,'','   '])expect(()=>readModelRoute(dir,{REPLAY_MODEL_CREDENTIAL_MODE:'sponsored',REPLAY_KEY_FILE:file,REPLAY_MODEL_API_KEY:KEY,OPENAI_API_KEY})).toThrow('explicit server OPENAI_API_KEY');
  });
  it('keeps local credentials, headers, model, ledger and zero API price isolated',()=>{
    const {dir}=fixture();const route=readModelRoute(dir,{REPLAY_MODEL_BILLING:'local',REPLAY_MODEL_TRANSPORT:'chat-completions',REPLAY_MODEL_BASE_URL:'http://127.0.0.1:9999/v1',REPLAY_MODEL_ID:'local-model',REPLAY_MODEL_API_KEY:'synthetic-local-only',OPENAI_API_KEY:KEY,OPENAI_PROJECT:PROJECT,OPENAI_ORGANIZATION:ORG,REPLAY_MODEL_CREDENTIAL_MODE:'sponsored'});
    expect(route).toMatchObject({local:true,apiKey:'synthetic-local-only',ledgerFile:'local-inference.sqlite',maxUsd:0,timeoutMs:120000});
    expect(route).not.toHaveProperty('openaiProject');expect(route).not.toHaveProperty('openaiOrganization');
  });
  it.each(['gpt-5.6','gpt-5.6-astra','gpt-6-astra','unpriced-model','gpt-5.6-sol-2026-08-01'])('rejects unpriced or alias model %s',model=>{
    const {dir,ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>();
    expect(()=>readModelRoute(dir,{REPLAY_MODEL_ID:model,OPENAI_API_KEY:KEY})).toThrow('Unsupported external model');
    for(const chat of [false,true])expect(()=>clientFor(chat,{model,apiKey:KEY,ledger,fetchImpl})).toThrow('Unsupported external model');
    expect(fetchImpl).not.toHaveBeenCalled();expect(ledger.listReceipts()).toHaveLength(0);
  });
  it.each(['ultra','', 'LOW','low\n'])('rejects unsupported reasoning %j',value=>{
    const {dir}=fixture();expect(()=>readModelRoute(dir,{REPLAY_MODEL_REASONING:value})).toThrow('Unsupported reasoning effort');
    expect(()=>readModelRoute(dir,{REPLAY_CHAT_REASONING:value})).toThrow('Unsupported reasoning effort');
  });
  it.each(['none','low','medium','high','xhigh','max'])('accepts documented effort %s',value=>expect(reasoningEffort(value,'gpt-5.6-sol')).toBe(value));
  it.each(['http://127.0.0.1:9999/v1','https://provider.invalid/v1','https://api.openai.com.evil.invalid/v1','https://api.openai.com/v1?key=x'])('does not send ambient OpenAI credentials to %s',baseUrl=>{
    const {dir}=fixture();expect(()=>readModelRoute(dir,{OPENAI_API_KEY:KEY,REPLAY_MODEL_BASE_URL:baseUrl})).toThrow('OpenAI endpoint');
  });
  it.each([{OPENAI_PROJECT:'proj_x\r\nAuthorization: bad'},{OPENAI_PROJECT:''},{OPENAI_PROJECT:'not-a-project'},{OPENAI_ORGANIZATION:'org-x\n'},{OPENAI_ORGANIZATION:'bad org'}])('rejects invalid identity headers without echoing values',env=>{
    const {dir}=fixture();let error:unknown;try{readModelRoute(dir,{...env,OPENAI_API_KEY:KEY});}catch(e){error=e;}
    expect(error).toBeInstanceOf(TypeError);for(const value of Object.values(env))if(value)expect(String(error)).not.toContain(value);
  });
});

describe('conservative model pricing',()=>{
  it('uses independent Sol rates including cached reads, cache writes and output',()=>{
    expect(modelPricing('gpt-5.6-sol')).toBe(SOL_PRICING);expect(modelPricing('gpt-5.6-luna')).toBe(LUNA_PRICING);
    // 100 uncached × $5/M + 20 cached × $.40/M + 30 output × $20/M = $0.001108.
    expect(settlementMicro({inputTokens:120,cachedInputTokens:20,outputTokens:30},SOL_PRICING)).toBe(1108);
    expect(settlementMicro({inputTokens:120,cachedInputTokens:20,outputTokens:30},LUNA_PRICING)).toBe(62);
    // 32 KiB + 256 framing tokens at the cache-write rate, plus the full 1600 output ceiling.
    expect(estimateReservationMicro(32768,1600,SOL_PRICING)).toBe(197120);
  });
});

describe.each([false,true])('external client chat=%s',chat=>{
  it('sends server identity headers and selected effort, then settles at Sol rates',async()=>{
    const {ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>(async()=>new Response(JSON.stringify(provider(chat))));
    const client=clientFor(chat,{apiKey:KEY,ledger,fetchImpl,model:'gpt-5.6-sol',reasoningEffort:'medium',sponsored:true,openaiProject:PROJECT,openaiOrganization:ORG});
    const result=await complete(chat,client);const [url,init]=fetchImpl.mock.calls[0]!;const body=JSON.parse(String(init.body));
    expect(url).toBe(`https://api.openai.com/v1/${chat?'chat/completions':'responses'}`);expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({authorization:`Bearer ${KEY}`,'OpenAI-Project':PROJECT,'OpenAI-Organization':ORG});
    expect(chat?body.reasoning_effort:body.reasoning.effort).toBe('medium');expect(body.model).toBe('gpt-5.6-sol');
    expect(result.receipt).toMatchObject({status:'completed',modelRequested:'gpt-5.6-sol',settledMicro:1108});
    expect(result.receipt.reservedMicro).toBeGreaterThan(20000);
    if(!chat)expect(result.receipt.reservedMicro).toBe(21290);
    const dump=JSON.stringify({client,receipts:ledger.listReceipts(),body});
    for(const secret of [KEY,PROJECT,ORG])expect(dump).not.toContain(secret);
  });
  it('reserves Sol costs on the existing ledger without resetting earlier usage or caps',async()=>{
    const {ledger}=fixture();ledger.reserve({purpose:'prior.synthetic',modelRequested:'gpt-5.6-luna',reservedMicro:4990000,context:null});
    const fetchImpl=vi.fn<FetchImpl>();const client=clientFor(chat,{apiKey:KEY,ledger,fetchImpl,model:'gpt-5.6-sol'});
    await expect(complete(chat,client)).rejects.toMatchObject({code:'budget_exceeded'});expect(fetchImpl).not.toHaveBeenCalled();
    expect(ledger.listReceipts()).toHaveLength(1);expect(ledger.summary()).toMatchObject({requestsUsed:1,committedMicro:4990000});
  });
  it.each(['fetch','body'])('keeps the full Sol reservation on a %s timeout, without retry',async phase=>{
    const {ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>(()=>phase==='fetch'?new Promise(()=>{}):Promise.resolve(new Response(new ReadableStream({start(){}}))));
    const client=clientFor(chat,{apiKey:KEY,ledger,fetchImpl,model:'gpt-5.6-sol',timeoutMs:15});
    await expect(complete(chat,client)).rejects.toMatchObject({code:'timeout'});
    const [receipt]=ledger.listReceipts();expect(receipt).toMatchObject({status:'uncertain',errorCode:'timeout'});expect(receipt!.settledMicro).toBe(receipt!.reservedMicro);
    expect(receipt!.reservedMicro).toBeGreaterThan(20000);expect(ledger.summary().committedMicro).toBe(receipt!.reservedMicro);expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('retains the reservation when a provider reports a different priced model',async()=>{
    const {ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>(async()=>new Response(JSON.stringify(provider(chat,{model:'gpt-6-astra'}))));
    await expect(complete(chat,clientFor(chat,{apiKey:KEY,ledger,fetchImpl,model:'gpt-5.6-sol'}))).rejects.toMatchObject({code:'malformed_response'});
    const receipt=ledger.listReceipts()[0]!;expect(receipt).toMatchObject({status:'uncertain',errorCode:'model_mismatch'});expect(receipt.settledMicro).toBe(receipt.reservedMicro);
  });
  it('blocks secret/header metadata before reserving',async()=>{
    const {ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>();const client=clientFor(chat,{apiKey:KEY,ledger,fetchImpl,model:'gpt-5.6-sol',openaiProject:PROJECT,openaiOrganization:ORG});
    for(const secret of [KEY,PROJECT,ORG]){
      const promise=chat?(client as LunaChatClient).complete({...chatRequest,context:{leak:secret}}):(client as LunaClient).complete({...responseRequest,purpose:secret});
      await expect(promise).rejects.toMatchObject({code:'invalid_request'});
    }
    expect(fetchImpl).not.toHaveBeenCalled();expect(ledger.listReceipts()).toHaveLength(0);
  });
  it('redacts provider-echoed identity values from failures and receipts',async()=>{
    const {ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>(async()=>new Response(JSON.stringify({error:{code:PROJECT,message:KEY},id:ORG,model:KEY}),{status:401,headers:{'x-request-id':ORG}}));
    const client=clientFor(chat,{apiKey:KEY,ledger,fetchImpl,model:'gpt-5.6-sol',openaiProject:PROJECT,openaiOrganization:ORG});
    let error:unknown;try{await complete(chat,client);}catch(e){error=e;}
    expect(error).toMatchObject({code:'provider_error'});
    const dump=JSON.stringify({client,error,message:String(error),receipts:ledger.listReceipts()});
    for(const secret of [KEY,PROJECT,ORG])expect(dump).not.toContain(secret);
    expect(ledger.listReceipts()[0]).toMatchObject({status:'uncertain',providerRequestId:null});
  });
  it('rejects header overrides and sponsored cross-provider routing before any reservation',()=>{
    const {ledger}=fixture();const fetchImpl=vi.fn<FetchImpl>();
    const attempts:Record<string,string>[]=[{Authorization:'synthetic-other-key'},{'openai-project':PROJECT},{'OpenAI-Organization':ORG}];
    for(const extraHeaders of attempts)expect(()=>clientFor(chat,{apiKey:KEY,ledger,fetchImpl,extraHeaders})).toThrow('Invalid extra provider header');
    for(const options of [{sponsored:true},{openaiProject:PROJECT},{openaiOrganization:ORG}])expect(()=>clientFor(chat,{apiKey:KEY,ledger,fetchImpl,baseUrl:'https://provider.invalid/v1',...options})).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();expect(ledger.listReceipts()).toHaveLength(0);
  });
});
