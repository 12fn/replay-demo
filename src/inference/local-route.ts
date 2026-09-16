import type { PriceTable } from './pricing';

/** API billing only. Electricity, hardware and operation costs are not measured. */
export const LOCAL_API_PRICING: PriceTable = Object.freeze({
  inputMicroPerMillion: 0, cachedInputMicroPerMillion: 0,
  outputMicroPerMillion: 0, cacheWriteMultiplier: { num: 1, den: 1 },
});

/** Local mode must never silently fall back to a paid public endpoint or model. */
export function assertLocalRoute(baseUrl: string | undefined, model: string | undefined): void {
  if (!baseUrl || !model || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(model)) {
    throw new TypeError('Local inference requires an explicit private endpoint and model identity');
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new TypeError('Invalid local inference endpoint'); }
  const host=url.hostname.toLowerCase();
  const v4=host.split('.').map(Number);
  const privateV4=/^\d+\.\d+\.\d+\.\d+$/.test(host) && v4.every(n=>n>=0&&n<=255) &&
    (v4[0]===127 || v4[0]===10 || (v4[0]===192&&v4[1]===168) ||
     (v4[0]===172&&v4[1]>=16&&v4[1]<=31) || (v4[0]===169&&v4[1]===254));
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !(privateV4 || host==='localhost' || host==='[::1]' || host.endsWith('.svc') || host.endsWith('.svc.cluster.local'))) {
    throw new TypeError('Local inference requires a private or Kubernetes service endpoint');
  }
}

export function localReceiptContext(context: Record<string,unknown> | undefined): Record<string,unknown> {
  return {...context,inferenceRoute:'kamiwaza-local',billingBasis:'Zero provider API charge; hardware and operating cost not measured'};
}

/** Translate only a single completed assistant text answer. Never execute tool calls. */
export function chatAsResponses(value: unknown): Record<string,unknown> {
  const j=value as any;
  const c=Array.isArray(j?.choices)&&j.choices.length===1?j.choices[0]:null;
  const valid=c?.message?.role==='assistant'&&typeof c.message.content==='string'&&!c.message.tool_calls?.length&&!c.message.refusal;
  const usage=j?.usage;
  const input=usage?.prompt_tokens,output=usage?.completion_tokens,cached=usage?.prompt_tokens_details?.cached_tokens??0;
  const validUsage=[input,output,cached].every(n=>Number.isSafeInteger(n)&&n>=0)&&cached<=input;
  return {
    id:j?.id,model:j?.model,
    status:valid&&c.finish_reason==='stop'?'completed':c?.finish_reason==='length'?'incomplete':'failed',
    ...(c?.finish_reason==='length'?{incomplete_details:{reason:'max_output_tokens'}}:{}),
    output:valid?[{type:'message',role:'assistant',content:[{type:'output_text',text:c.message.content}]}]:[],
    ...(validUsage?{usage:{input_tokens:input,output_tokens:output,input_tokens_details:{cached_tokens:cached}}}:{}),
  };
}
