import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {expect,it} from 'vitest';
import {DecisionTraceContent,DecisionTracePanel,decisionTraceSelectionKey} from '../../src/client/components/DecisionTracePanel';import {decisionTrace} from '../../src/review/decision-trace';
it('distinguishes accepted orders from measured results and does not manufacture a model explanation',()=>{
 const trace=decisionTrace({eventId:'human',side:'blue',cutoffTick:5,reports:[],events:[{id:'human',tick:4,kind:'command',summary:'Choice',side:'blue',actor:'participant',details:{commandId:'c',origin:'human',intent:{type:'attack',troops:10},observation:{tick:3,fingerprint:'abc',sourceIds:[]}}}]});
 const html=renderToStaticMarkup(createElement(DecisionTraceContent,{trace}));expect(html).toContain('participant');expect(html).toContain('accepted');expect(html).toContain('Participant order; no model explanation applies.');expect(html).toContain('No measured execution feedback');expect(html).toContain('does not establish decision quality');expect(html).not.toContain('blunder');
});
it('shows missing evidence when a selection is not an available command',()=>{const html=renderToStaticMarkup(createElement(DecisionTraceContent,{trace:decisionTrace({eventId:'missing',side:'red',cutoffTick:5,reports:[],events:[]})}));expect(html).toContain('Selected command is unavailable');expect(html).not.toContain('Recorded choice');});

const selection={exerciseId:'exercise',eventId:'human',side:'blue' as const,cutoffTick:5,canShowLater:true};
function humanTrace(){
 return decisionTrace({eventId:'human',side:'blue',cutoffTick:5,reports:[],events:[{id:'human',tick:4,kind:'command',summary:'Choice',side:'blue',actor:'participant',details:{commandId:'c',origin:'human',intent:{type:'attack',troops:10},observation:{tick:3,sourceIds:[]}}}]});
}
it('offers an unchecked hindsight choice only for an eligible selected order and keeps the map tick explicit',()=>{
 const html=renderToStaticMarkup(createElement(DecisionTracePanel,selection));
 expect(html).toContain('type="checkbox"');expect(html).toContain('Include later outcomes');expect(html).not.toContain('checked=""');
 expect(html).toContain('The map stays at tick 5');expect(html).toContain('Loading this moment');expect(html).not.toContain('Recorded choice');
 for(const props of [{...selection,canShowLater:false},{...selection,canShowLater:undefined},{...selection,eventId:null}]){
  expect(renderToStaticMarkup(createElement(DecisionTracePanel,props))).not.toContain('type="checkbox"');
 }
});
it('remounts consent and fetched evidence for every selection, time or eligibility change',()=>{
 const panel=createElement(DecisionTracePanel,selection);
 const bound=DecisionTracePanel(panel.props);
 expect(bound.key).toBe(decisionTraceSelectionKey(selection));
 for(const changed of [{exerciseId:'other'},{eventId:'other'},{eventId:null},{side:'red' as const},{cutoffTick:6},{canShowLater:false}]){
  expect(DecisionTracePanel({...selection,...changed}).key).not.toBe(bound.key);
 }
 expect(decisionTraceSelectionKey({...selection,canShowLater:undefined})).toBe(decisionTraceSelectionKey({...selection,canShowLater:false}));
});
it('uses response scope and both returned ticks to label later evidence without relabeling ordinary review',()=>{
 const trace=humanTrace();
 const later=renderToStaticMarkup(createElement(DecisionTraceContent,{trace:{...trace,cutoffTick:20,review:{viewTick:5,scope:'later-outcomes'}}}));
 expect(later).toContain('Later measured outcomes (hindsight)');expect(later).toContain('map remains at tick 5');expect(later).toContain('extends through tick 20');
 expect(later).toContain('No measured execution feedback');expect(later).not.toContain('What happened by this point');
 const asOf=renderToStaticMarkup(createElement(DecisionTraceContent,{trace:{...trace,review:{viewTick:5,scope:'as-of'}}}));
 expect(asOf).toContain('Evidence as of map tick 5');expect(asOf).toContain('What happened by this point');expect(asOf).not.toContain('Later measured outcomes');
});
it('renders supplied participant totals, identifies snapshot provenance and leaves missing snapshots explicit',()=>{
 const trace=humanTrace(),observation=trace.observation.value!;
 observation.basis='app-snapshot-returned-with-order';
 observation.knownState={self:{troops:120,tiles:8,alive:true,attacksInFlight:null,structures:null,gold:null,maxTroops:null},opponent:{troops:null,tiles:6,alive:true,attacksInFlight:null,structures:null}};
 const html=renderToStaticMarkup(createElement(DecisionTraceContent,{trace}));
 expect(html).toContain('Recorded game totals');expect(html).toContain('Own side');expect(html).toContain('Visible opponent');expect(html).toContain('<td>120</td>');expect(html).toContain('<td>Not recorded</td>');
 expect(html).toContain('Snapshot returned with the order; this does not establish human attention.');expect(html).toContain('Participant order; no model explanation applies.');
 const missing=renderToStaticMarkup(createElement(DecisionTraceContent,{trace:humanTrace()}));
 expect(missing).toContain('Game totals were not recorded');expect(missing).not.toContain('<table>');
 trace.observation={status:'missing',value:null,reason:'No exact observation was recorded.'};
 expect(renderToStaticMarkup(createElement(DecisionTraceContent,{trace}))).toContain('No exact observation was recorded.');
});
it('marks later sources as hindsight and formats measured statuses while preserving model receipts and facts',()=>{
 const trace=decisionTrace({eventId:'command',side:'red',cutoffTick:20,reports:[{id:'later',tick:10,side:'red',title:'Later report'}],events:[
  {id:'model',tick:3,kind:'model_decision',summary:'Recorded external summary',side:'red',actor:'agent',details:{receipt:{id:'receipt',status:'completed',modelReturned:'recorded-model'},sourceIds:['later'],observation:{tick:3,sourceIds:[]}}},
  {id:'tool',tick:3,kind:'tool_result',summary:'Submission',side:'red',details:{tool:'submit_order',receiptId:'receipt',output:{id:'c',status:'queued'}}},
  {id:'command',tick:4,kind:'command',summary:'Choice',side:'red',details:{commandId:'c',origin:'luna',intent:{type:'boat'}}},
  ...['transport-launched','transport_arrived'].map((status,index)=>({id:`feedback-${index}`,tick:12+index,kind:'execution_feedback',summary:'Measured result',side:'red' as const,details:{commandId:'c',feedback:{tick:12+index,status,observed:{kind:'transport',troopsEmbarked:40}}}})),
 ]});
 const html=renderToStaticMarkup(createElement(DecisionTraceContent,{trace:{...trace,review:{viewTick:5,scope:'later-outcomes'}}}));
 for(const text of ['transport launched','transport arrived','hindsight: released after the recorded observation','released tick 10','external-summary','Recorded external summary','Connected model','<code>receipt</code>','Measured facts','troops Embarked','40'])expect(html).toContain(text);
 expect(html).not.toContain('recorded-model');
 expect(trace.model.value?.receipt.modelReturned).toBe('recorded-model');
 expect(html).not.toContain('transport-launched');expect(html).not.toContain('transport_arrived');expect(html).toContain('does not establish decision quality');
});


it('distinguishes recorded snapshot, admission and measured effect times without showing later evidence early',()=>{
 const events=[
  {id:'order',tick:973,kind:'command',summary:'Choice',side:'blue' as const,details:{commandId:'c',origin:'human',observedTick:971,admittedTick:972,intent:{type:'boat'},observation:{tick:971,sourceIds:[]}}},
  {id:'arrival',tick:977,kind:'execution_feedback',summary:'Arrival',side:'blue' as const,details:{commandId:'c',feedback:{tick:976,status:'transport_arrived'}}},
 ];
 const render=(cutoffTick:number)=>renderToStaticMarkup(createElement(DecisionTraceContent,{trace:decisionTrace({eventId:'order',side:'blue',cutoffTick,reports:[],events})}));
 const html=render(977);
 expect(html).toContain('snapshot at tick 971 · accepted at tick 972 · recorded at tick 973');
 expect(html).toContain('Measured at tick 976 · recorded at tick 977');
 expect(html).not.toContain('tick 978');
 expect(render(976)).not.toContain('transport arrived');
});

it('keeps equal times short and does not infer missing admission or measurement times',()=>{
 const trace=humanTrace(),command=trace.command.value!;
 command.observedTick=4;command.admittedTick=4;
 let html=renderToStaticMarkup(createElement(DecisionTraceContent,{trace}));
 expect(html).toContain('accepted at tick 4');
 expect(html).not.toContain('snapshot at tick 4');
 command.admittedTick=null;command.observedTick=null;
 trace.execution={status:'recorded',reason:null,value:[{eventId:'effect',tick:5,measuredTick:null,status:'transport_arrived',observed:null,inherited:false,sourceExerciseId:null}]};
 html=renderToStaticMarkup(createElement(DecisionTraceContent,{trace}));
 expect(html).toContain('accepted · recorded at tick 4');
 expect(html).toContain('Recorded at tick 5');
 expect(html).not.toContain('Measured at tick');
});
