import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PracticeHistoryDetailItem, PracticeHistoryDetailsResult, PracticeHistoryItem } from '../../src/learning/practice-history-types';
import type { ViewContext } from '../../src/client/App';
import { api } from '../../src/client/api';
import {
  createDetailsLoader, DetailsResults, detailsCursor, detailsUrl, detailToHistoryItem, modeNeedsSearch, referencedOrderItem,
} from '../../src/client/components/PracticeDetailsPanel';
import { PracticeHistoryPanel, prepareHistoryEvidence, type HistoryFilters } from '../../src/client/components/PracticeHistoryPanel';

const mine: HistoryFilters = { query: '', scenarioId: '', scope: 'mine' };
const exercise: PracticeHistoryDetailItem['exercise'] = {
  id: 'exercise-1', name: 'Crosscurrent trial', kind: 'recorded', status: 'completed', createdAt: '2026-09-13T12:00:00Z',
  scenarioId: 'scenario/1', scenarioVersion: '1.2', map: 'world', simulationProfile: 'profile/1', curriculumVersion: '1',
  assistance: 'staff-assisted', parentId: null, forkTick: null,
};
function detail(over: Partial<PracticeHistoryDetailItem> = {}): PracticeHistoryDetailItem {
  return {
    eventId: 'event-1', sequence: 80, kind: 'command', actor: 'participant-7', side: 'blue', summary: 'Committed reserve',
    recordedAt: '2026-09-14T12:00:00Z', ticks: { recorded: 120, observed: 117, observationBasis: 'client-snapshot' }, exercise,
    commitmentRatio: 0.4, reason: 'written-statement',
    statement: { text: 'Bridge report showed the crossing open.', truncated: false, timing: 'contemporaneous', authoredTick: 118, authoredAt: null },
    reference: { commandId: 'cmd-9', commandEventId: null, orderTick: null },
    sources: { cited: 2, statusTick: 117, statusTickBasis: 'observed-tick', completedCutoffTick: 400, truncated: null, omittedIds: 0, items: [
      { id: 'report-bridge', atViewedTick: { status: 'current' }, atCompletedCutoff: { status: 'superseded', supersededBy: 'report-bridge-2' } },
      { id: 'report-ferry', derivedFrom: 'report-root', atViewedTick: { status: 'disputed', disputedWith: ['report-a', 'report-b'], disputesOmitted: 3 }, atCompletedCutoff: { status: 'unavailable' } },
    ] },
    ...over,
  };
}
function page(over: Partial<PracticeHistoryDetailsResult> = {}): PracticeHistoryDetailsResult {
  const items = over.items ?? [detail()];
  return {
    schema: 'replay.practice-history/2', scope: 'mine', fiction: true, query: '', items, nextBeforeSequence: 80, hasMore: true,
    page: { returned: items.length, requestedLimit: 5, truncatedBy: 'page-limit', scannedEvents: 6 }, scenarioIds: ['scenario/1'],
    summary: { basis: 'returned-page-only', commands: 1, decisionStatements: 0, assessments: 0, watches: 0, writtenStatements: 1, citationOnly: 0, branchEvents: 0 },
    limits: { maxPageSize: 10, defaultPageSize: 5, maxResponseChars: 6000, statementChars: 500, sourcesPerItem: 5, maxScannedEvents: 500,
      eligibleExercises: 12, exerciseCatalogTruncated: false, scenarioCatalogTruncated: false },
    notice: 'Completed fictional exercise records only.', ...over,
  };
}
const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const render = (result: PracticeHistoryDetailsResult, onOpen = vi.fn()) =>
  renderToStaticMarkup(createElement(DetailsResults, { page: result, items: result.items, onOpen }));

/** No DOM here: expand the (hook-free) result components and press buttons by their accessible labels. */
function buttons(node: ReactNode): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<any>;
  if (typeof el.type === 'function') return buttons((el.type as (p: unknown) => ReactNode)(el.props));
  return [...(el.type === 'button' ? [el] : []), ...buttons(el.props.children)];
}
const press = (result: PracticeHistoryDetailsResult, label: string, onOpen: (item: PracticeHistoryItem) => void) => {
  const button = buttons(createElement(DetailsResults, { page: result, items: result.items, onOpen })).find(b => b.props['aria-label'] === label);
  expect(button, label).toBeDefined();
  button!.props.onClick();
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('reasons and sources output', () => {
  it('shows written reasons with their recorded timing and each source then versus at completion', () => {
    const html = render(page());
    for (const text of ['Written reason', 'Written at the time of the action · authored at tick 118', 'Bridge report showed the crossing open.',
      'Order ID: cmd-9', 'Viewed: tick 117 (client-snapshot)', 'Recorded: tick 120', 'Recorded commitment: 40%',
      'Cited sources: 2', 'Status then: tick 117 (viewed tick)', 'Status at completion: tick 400',
      'Then: Current · At completion: Superseded by report-bridge-2', 'Changed by completion',
      'derived from <span class="mono">report-root</span>',
      'Then: Disputed by report-a, report-b and 3 more · At completion: Not among reports released to this side',
      '1 with written statements', 'page counts, not full-history totals']) expect(html).toContain(text);
    expect(html).not.toContain('Actor:');
    expect(html).not.toMatch(/mastery|personality|ranking|weakness score|skill level/i);
  });

  it('labels post-hoc and unknown timing as given, keeps citation-only apart from reasons, and never fabricates ticks', () => {
    const note = detail({ eventId: 'note-1', kind: 'decision_log', reason: 'written-statement',
      statement: { text: 'In hindsight the ferry was the better report.', truncated: true, timing: 'post-hoc', authoredTick: 150, authoredAt: '2026-09-14T12:05:00Z' },
      reference: { commandId: 'cmd-9', commandEventId: 'event-1', orderTick: 120 },
      sources: { ...detail().sources, statusTickBasis: 'order-observed-tick' } });
    const unknown = detail({ eventId: 'cmd-2', statement: { text: 'Reserve held back.', truncated: false, timing: 'unknown', authoredTick: null, authoredAt: null } });
    const citationOnly = detail({ eventId: 'cmd-3', reason: 'citation-only', statement: null, ticks: { recorded: 90, observed: null, observationBasis: null },
      sources: { cited: 1, statusTick: null, statusTickBasis: 'not-recorded', completedCutoffTick: null, truncated: null, omittedIds: 0,
        items: [{ id: 'report-x', atViewedTick: { status: 'not-evaluated' }, atCompletedCutoff: { status: 'current' } }] } });
    const bare = detail({ eventId: 'cmd-4', reason: 'not-recorded', statement: null, commitmentRatio: null,
      reference: { commandId: null, commandEventId: null, orderTick: null }, sources: { ...citationOnly.sources, cited: 0, items: [] } });
    const orphan = detail({ eventId: 'note-2', kind: 'decision_log', statement: { ...note.statement!, truncated: false },
      reference: { commandId: null, commandEventId: null, orderTick: null } });
    const html = render(page({ items: [note, unknown, citationOnly, bare, orphan] }));
    for (const text of ['Written afterwards (post-hoc) · authored at tick 150', '2026-09-14T12:05:00Z', 'In hindsight the ferry was the better report.…',
      'Statement clipped for display', 'Note on order event <span class="mono">event-1</span> at tick 120',
      'tick 117 (when the referenced order was viewed)', 'When this was written is not recorded · authored tick not recorded',
      'A citation shows what was referenced, not why', 'Viewed: not recorded', 'Status then: no viewed tick recorded',
      'cutoff tick not recorded', 'Then: Not evaluated (required tick not recorded) · At completion: Current',
      'No written reason or source citation recorded.', 'not readable in this record scope']) expect(html).toContain(text);
    // Citation-only and bare records render no quoted reason; not-evaluated → current is not a recorded change.
    const cit = html.slice(html.indexOf('Event ID: cmd-2'), html.indexOf('Event ID: cmd-4'));
    expect(cit).not.toContain('<blockquote');
    expect(cit).not.toContain('Changed by completion');
    expect(html).not.toContain('Written at the time of the action');
  });

  it('escapes source IDs and statements as plain text and states workroom attribution', () => {
    const hostile = detail({ statement: { text: '<script>x()</script>', truncated: false, timing: 'unknown', authoredTick: null, authoredAt: null },
      sources: { ...detail().sources, items: [{ id: '<img src=x onerror=alert(1)>', atViewedTick: { status: 'current' }, atCompletedCutoff: { status: 'current' } }] } });
    const html = render(page({ scope: 'workroom', items: [hostile] }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt;');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('Actor: participant-7');
  });

  it('explains every page and per-record truncation instead of implying the end of history', () => {
    expect(render(page({ page: { returned: 1, requestedLimit: 5, truncatedBy: 'character-budget', scannedEvents: 5 } })))
      .toContain('ended early to stay within the 6,000-character response limit');
    expect(render(page())).toContain('More matching records follow this page of 5');
    const scanned = render(page({ items: [], page: { returned: 0, requestedLimit: 5, truncatedBy: 'scan-limit', scannedEvents: 500 } }));
    expect(scanned).toContain('Search stopped after checking 500 retained events');
    expect(scanned).toContain('No matches in the records checked so far');
    expect(scanned).not.toContain('No matching completed practice records');
    expect(render(page({ items: [], hasMore: false, nextBeforeSequence: null, page: { returned: 0, requestedLimit: 5, truncatedBy: null, scannedEvents: 0 } })))
      .toContain('No matching completed practice records');
    const limited = render(page({ items: [
      detail({ sources: { ...detail().sources, cited: 7, truncated: 'source-limit', omittedIds: 1 } }),
      detail({ eventId: 'compact', sources: { ...detail().sources, items: [], truncated: 'character-budget' } }),
    ] }));
    for (const text of ['Showing the first 2 of the cited sources', '1 cited source ID is not shown',
      'Source details were withheld for this record to fit the response limit']) expect(limited).toContain(text);
  });

  it('defaults My practice to Activity with an opt-in Reasons & sources view and fetches nothing during render', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const html = renderToStaticMarkup(createElement(PracticeHistoryPanel, { ctx: { ov: { identity: { subject: 'p', name: 'L', role: 'commander', organization: 'T', mode: 'local-demo' },
      activeId: null, playbackTick: null, platform: {} }, refresh: vi.fn(), openEvidence: vi.fn(), setPerspective: vi.fn() } as unknown as ViewContext }));
    expect(html).toContain('aria-pressed="true">Activity</button>');
    expect(html).toContain('aria-pressed="false">Reasons &amp; sources</button>');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('exact event navigation', () => {
  it('opens the recorded event at its recorded tick, not the statement authored tick', async () => {
    const opened: PracticeHistoryItem[] = [];
    const note = detail({ eventId: 'note-1', kind: 'decision_log', ticks: { recorded: 150, observed: null, observationBasis: null },
      statement: { text: 'Later note', truncated: false, timing: 'post-hoc', authoredTick: 150, authoredAt: null },
      reference: { commandId: 'cmd-9', commandEventId: 'event-1', orderTick: 120 } });
    const unknown = detail({ eventId: 'cmd-2', ticks: { recorded: 131, observed: 129, observationBasis: null },
      statement: { text: 'x', truncated: false, timing: 'contemporaneous', authoredTick: 999, authoredAt: null } });
    const result = page({ items: [note, unknown] });
    press(result, 'Open Crosscurrent trial event cmd-2 in Review', item => opened.push(item));
    press(result, 'Open Crosscurrent trial event note-1 in Review', item => opened.push(item));
    press(result, 'Open referenced order event-1 in Crosscurrent trial', item => opened.push(item));
    expect(opened.map(i => [i.exercise.id, i.eventId, i.tick, i.side])).toEqual([
      ['exercise-1', 'cmd-2', 131, 'blue'], ['exercise-1', 'note-1', 150, 'blue'], ['exercise-1', 'event-1', 120, 'blue']]);
    expect(referencedOrderItem(detail())).toBeNull();
    expect(referencedOrderItem(detail({ kind: 'decision_log', reference: { commandId: null, commandEventId: 'e', orderTick: null } }))).toBeNull();

    const select = vi.spyOn(api, 'select').mockResolvedValue({ selected: 'exercise-2' });
    const replay = vi.spyOn(api, 'replay').mockResolvedValue({});
    const ctx = { ov: { activeId: 'live-exercise', playbackTick: null, navigationRevision: 4 }, refresh: vi.fn(async () => {}) } as unknown as ViewContext;
    await prepareHistoryEvidence(detailToHistoryItem(detail({ exercise: { ...exercise, id: 'exercise-2' }, ticks: { recorded: 77, observed: 70, observationBasis: null } })), ctx);
    expect(select).toHaveBeenCalledWith('exercise-2', { activeId: 'live-exercise', playbackTick: null, revision: 4 });
    expect(replay).toHaveBeenCalledWith(77, 'exercise-2');
  });
});

describe('details requests, pagination and stale replies', () => {
  it('requests only supported selectors with session credentials and a 5-record page', async () => {
    const url = new URL(detailsUrl({ query: '  bridge & ferry ', scenarioId: 'island/2', scope: 'workroom' }, 42), 'https://test.invalid');
    expect(url.pathname).toBe('/api/practice/history/details');
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'workroom', query: 'bridge & ferry', limit: '5', scenarioId: 'island/2', beforeSequence: '42' });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(page()));
    await createDetailsLoader(request).search(mine);
    expect(request).toHaveBeenCalledWith('/api/practice/history/details?scope=mine&query=&limit=5', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(String(request.mock.calls[0][0])).not.toContain('eventId');
  });

  it('pages with the cursor, deduplicates, continues after scan limits and refuses non-advancing cursors', async () => {
    const second = page({ items: [detail(), detail({ eventId: 'older', sequence: 60 })], nextBeforeSequence: 55,
      page: { returned: 2, requestedLimit: 5, truncatedBy: 'scan-limit', scannedEvents: 500 } });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response(second))
      .mockResolvedValueOnce(response(page({ items: [], hasMore: false, nextBeforeSequence: null })));
    const loader = createDetailsLoader(request);
    await loader.search(mine);
    const more = loader.more(); await loader.more(); await more;
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('beforeSequence=80');
    expect(loader.getSnapshot().items.map(i => i.eventId)).toEqual(['event-1', 'older']);
    expect(loader.getSnapshot().cursor).toBe(55);
    await loader.more();
    expect(request.mock.calls[2][0]).toContain('beforeSequence=55');
    expect(loader.getSnapshot()).toMatchObject({ cursor: null });
    expect(loader.getSnapshot().items).toHaveLength(2);
    expect(detailsCursor(page({ nextBeforeSequence: 80 }), 80)).toBeNull();
    expect(detailsCursor(page({ nextBeforeSequence: 0 }))).toBeNull();
  });

  it('rejects oversized or wrong-schema pages without showing them', async () => {
    const big = JSON.stringify(page({ notice: 'x'.repeat(6000) }));
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(big))
      .mockResolvedValueOnce(response({ ...page(), schema: 'replay.practice-history/1' }))
      .mockResolvedValueOnce(response(page({ scope: 'workroom' })));
    const loader = createDetailsLoader(request);
    for (let i = 0; i < 3; i++) {
      await loader.search(mine);
      expect(loader.getSnapshot()).toMatchObject({ page: null, items: [], error: 'Decision reasons and sources are unavailable. Please try again.' });
    }
  });

  it('ignores late replies after filter changes, A → B → A reuse, and unmount on a role/workroom/subject change', async () => {
    const a = deferred<Response>(), b = deferred<Response>(), c = deferred<Response>(), d = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise).mockReturnValueOnce(d.promise);
    const loader = createDetailsLoader(request);
    const first = loader.search(mine), second = loader.search({ ...mine, scenarioId: 'other' }), third = loader.search(mine);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    c.resolve(response(page({ items: [detail({ eventId: 'newest' })] }))); await third;
    a.resolve(response(page())); b.resolve(response('private', 403));
    await Promise.all([first, second]);
    expect(loader.getSnapshot()).toMatchObject({ error: null, loading: false });
    expect(loader.getSnapshot().items.map(i => i.eventId)).toEqual(['newest']);
    // History remounts per context key; unmount cancels, so the previous session's reply is never shown.
    const pending = loader.search({ ...mine, query: 'bridge' }); loader.cancel();
    d.resolve(response(page({ items: [detail({ eventId: 'previous-session' })] }))); await pending;
    expect(loader.getSnapshot()).toMatchObject({ items: [], page: null, loading: false });
  });

  it('clears retained rows on authorization refusal, hides raw bodies, and forces the other view to reload', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response('secret stack', 401));
    const loader = createDetailsLoader(request);
    await loader.search(mine); await loader.more();
    const refused = loader.getSnapshot();
    expect(refused).toMatchObject({ items: [], page: null, cursor: null });
    expect(refused.error).toContain('not authorized');
    expect(refused.error).not.toContain('secret');
    // The Activity page cached for the same filters must not be shown after that refusal.
    expect(modeNeedsSearch({ filters: mine, page: {}, loading: false }, mine, refused)).toBe(true);
  });

  it('fetches only the visible view: cached pages are reused, changed or cancelled ones reload', () => {
    const ok = { page: {}, error: null };
    expect(modeNeedsSearch({ filters: mine, page: {}, loading: false }, mine, ok)).toBe(false);
    expect(modeNeedsSearch({ filters: mine, page: null, loading: false }, mine, ok)).toBe(true);
    expect(modeNeedsSearch({ filters: mine, page: {}, loading: true }, mine, ok)).toBe(true);
    expect(modeNeedsSearch({ filters: mine, page: {}, loading: false }, { ...mine, query: 'bridge' }, ok)).toBe(true);
    expect(modeNeedsSearch({ filters: mine, page: {}, loading: false }, { ...mine, scope: 'workroom' }, ok)).toBe(true);
    expect(modeNeedsSearch({ filters: mine, page: {}, loading: false }, { ...mine, query: '  ' }, ok)).toBe(false);
  });
});
