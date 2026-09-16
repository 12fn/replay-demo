import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PracticeHistoryItem, PracticeHistoryResult } from '../../src/learning/practice-history-types';
import type { ViewContext } from '../../src/client/App';
import { PracticeObservationsPanel } from '../../src/client/components/PracticeObservationsPanel';
import { api, ApiError } from '../../src/client/api';
import {
  createHistoryLoader, HistoryResults, historyContextKey, historyCursor, historyRequestKey, historyUrl,
  PracticeHistoryPanel, prepareHistoryEvidence, type HistoryFilters,
} from '../../src/client/components/PracticeHistoryPanel';

const mine: HistoryFilters = { query: '', scenarioId: '', scope: 'mine' };
function item(over: Partial<PracticeHistoryItem> = {}): PracticeHistoryItem {
  return {
    eventId: 'event-1', sequence: 80, tick: 120, observedTick: 117, recordedAt: '2026-09-14T12:00:00Z',
    kind: 'command', actor: 'participant-7', side: 'blue', summary: 'Committed reserve after source update',
    exercise: { id: 'exercise-1', name: 'Crosscurrent trial', kind: 'recorded', status: 'completed',
      createdAt: '2026-09-13T12:00:00Z', scenarioId: 'scenario/1', scenarioVersion: '1.2', map: 'world',
      simulationProfile: 'profile/1', curriculumVersion: '1', assistance: 'staff', parentId: null, forkTick: null },
    sourceIds: ['report-alpha', 'report-beta'], commitmentRatio: 0, rationaleRecorded: false, ...over,
  };
}
function page(over: Partial<PracticeHistoryResult> = {}): PracticeHistoryResult {
  return {
    schema: 'replay.practice-history/1', scope: 'mine', fiction: true, query: '', items: [item()],
    nextBeforeSequence: 80, hasMore: true, scenarios: [{ id: 'scenario/1', name: 'Island crossing' }],
    summary: { basis: 'returned-page-only', commands: 1, assessments: 0, watches: 0,
      commandsCitingSources: 1, commandsWithRecordedReason: 0, branchEvents: 0 },
    limits: { maxPageSize: 20, eligibleExercises: 75, exerciseCatalogTruncated: true }, notice: 'Retained fictional records.', ...over,
  };
}
function ctx(role: ViewContext['ov']['identity']['role'] = 'commander'): ViewContext {
  return { ov: { identity: { subject: 'person', name: 'Learner', role, organization: 'Training', mode: 'local-demo' },
    activeId: 'current-exercise', playbackTick: null, navigationRevision: 3, platform: {} },
  refresh: vi.fn(async () => {}), openEvidence: vi.fn(), setPerspective: vi.fn() } as unknown as ViewContext;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body: PracticeHistoryResult) => new Response(JSON.stringify(body), { status: 200 });
const render = (result: PracticeHistoryResult, items = result.items) => renderToStaticMarkup(createElement(HistoryResults, { page: result, items, onOpen: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('practice history output', () => {
  it('summarizes only the current page and preserves exact event and viewed-tick evidence links', () => {
    const p = page();
    const html = renderToStaticMarkup(createElement(PracticeObservationsPanel, { page: p, onOpen: vi.fn(), opening: true }));
    expect(html).toContain('These 1 records');
    expect(html).toContain('median 0% across 1 orders');
    expect(html).toContain('Review evidence event-1 in Crosscurrent trial');
    expect(html).toContain('Viewed tick: 117');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Only the latest returned page');
    expect(html).not.toContain('Participant:');
    const older = item({ eventId: 'older', sequence: 79, commitmentRatio: .9 });
    const combined = render(p, [older, ...p.items]);
    expect(combined).toContain('median 0% across 1 orders');
    expect(combined).toContain('2 unique records loaded');
  });
  it('shows source/time provenance and zero commitment without inferring a reason or history-wide counts', () => {
    const html = render(page(), [item(), item({ eventId: 'event-2', sequence: 79 })]);
    for (const text of ['2 unique records loaded', 'Latest returned page: 1 records', 'page counts, not full-history totals',
      '75 eligible completed exercises', 'catalog is truncated', 'Crosscurrent trial', 'Island crossing',
      'Original', 'Type: command', 'Observed: tick 117', 'Recorded: tick 120', '2026-09-14T12:00:00Z',
      'Recorded commitment: 0%', 'report-alpha, report-beta', 'No written reason recorded', 'Exercise ID: exercise-1', 'Event ID: event-1']) expect(html).toContain(text);
    expect(html).not.toContain('Actor:');
    expect(html).not.toMatch(/weakness|ranking|personality/i);
  });

  it('labels workroom attribution, branch exposure and missing provenance honestly; escapes recorded text', () => {
    const branch = item({ summary: '<script>private()</script>', observedTick: null, commitmentRatio: null,
      rationaleRecorded: true, sourceIds: [], exercise: { ...item().exercise, kind: 'branch', parentId: 'original-9', forkTick: 60 } });
    const html = render(page({ scope: 'workroom', items: [branch] }));
    for (const text of ['Actor: participant-7', 'Branch · informed practice', 'Original exercise ID: original-9',
      'Fork tick: 60', 'Observed: not recorded', 'Written reason recorded', '&lt;script&gt;private()&lt;/script&gt;']) expect(html).toContain(text);
    expect(html).not.toMatch(/<script>|Recorded commitment:|Source IDs:/);
    expect(render(page({ items: [], hasMore: false, nextBeforeSequence: null }))).toContain('No matching completed practice records');
  });

  it('defaults to own records, offers workroom scope only to instructors, and supplies current role/Tomo context', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const own = renderToStaticMarkup(createElement(PracticeHistoryPanel, { ctx: ctx() }));
    const instructor = renderToStaticMarkup(createElement(PracticeHistoryPanel, { ctx: ctx('instructor') }));
    expect(own).toContain('Completed records');
    expect(own).toContain('Current role: commander');
    expect(own).toContain('For Tomo review');
    expect(own).toContain('My records');
    expect(own).not.toContain('Workroom records');
    expect(instructor).toContain('value="mine" selected=""');
    expect(instructor).toContain('Workroom records');
    expect(own).toContain('type="submit"');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('bounded requests and pagination races', () => {
  it('uses only supported query parameters and browser session credentials; keys include all search and authority boundaries', async () => {
    const filters = { query: '  source & reserve  ', scenarioId: 'island/2', scope: 'workroom' } as const;
    const url = new URL(historyUrl(filters, 42), 'https://test.invalid');
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'source & reserve', scenarioId: 'island/2', scope: 'workroom', limit: '20', beforeSequence: '42' });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(page()));
    const loader = createHistoryLoader(request);
    await loader.search(mine);
    expect(request).toHaveBeenCalledWith('/api/practice/history?scope=mine&query=&limit=20', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
    }));
    expect(new Set([mine, { ...mine, query: 'x' }, { ...mine, scenarioId: 'x' }, { ...mine, scope: 'workroom' as const }].map(historyRequestKey)).size).toBe(4);
    const ov = ctx().ov;
    const nativeOv = { ...ov, platform: { ...ov.platform, native: { workroomId: 'room-2', context: {} } } };
    expect(new Set([ov, { ...ov, identity: { ...ov.identity, subject: 'other' } }, ctx('instructor').ov,
      { ...ov, identity: { ...ov.identity, mode: 'kamiwaza' as const } }, nativeOv].map(historyContextKey)).size).toBe(5);
  });

  it('aborts previous searches and ignores late successes and failures even when a search key is reused', async () => {
    const a = deferred<Response>(), b = deferred<Response>(), c = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);
    const loader = createHistoryLoader(request);
    const first = loader.search(mine);
    const second = loader.search({ ...mine, query: 'changed' });
    const third = loader.search(mine);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    c.resolve(response(page({ items: [item({ eventId: 'newest' })] })));
    await third;
    a.resolve(response(page())); b.reject(new Error('late raw stack'));
    await Promise.all([first, second]);
    expect(loader.getSnapshot().items.map(i => i.eventId)).toEqual(['newest']);
    expect(loader.getSnapshot().error).toBeNull();
    expect(loader.getSnapshot().loading).toBe(false);
  });

  it('loads one cursor at a time, deduplicates exercise/event pairs and retains latest-page counts', async () => {
    const next = deferred<Response>();
    const inherited = item({ exercise: { ...item().exercise, id: 'branch-2', kind: 'branch' }, sequence: 78 });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(page())).mockReturnValueOnce(next.promise);
    const loader = createHistoryLoader(request);
    await loader.search(mine);
    const more = loader.more(); await loader.more();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('beforeSequence=80');
    const last = page({ items: [item(), inherited, inherited], hasMore: false, nextBeforeSequence: null });
    next.resolve(response(last)); await more;
    expect(loader.getSnapshot().items.map(i => i.exercise.id)).toEqual(['exercise-1', 'branch-2']);
    expect(loader.getSnapshot().page?.summary.commands).toBe(1);
    expect(loader.getSnapshot().cursor).toBeNull();
    await loader.more(); expect(request).toHaveBeenCalledTimes(2);
  });

  it('clears rows/cursor immediately on scenario or scope changes and rejects an old Load more page', async () => {
    const old = deferred<Response>(), fresh = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(page())).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const loader = createHistoryLoader(request);
    await loader.search(mine);
    const more = loader.more();
    const changed = loader.search({ ...mine, scope: 'workroom', scenarioId: 'new' });
    expect(loader.getSnapshot()).toMatchObject({ items: [], cursor: null, page: null, loading: true });
    old.resolve(response(page())); await more;
    expect(loader.getSnapshot().items).toEqual([]);
    fresh.resolve(response(page({ scope: 'workroom', items: [] }))); await changed;
    expect(loader.getSnapshot().page?.scope).toBe('workroom');
  });

  it('allows retry of a failed page but clears retained data on authorization refusal and hides raw diagnostics', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(page()))
      .mockRejectedValueOnce(new Error('sensitive raw stack')).mockResolvedValueOnce(new Response('sensitive raw stack', { status: 403 }));
    const loader = createHistoryLoader(request);
    await loader.search(mine); await loader.more();
    expect(loader.getSnapshot()).toMatchObject({ items: [item()], cursor: 80, error: 'Practice history is unavailable. Please try again.' });
    await loader.more();
    expect(loader.getSnapshot()).toMatchObject({ items: [], page: null, cursor: null, scenarios: [] });
    expect(loader.getSnapshot().error).toContain('not authorized');
    expect(loader.getSnapshot().error).not.toContain('stack');
  });

  it('stops stale work on unmount and refuses non-advancing cursors', async () => {
    const pending = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const loader = createHistoryLoader(request);
    const search = loader.search(mine); loader.cancel();
    pending.resolve(response(page())); await search;
    expect(loader.getSnapshot().items).toEqual([]);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(historyCursor(page(), 80)).toBeNull();
    expect(historyCursor(page({ nextBeforeSequence: 81 }), 80)).toBeNull();
    expect(historyCursor(page({ nextBeforeSequence: 79 }), 80)).toBe(79);
    expect(historyCursor(page({ nextBeforeSequence: null }))).toBeNull();
  });
});

describe('exact historical evidence navigation', () => {
  it('waits for conditional selection before seeking the recorded event tick in that exercise, then refreshes', async () => {
    const selected = deferred<{ selected: string }>();
    const select = vi.spyOn(api, 'select').mockReturnValue(selected.promise);
    const replay = vi.spyOn(api, 'replay').mockResolvedValue({});
    const context = ctx();
    const navigation = prepareHistoryEvidence(item(), context);
    expect(select).toHaveBeenCalledWith('exercise-1', { activeId: 'current-exercise', playbackTick: null, revision: 3 });
    expect(replay).not.toHaveBeenCalled();
    selected.resolve({ selected: 'exercise-1' }); await navigation;
    expect(replay).toHaveBeenCalledWith(120, 'exercise-1');
    expect(context.refresh).toHaveBeenCalledOnce();
    expect(context.openEvidence).not.toHaveBeenCalled(); // UI waits for committed overview before focusing.
  });

  it('never seeks after failed selection or when the originating session has changed', async () => {
    const select = vi.spyOn(api, 'select').mockRejectedValueOnce(new ApiError(403, 'private refusal')).mockResolvedValue({ selected: 'exercise-1' });
    const replay = vi.spyOn(api, 'replay').mockResolvedValue({});
    const context = ctx();
    await expect(prepareHistoryEvidence(item(), context)).rejects.toThrow(ApiError);
    await prepareHistoryEvidence(item(), context, () => false);
    expect(select).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
    expect(context.refresh).not.toHaveBeenCalled();
  });
});
