/** Closed, text-free categories for a rejected Chat request. Never retain provider prose. */
export interface ChatFailureDiagnostics {
 errorType:'invalid_request_error'|'authentication_error'|'permission_error'|'rate_limit_error'|'server_error'|'other'|'missing';
 parameter:'model'|'messages'|'tools'|'tool_choice'|'max_completion_tokens'|'reasoning_effort'|'store'|'stream'|'n'|'other'|'missing';
 messageClass:'unsupported_parameter'|'unsupported_endpoint'|'invalid_tool_schema'|'unknown_model'|'invalid_messages'|'other'|'missing';
}
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function chatFailureDiagnostics(body:unknown):ChatFailureDiagnostics {
 const e=object(body)&&object(body.error)?body.error:null;
 const types=['invalid_request_error','authentication_error','permission_error','rate_limit_error','server_error'];
 const fields=['model','messages','tools','tool_choice','max_completion_tokens','reasoning_effort','store','stream','n'];
 const parameter=typeof e?.param==='string'?e.param.split(/[.\[]/,1)[0]:null;
 const message=typeof e?.message==='string'?e.message.toLowerCase():null;
 const messageClass:ChatFailureDiagnostics['messageClass']=message===null?'missing':
  /(?:not supported|does not support|unsupported).{0,80}(?:chat completions|chat\/completions|endpoint)|(?:chat completions|chat\/completions|endpoint).{0,80}(?:not supported|does not support|unsupported)/.test(message)?'unsupported_endpoint':
  /(?:unsupported|not supported|does not support).{0,60}(?:parameter|argument)|(?:parameter|argument).{0,60}(?:unsupported|not supported)/.test(message)?'unsupported_parameter':
  message.includes('schema')&&(message.includes('tool')||message.includes('function'))?'invalid_tool_schema':
  message.includes('model')&&/(?:does not exist|not found|unknown model)/.test(message)?'unknown_model':
  message.includes('messages')&&/(?:invalid|must|expected)/.test(message)?'invalid_messages':'other';
 return {errorType:(e?.type==null?'missing':types.includes(String(e.type))?e.type:'other') as ChatFailureDiagnostics['errorType'],parameter:(parameter===null?'missing':fields.includes(parameter)?parameter:'other') as ChatFailureDiagnostics['parameter'],messageClass};
}
