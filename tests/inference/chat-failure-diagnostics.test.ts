import {describe,it,expect} from 'vitest';import {chatFailureDiagnostics} from '../../src/inference/chat-failure-diagnostics';
describe('Text-free Chat rejection diagnostics',()=>{
 it('retains useful field/category information without provider prose or arbitrary identifiers',()=>{
  expect(chatFailureDiagnostics({error:{type:'invalid_request_error',code:'private-code',param:'tools[8].function.parameters.private',message:'Invalid schema for function private_function; secret material'}})).toEqual({errorType:'invalid_request_error',parameter:'tools',messageClass:'invalid_tool_schema'});
  const value=chatFailureDiagnostics({error:{type:'sk-private',param:'private-field',message:'secret prompt and private body'}});expect(value).toEqual({errorType:'other',parameter:'other',messageClass:'other'});expect(JSON.stringify(value)).not.toMatch(/sk-private|private-field|secret/);
 });
 it.each([
  ['Unsupported parameter: max_completion_tokens','unsupported_parameter'],
  ['This model does not support chat/completions','unsupported_endpoint'],
  ['The model does not exist','unknown_model'],
  ['Invalid messages: expected a tool result','invalid_messages'],
 ])('classifies a rejection without retaining its message: %s',(message,messageClass)=>{expect(chatFailureDiagnostics({error:{message}}).messageClass).toBe(messageClass);});
 it('keeps absent or malformed error metadata explicit',()=>{for(const body of [null,{},[],{error:'private'}])expect(chatFailureDiagnostics(body)).toEqual({errorType:'missing',parameter:'missing',messageClass:'missing'});});
});
