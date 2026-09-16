import {useCallback, useEffect, useReducer} from 'react';
import type {Overview} from './api';
import {nativeOf} from './native-api';

export type ReviewMode = 'record' | 'learning';
export type RecordTab = 'decisions' | 'timeline' | 'reports';
export interface ReviewNavigation {mode: ReviewMode; tab: RecordTab}
export const DEFAULT_REVIEW_NAVIGATION: Readonly<ReviewNavigation> = {mode: 'record', tab: 'decisions'};
export type ReviewNavigationState = {scope: string; selection: ReviewNavigation} | null;
export type ReviewNavigationAction =
  | {type: 'scope'; scope: string | null}
  | {type: 'mode'; scope: string; value: ReviewMode}
  | {type: 'tab'; scope: string; value: RecordTab}
  | {type: 'reset'};

/** Use only an accepted overview. No tokens, response bodies or evidence enter this state. */
export function reviewNavigationScope(ov: Overview | undefined): string | null {
  if (!ov?.identity.subject) return null;
  const native = nativeOf(ov);
  if (ov.identity.mode === 'kamiwaza' && !native) return null;
  return JSON.stringify([ov.identity.mode, ov.identity.subject, native?.workroomId ?? null,
    ov.identity.role, native?.context.nativeRole ?? null, ov.activeId]);
}

export function reviewNavigationReducer(state: ReviewNavigationState, action: ReviewNavigationAction): ReviewNavigationState {
  if (action.type === 'reset') return null;
  // A refusal unmounts protected content. Retain only the two harmless enum choices
  // until the backend accepts an overview; an unknown scope cannot change them.
  if (action.scope === null) return state;
  const current = state?.scope === action.scope ? state : {scope: action.scope, selection: {...DEFAULT_REVIEW_NAVIGATION}};
  if (action.type === 'scope') return current;
  return {scope: action.scope, selection: {...current.selection, [action.type]: action.value}};
}

export function useReviewNavigation(acceptedOverview: Overview | undefined) {
  const scope = reviewNavigationScope(acceptedOverview);
  const [state, dispatch] = useReducer(reviewNavigationReducer, null);
  useEffect(() => { dispatch({type: 'scope', scope}); }, [scope]);
  // Scope changes show defaults on the very first render, before the effect runs.
  const selection = scope !== null && state?.scope === scope ? state.selection : DEFAULT_REVIEW_NAVIGATION;
  const setMode = useCallback((value: ReviewMode) => { if (scope !== null) dispatch({type: 'mode', scope, value}); }, [scope]);
  const setTab = useCallback((value: RecordTab) => { if (scope !== null) dispatch({type: 'tab', scope, value}); }, [scope]);
  const reset = useCallback(() => { dispatch({type: 'reset'}); }, []);
  return {selection, setMode, setTab, reset};
}
