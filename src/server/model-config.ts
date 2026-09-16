import fs from 'node:fs';
import path from 'node:path';
import {assertLocalRoute} from '../inference/local-route';
import {externalModel, reasoningEffort, providerHeaders, isOpenAIBaseUrl, OPENAI_BASE_URL} from '../inference/external-model';
import type {BudgetLimit} from '../inference/allowance';

export function readModelRoute(dataDir:string,env:NodeJS.ProcessEnv=process.env){
  const allowance=env.REPLAY_MODEL_ALLOWANCE??'capped';
  if(!['capped','unlimited'].includes(allowance))throw new TypeError('Unsupported model allowance');
  const unlimited=allowance==='unlimited';
  const local=env.REPLAY_MODEL_BILLING==='local';
  if(env.REPLAY_MODEL_BILLING && !['local','external'].includes(env.REPLAY_MODEL_BILLING))throw new TypeError('Unsupported REPLAY_MODEL_BILLING');
  if(local){
    if(unlimited)throw new TypeError('Unlimited allowance requires an external sponsored route');
    if(env.REPLAY_MODEL_TRANSPORT!=='chat-completions')throw new TypeError('Local inference requires chat-completions transport');
    assertLocalRoute(env.REPLAY_MODEL_BASE_URL,env.REPLAY_MODEL_ID);
    return {local:true,baseUrl:env.REPLAY_MODEL_BASE_URL!,model:env.REPLAY_MODEL_ID!,apiKey:env.REPLAY_MODEL_API_KEY??'',ledgerFile:'local-inference.sqlite',maxUsd:0 as BudgetLimit,maxRequests:100 as BudgetLimit,timeoutMs:120000};
  }
  if(env.REPLAY_MODEL_TRANSPORT && env.REPLAY_MODEL_TRANSPORT!=='responses')throw new TypeError('External route requires responses transport');
  const mode=env.REPLAY_MODEL_CREDENTIAL_MODE??'standard';
  if(!['standard','sponsored'].includes(mode))throw new TypeError('Unsupported model credential mode');
  const sponsored=mode==='sponsored';
  if(unlimited&&!sponsored)throw new TypeError('Unlimited allowance requires sponsored credential mode');
  const model=externalModel(env.REPLAY_MODEL_ID??'gpt-5.6-luna');
  const effort=reasoningEffort(env.REPLAY_MODEL_REASONING,model);
  const chatEffort=reasoningEffort(env.REPLAY_CHAT_REASONING,model,true);
  const baseUrl=env.REPLAY_MODEL_BASE_URL??OPENAI_BASE_URL;
  // Ambient OpenAI credentials must never be sent to a different provider.
  if(!isOpenAIBaseUrl(baseUrl))throw new TypeError('External route requires the OpenAI endpoint');
  const openaiProject=env.OPENAI_PROJECT,openaiOrganization=env.OPENAI_ORGANIZATION;
  providerHeaders({sponsored,openaiProject,openaiOrganization},baseUrl,false);
  if(unlimited&&!openaiProject)throw new TypeError('Unlimited allowance requires an explicit valid OPENAI_PROJECT');
  let key=env.OPENAI_API_KEY??'';
  const file=env.REPLAY_KEY_FILE??path.join(dataDir,'luna.env');
  if(!sponsored&&!key&&fs.existsSync(file)){const m=fs.readFileSync(file,'utf8').match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.+)$/m);if(m)key=m[1].trim().replace(/^['"]|['"]$/g,'');}
  if(sponsored&&!key.trim())throw new TypeError('Sponsored route requires an explicit server OPENAI_API_KEY');
  // One bounded request, including response-body reading. A timeout remains uncertain spend;
  // increasing Sol's observation window never retries it or changes output/usage limits.
  const timeoutMs=model==='gpt-5.6-sol'?60000:25000;
  return {local:false,baseUrl,model,apiKey:key,sponsored,openaiProject,openaiOrganization,reasoningEffort:effort,chatReasoningEffort:chatEffort,ledgerFile:'inference.sqlite',maxUsd:(unlimited?'unlimited':5) as BudgetLimit,maxRequests:(unlimited?'unlimited':100) as BudgetLimit,timeoutMs};
}
