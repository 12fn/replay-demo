import {describe, expect, it} from 'vitest';
import type {Overview} from '../../src/client/api';
import {DEFAULT_REVIEW_NAVIGATION, reviewNavigationReducer as reduce, reviewNavigationScope as scope} from '../../src/client/review-navigation';

const overview = () => ({identity:{mode:'kamiwaza',subject:'participant-a',role:'instructor'},activeId:'exercise-a',
  platform:{native:{workroomId:'room-a',context:{nativeRole:'owner'}}}} as unknown as Overview);

describe('review panel choices across an authorization gate', () => {
  it('preserves only enum choices through refusal and recovery for the same verified scope', () => {
    const key=scope(overview())!;
    let state=reduce(null,{type:'mode',scope:key,value:'learning'});
    state=reduce(state,{type:'tab',scope:key,value:'reports'});
    const before=state;
    state=reduce(state,{type:'scope',scope:null}); // No accepted overview while 401 is active.
    expect(state).toBe(before);
    expect(reduce(state,{type:'scope',scope:key})).toEqual({scope:key,selection:{mode:'learning',tab:'reports'}});
    expect(Object.keys(state!)).toEqual(['scope','selection']);
    expect(Object.keys(state!.selection)).toEqual(['mode','tab']);
  });

  it.each(['subject','workroom','exercise','mapped-role','native-role','mode'])('resets after %s changes and does not resurrect the old scope on return', kind => {
    const a=overview(), b=structuredClone(a), old=scope(a)!;
    const native=(b.platform as any).native;
    if(kind==='subject')b.identity.subject='participant-b';
    if(kind==='workroom')native.workroomId='room-b';
    if(kind==='exercise')b.activeId='exercise-b';
    if(kind==='mapped-role')b.identity.role='commander';
    if(kind==='native-role')native.context.nativeRole='editor';
    if(kind==='mode')b.identity.mode='local-demo';
    let state=reduce(null,{type:'mode',scope:old,value:'learning'});
    state=reduce(state,{type:'scope',scope:null});
    state=reduce(state,{type:'scope',scope:scope(b)});
    expect(state?.selection).toEqual(DEFAULT_REVIEW_NAVIGATION);
    expect(reduce(state,{type:'scope',scope:old})?.selection).toEqual(DEFAULT_REVIEW_NAVIGATION);
  });

  it('clears selection after explicit sign-out even if the same user later signs in', () => {
    const key=scope(overview())!;
    let state=reduce(null,{type:'mode',scope:key,value:'learning'});
    state=reduce(state,{type:'reset'});
    expect(state).toBeNull();
    expect(reduce(state,{type:'scope',scope:key})?.selection).toEqual(DEFAULT_REVIEW_NAVIGATION);
  });

  it('does not create a native scope from missing native authority, and keeps tuple boundaries distinct', () => {
    expect(scope(undefined)).toBeNull();
    const a=overview();delete (a.platform as any).native;expect(scope(a)).toBeNull();
    const b=overview(),c=overview();b.identity.subject='a:b';b.activeId='c';c.identity.subject='a';c.activeId='b:c';
    expect(scope(b)).not.toBe(scope(c));
  });
});
