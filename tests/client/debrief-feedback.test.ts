import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {DebriefFeedbackPanel} from '../../src/client/components/DebriefFeedbackPanel';
import type {DebriefRecord} from '../../src/client/learning-api';

const record:DebriefRecord={exerciseId:'run-1',eventId:'order-1',hash:'hash-1',author:'learner',generatedAt:'2026-09-14T12:00:00Z',debrief:{headline:{text:'Decision recorded',citations:['order-1']},observations:[{text:'<script>unsupported interpretation</script>',citations:['source-1']}],opponentPerspective:[],tradeoffs:[],questions:[],nextPractice:[],limitations:[]},markdown:'Original output',references:[{id:'source-1',kind:'report',availability:'available-then',content:'Source at the time',tick:10}],availableThenIds:['source-1'],hindsightIds:[],receipt:{id:'receipt-1',status:'completed',modelRequested:'fixture',modelReturned:'fixture',settledUsd:null,createdAt:'2026-09-14T12:00:00Z'},prompt:{truncated:false,inputChars:10}};
describe('debrief feedback initial render',()=>{
 it('keeps the original claim escaped and does not invent a saved instructor interpretation or permission',()=>{
  const html=renderToStaticMarkup(React.createElement(DebriefFeedbackPanel,{record,stale:false,playbackTick:null,onOpenEvidence:()=>{}}));
  expect(html).toContain('Original AI finding');
  expect(html).toContain('&lt;script&gt;unsupported interpretation&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('Save instructor review');
  expect(html).not.toContain('Latest instructor interpretation');
  expect(html).toContain('not automatic mastery scores');
 });
});
