import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BudgetLedger,LunaClient,type FetchImpl} from '../../src/inference/index';

const PRIVATE_TEXT='private intermediate content must not reach diagnostics';
let dir:string,ledger:BudgetLedger;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'replay-selection-'));ledger=new BudgetLedger({path:join(dir,'budget.sqlite'),maxUsd:5,maxRequests:100});});
afterEach(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
function message(text:string,phase?:unknown,status:unknown='completed'){
 return {type:'message',role:'assistant',phase,status,content:[{type:'output_text',text}]};
}
function harness(output:unknown[]){
 const fetchImpl=vi.fn<FetchImpl>(async()=>new Response(JSON.stringify({status:'completed',model:'gpt-5.6-luna',output,usage:{input_tokens:3123,output_tokens:171}}),{status:200,headers:{'content-type':'application/json'}}));
 return {fetchImpl,client:new LunaClient({apiKey:'synthetic-selection-fixture',ledger,fetchImpl})};
}
const request={instructions:'Use supplied evidence',input:'synthetic scenario',purpose:'selection qualification',jsonSchema:{name:'decision',schema:{type:'object'}}};

describe('Luna completed-answer selection',()=>{
 it('parses only final JSON after a prose preamble and reasoning item, while settling the entire response',async()=>{
  const {client,fetchImpl}=harness([{type:'reasoning',summary:[{text:PRIVATE_TEXT}]},message(PRIVATE_TEXT,'commentary'),message('{"calls":[],"summary":"Hold"}','final_answer')]);
  const result=await client.complete(request);
  expect(result.parsed).toEqual({calls:[],summary:'Hold'});
  expect(result.text).not.toContain(PRIVATE_TEXT);
  expect(result.diagnostics).toMatchObject({selection:{mode:'final_answer',selectedMessages:1,ignoredMessages:1,failure:null},messageItems:2,textShape:'json_object',outputTokens:171});
  expect(JSON.stringify(result.diagnostics)).not.toContain(PRIVATE_TEXT);
  expect(JSON.stringify(ledger.listReceipts())).not.toContain(PRIVATE_TEXT);
  expect(result.receipt).toMatchObject({inputTokens:3123,outputTokens:171,errorCode:null,status:'completed'});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
 it('does not execute valid JSON carried by commentary or combine unphased text with an explicit final',async()=>{
  const {client}=harness([message('{"calls":["wrong-order"]}','commentary'),message('unphased preamble'),message('{"calls":[]}','final_answer')]);
  expect((await client.complete(request)).parsed).toEqual({calls:[]});
 });
 it('combines text parts inside one final message',async()=>{
  const final=message('','final_answer');final.content=[{type:'output_text',text:'{"accepted":'},{type:'output_text',text:'true}'}];
  const {client}=harness([final]);expect((await client.complete(request)).parsed).toEqual({accepted:true});
 });
 it('retains legacy unphased message concatenation, including absent and null phases',async()=>{
  const {client}=harness([message('{"accepted":'),message('true}',null)]);
  const result=await client.complete(request);expect(result.parsed).toEqual({accepted:true});expect(result.diagnostics?.selection?.mode).toBe('legacy');
 });
 it('selects final plaintext for one-shot staff questions too',async()=>{
  const {client}=harness([message(PRIVATE_TEXT,'commentary'),message('Report A supersedes report B.','final_answer')]);
  expect((await client.complete({...request,jsonSchema:undefined})).text).toBe('Report A supersedes report B.');
 });
 it.each([
  ['commentary only',[message('{"calls":[]}','commentary')],'missing_final_answer'],
  ['commentary plus unphased',[message('Preamble','commentary'),message('{"calls":[]}')],'missing_final_answer'],
  ['two final answers',[message('{"a":1}','final_answer'),message('{"a":2}','final_answer')],'multiple_final_answers'],
  ['unknown phase',[message('{}',PRIVATE_TEXT)],'unknown_phase'],
  ['unknown alongside final',[message('{}',PRIVATE_TEXT),message('{}','final_answer')],'unknown_phase'],
  ['non-assistant output',[{...message('{}','final_answer'),role:'user'}],'unexpected_message_role'],
  ['unfinished final',[message('{}','final_answer','in_progress')],'unfinished_message'],
  ['incomplete legacy',[message('{}',undefined,'incomplete')],'unfinished_message'],
  ['unknown message status',[message('{}','final_answer',PRIVATE_TEXT)],'unfinished_message'],
 ] as const)('rejects %s, settles usage and does not retry',async(_name,output,reason)=>{
  const {client,fetchImpl}=harness([...output]);
  let error:any;try{await client.complete(request);}catch(e){error=e;}
  expect(error).toMatchObject({code:'malformed_response',receiptId:expect.any(String),diagnostics:{selection:{mode:'rejected',failure:reason}}});
  expect(JSON.stringify(error)).not.toContain(PRIVATE_TEXT);
  expect(ledger.listReceipts()[0]).toMatchObject({status:'completed',outputTokens:171,errorCode:`answer_selection:${reason}`});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
 });
 it('checks all messages for competing finals beyond the eight-message diagnostic sample',async()=>{
  const {client}=harness([...Array.from({length:8},()=>message('preamble','commentary')),message('{}','final_answer'),message('{}','final_answer')]);
  await expect(client.complete(request)).rejects.toMatchObject({diagnostics:{selection:{failure:'multiple_final_answers'},messageItems:10,messageShapes:expect.arrayContaining([expect.objectContaining({phase:'commentary'})])}});
  expect(ledger.listReceipts()[0].errorCode).toBe('answer_selection:multiple_final_answers');
 });
 it('rejects refusal mixed with otherwise valid output',async()=>{
  const final=message('{}','final_answer');const {client}=harness([{...final,content:[...final.content,{type:'refusal',refusal:PRIVATE_TEXT}]}]);
  await expect(client.complete(request)).rejects.toMatchObject({code:'malformed_response'});expect(ledger.listReceipts()[0].errorCode).toBe('refusal');
 });
 it('rejects empty final text even for a plain staff question',async()=>{
  const {client}=harness([message('  ','final_answer')]);await expect(client.complete({...request,jsonSchema:undefined})).rejects.toMatchObject({code:'malformed_response'});expect(ledger.listReceipts()[0].errorCode).toBe('empty_output_text');
 });
 it('does not repair a malformed final using a valid commentary object',async()=>{
  const {client}=harness([message('{"calls":[]}','commentary'),message('{"calls":','final_answer')]);await expect(client.complete(request)).rejects.toMatchObject({code:'malformed_response'});expect(ledger.listReceipts()[0].errorCode).toBe('malformed_output:unbalanced_json');
 });
});
