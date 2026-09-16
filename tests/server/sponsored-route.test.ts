import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GameService} from '../../src/server/service';

let service:GameService|undefined;let dir:string|undefined;
afterEach(()=>{service?.close();service=undefined;if(dir)rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();vi.unstubAllGlobals();});

it('wires both server clients to the selected sponsored model and preserves spend on restart/model change',async()=>{
  dir=mkdtempSync(join(tmpdir(),'replay-sponsored-service-'));
  // The account-independent sentinel in the old fallback file must never be sent.
  writeFileSync(join(dir,'luna.env'),'OPENAI_API_KEY=synthetic-personal-file-not-used\n');
  for(const name of ['REPLAY_MODEL_BILLING','REPLAY_MODEL_TRANSPORT','REPLAY_MODEL_BASE_URL','REPLAY_MODEL_API_KEY','REPLAY_KEY_FILE'])vi.stubEnv(name,undefined);
  for(const [name,value] of Object.entries({REPLAY_MODEL_CREDENTIAL_MODE:'sponsored',REPLAY_MODEL_ID:'gpt-5.6-sol',REPLAY_MODEL_REASONING:'medium',REPLAY_CHAT_REASONING:'none',OPENAI_API_KEY:'synthetic-sponsored-service-key',OPENAI_PROJECT:'proj_syntheticService',OPENAI_ORGANIZATION:'org-syntheticService'}))vi.stubEnv(name,value);
  const fetchImpl=vi.fn(async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));expect(body.model).toBe('gpt-5.6-sol');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-sponsored-service-key');
    expect(new Headers(init.headers).get('OpenAI-Project')).toBe('proj_syntheticService');
    expect(new Headers(init.headers).get('OpenAI-Organization')).toBe('org-syntheticService');
    if(url.endsWith('/responses')){
      expect(body.reasoning.effort).toBe('medium');
      return new Response(JSON.stringify({id:'resp_fixture',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic response'}]}],usage:{input_tokens:120,input_tokens_details:{cached_tokens:20},output_tokens:30}}));
    }
    expect(url).toBe('https://api.openai.com/v1/chat/completions');expect(body.reasoning_effort).toBe('none');
    return new Response(JSON.stringify({id:'chatcmpl_fixture',object:'chat.completion',created:123,model:body.model,choices:[{index:0,message:{role:'assistant',content:'Synthetic chat'},finish_reason:'stop'}],usage:{prompt_tokens:120,prompt_tokens_details:{cached_tokens:20},completion_tokens:30}}));
  });
  vi.stubGlobal('fetch',fetchImpl);
  service=new GameService(dir);
  expect(service.luna.model).toBe('gpt-5.6-sol');expect(service.lunaChat.model).toBe('gpt-5.6-sol');
  await service.luna.complete({instructions:'x',input:'y',purpose:'synthetic.integration'});
  await service.lunaChat.complete({messages:[{role:'user',content:'y'}],purpose:'synthetic.integration'});
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(service.ledger.summary()).toMatchObject({requestsUsed:2,committedMicro:2216,maxUsd:5,maxRequests:100});
  service.close();service=undefined;
  vi.stubEnv('REPLAY_MODEL_ID','gpt-5.6-luna');service=new GameService(dir);
  expect(service.luna.model).toBe('gpt-5.6-luna');expect(service.ledger.summary()).toMatchObject({requestsUsed:2,committedMicro:2216,maxUsd:5,maxRequests:100});
  expect(service.ledger.listReceipts().every(row=>row.modelRequested==='gpt-5.6-sol'&&row.settledMicro===1108)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
