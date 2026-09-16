import {LUNA_PRICING, SOL_PRICING} from './pricing';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const REASONING_EFFORTS = ['none','low','medium','high','xhigh','max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ExternalModel = 'gpt-5.6-luna' | 'gpt-5.6-sol';

/** No aliases or unpriced models: a model change must also select its price table. */
export function externalModel(model: string): ExternalModel {
  if (model !== 'gpt-5.6-luna' && model !== 'gpt-5.6-sol') throw new TypeError('Unsupported external model');
  return model;
}
export function modelPricing(model: string) { return externalModel(model) === 'gpt-5.6-sol' ? SOL_PRICING : LUNA_PRICING; }
export function reasoningEffort(value: unknown, model: string, chat = false): ReasoningEffort {
  externalModel(model);
  if (value === undefined) return chat && model === 'gpt-5.6-luna' ? 'none' : 'low';
  if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) throw new TypeError('Unsupported reasoning effort');
  return value as ReasoningEffort;
}
export function isOpenAIBaseUrl(value: string): boolean { return value.replace(/\/+$/, '') === OPENAI_BASE_URL; }

export interface OpenAIHeaderOptions {
  sponsored?: boolean;
  openaiProject?: string;
  openaiOrganization?: string;
  extraHeaders?: Record<string,string>;
}
/** Validate without echoing rejected values. Dedicated fields own identity headers. */
export function providerHeaders(options: OpenAIHeaderOptions, baseUrl: string, local: boolean): Record<string,string> {
  if (options.sponsored && (local || !isOpenAIBaseUrl(baseUrl))) throw new TypeError('Sponsored route requires the OpenAI endpoint');
  const headers: Record<string,string> = {};
  for (const [name,value] of Object.entries(options.extraHeaders ?? {})) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(key) || ['authorization','openai-project','openai-organization','host','content-type','accept'].includes(key)
      || typeof value !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(value)) throw new TypeError('Invalid extra provider header');
    headers[key] = value;
  }
  for (const [key,value,pattern] of [
    ['OpenAI-Project',options.openaiProject,/^proj_[A-Za-z0-9_-]{1,120}$/],
    ['OpenAI-Organization',options.openaiOrganization,/^org-[A-Za-z0-9_-]{1,120}$/],
  ] as const) {
    if (value === undefined) continue;
    if (local || !isOpenAIBaseUrl(baseUrl) || !pattern.test(value)) throw new TypeError('Invalid OpenAI project or organization configuration');
    headers[key] = value;
  }
  return headers;
}

/** Header/credential values cannot enter receipt metadata or serialized diagnostics. */
export function privateValues(apiKey: string, headers: Record<string,string>): string[] { return [apiKey,...Object.values(headers)].filter(Boolean); }
export function containsPrivate(value: string, values: readonly string[]): boolean { return values.some(secret => value.includes(secret)); }
export function safeProviderId(value: unknown, values: readonly string[]): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) && !containsPrivate(value,values) ? value : null;
}
/** A provider may report the selected alias or a dated snapshot of that same model. */
export function matchesRequestedModel(returned: string | null, requested: string): boolean {
  return returned === null || returned === requested || new RegExp(`^${requested.replaceAll('.', '\\.')}-[0-9]{4}-[0-9]{2}-[0-9]{2}$`).test(returned);
}
