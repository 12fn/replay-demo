import {describe,expect,it} from 'vitest';
import {nextFocusStep,type FocusRequest} from '../../src/client/views/ReviewView';

const view=(o:Partial<Parameters<typeof nextFocusStep>[1]>={})=>({highlightId:'report-7',displayedTick:120,perspective:'blue' as const,seeking:false,selectedReportId:null,...o});

describe('review navigation after an explicit selection',()=>{
 it('waits for the asynchronous seek, then scrolls to Source perspective rather than the older report card',()=>{
  const req:FocusRequest={seq:1,id:'report-7',tick:80};
  // Seek in flight: the old tick is still displayed and the report panel may not be for this cutoff yet.
  expect(nextFocusStep(req,view({seeking:true}))).toEqual({kind:'wait'});
  expect(nextFocusStep(req,view({displayedTick:80,selectedReportId:'report-7'}))).toEqual({kind:'scroll',target:'source-perspective'});
 });

 it('keeps command and timeline selections on their record entry',()=>{
  expect(nextFocusStep({seq:2,id:'order-3',tick:null,side:'blue'},view({highlightId:'order-3'}))).toEqual({kind:'scroll',target:'evidence'});
 });

 it('does not scroll on passive refresh, polling or manual seeks once the request is consumed',()=>{
  expect(nextFocusStep(null,view({displayedTick:121,selectedReportId:'report-7'}))).toEqual({kind:'idle'});
  expect(nextFocusStep(null,view({displayedTick:40,seeking:true,selectedReportId:'report-7'}))).toEqual({kind:'idle'});
 });

 it('drops a request whose historical state never arrives instead of scrolling later',()=>{
  const req:FocusRequest={seq:3,id:'report-7',tick:80};
  // Seek failed or was overtaken: it settled on another tick, so a later poll reaching tick 80 must not scroll.
  expect(nextFocusStep(req,view({displayedTick:95}))).toEqual({kind:'drop'});
  // Superseded by another selection or deselected.
  expect(nextFocusStep(req,view({highlightId:null,displayedTick:80}))).toEqual({kind:'drop'});
 });

 it('asks for the evidence side once and drops if that perspective is not released',()=>{
  const req:FocusRequest={seq:4,id:'red-event',tick:null,side:'red'};
  expect(nextFocusStep(req,view({highlightId:'red-event'}))).toEqual({kind:'perspective'});
  expect(nextFocusStep({...req,perspectiveAsked:true},view({highlightId:'red-event'}))).toEqual({kind:'drop'});
  expect(nextFocusStep({...req,perspectiveAsked:true},view({highlightId:'red-event',perspective:'red'}))).toEqual({kind:'scroll',target:'evidence'});
 });
});
