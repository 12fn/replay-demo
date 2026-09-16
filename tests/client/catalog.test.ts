import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogAor, CatalogRecord } from '../../src/catalog/types';
import {
  catalogApi, catalogRecordUrl, catalogSearchUrl, formatFieldValue, humanize, safeExternalUrl, sortCaseEvents, type CatalogRecordDetail,
} from '../../src/client/catalog-api';
import {
  CaseTimeline, RecordDetail, SourceChain, partitionCaseRecords, personaCasesQuery, reportHandles, reportRelations,
} from '../../src/client/views/CatalogView';

function record(over: Partial<CatalogRecord> = {}): CatalogRecord {
  return {
    id: 'taiwan/case-alpha', aorId: 'taiwan', kind: 'case', title: 'Crossing ambiguity', summary: 'Authored ferry case', body: 'First paragraph.',
    roles: ['intelligence'], tags: ['ferry'], provenance: 'synthetic', sourceIds: ['src-strait'], links: [], fields: {}, ...over,
  };
}
const aor: CatalogAor = { id: 'caribbean', name: 'Caribbean', theater: 'SOUTHCOM', summary: 'Context', playableScenarioId: null, focus: [], sourceIds: [] };

afterEach(() => vi.unstubAllGlobals());

describe('catalog API URLs', () => {
  it('encodes query values and ids, omits empty filters and bounds paging', () => {
    const url = catalogSearchUrl({ query: ' a&b=c ', aorId: 'taiwan', role: undefined, kind: undefined, cutoffTick: 12.7, offset: -5, limit: 500 });
    const params = new URL(url, 'https://replay.test').searchParams;
    expect(url.startsWith('/api/catalog/search?')).toBe(true);
    expect(params.get('query')).toBe('a&b=c');
    expect(params.get('aorId')).toBe('taiwan');
    expect(params.has('role')).toBe(false);
    expect(params.has('kind')).toBe(false);
    expect(params.get('cutoffTick')).toBe('12');
    expect(params.get('offset')).toBe('0');
    expect(params.get('limit')).toBe('100');
    expect(catalogRecordUrl('taiwan/case alpha?x')).toBe('/api/catalog/records/taiwan%2Fcase%20alpha%3Fx');
  });

  it('sends same-origin credentials and surfaces server errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'fresh read required' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(catalogApi.record('a/b')).rejects.toMatchObject({ status: 401, message: 'fresh read required' });
    expect(fetchMock).toHaveBeenCalledWith('/api/catalog/records/a%2Fb', expect.objectContaining({ credentials: 'same-origin' }));
  });
});

describe('catalog display helpers', () => {
  it('only allows https anchors', () => {
    expect(safeExternalUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(safeExternalUrl('http://example.org/a')).toBeNull();
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('/relative')).toBeNull();
  });

  it('formats primitive fields readably and drops structured values', () => {
    expect(humanize('practiceFocus')).toBe('Practice focus');
    expect(humanize('review_end-tick')).toBe('Review end tick');
    expect(formatFieldValue(true)).toEqual({ kind: 'text', text: 'Yes' });
    expect(formatFieldValue(['a', 3, 'b'])).toEqual({ kind: 'list', items: ['a', 'b'] });
    expect(formatFieldValue({ nested: 1 })).toBeNull();
    expect(formatFieldValue(null)).toBeNull();
  });

  it('orders authored case events by observed then released tick', () => {
    const ordered = sortCaseEvents([
      record({ id: 'c', observedTick: 20 }), record({ id: 'b', observedTick: 10, availableAtTick: 15 }),
      record({ id: 'a', observedTick: 10, availableAtTick: 12 }), record({ id: 'z' }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(['a', 'b', 'c', 'z']);
  });
});

describe('catalog record detail', () => {
  const detail: CatalogRecordDetail = {
    record: record({
      aorId: 'caribbean', observedTick: 40, availableAtTick: 44,
      fields: { practiceFocus: ['Source reliability', 'src-strait'], reviewEndTick: 90, strengths: 'Pattern of life', raw: { x: 1 } as never },
    }),
    links: [{ relation: 'supersedes', record: record({ id: 'taiwan/report-old', kind: 'report', title: 'Earlier ferry report' }) }],
    backlinks: [{ relation: 'cites', record: record({ id: 'taiwan/lesson-1', kind: 'lesson', title: 'Reading ferry traffic', provenance: 'public-reference' }) }],
    sources: [
      { id: 'src-strait', title: 'Strait survey', url: 'https://example.org/survey', publisher: 'Example', retrievedAt: '2026-09-01', summary: 'Original API summary text.', usage: 'link-and-original-summary', scope: 'Geography' },
      { id: 'src-bad', title: 'Insecure source', url: 'http://example.org/x', publisher: 'Example', retrievedAt: '2026-09-01', summary: '', usage: 'link-and-original-summary', scope: '' },
    ],
    notice: 'Synthetic teaching material.',
  };
  const html = renderToStaticMarkup(createElement(RecordDetail, { detail, aor, aorName: (id: string) => id, onOpen: () => undefined }));

  it('renders labelled fields, ticks, capability and provenance without dumping JSON', () => {
    expect(html).toContain('Practice focus');
    expect(html).toContain('Source reliability');
    expect(html).toContain('Review ends');
    expect(html).toContain('T+90');
    expect(html).toContain('Released');
    expect(html).toContain('Context only');
    expect(html).toContain('Synthetic');
    expect(html).not.toContain('{&quot;x&quot;');
    expect(html).not.toContain('[object Object]');
  });

  it('renders relationships as openable records and only https sources as noreferrer anchors', () => {
    expect(html).toContain('Supersedes');
    expect(html).toContain('Earlier ferry report');
    expect(html).toContain('Cited by');
    expect(html).toContain('Original API summary text.');
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.org\/survey"[^>]*rel="noopener noreferrer"/);
    expect(html).not.toContain('href="http://example.org/x"');
    expect(html).toContain('Insecure source');
  });

  it('marks the case timeline as authored and ordered', () => {
    const timeline = renderToStaticMarkup(createElement(CaseTimeline, {
      state: { loading: false, error: null, page: { schema: 'replay.catalog-page/1', version: '1', query: {}, total: 3, offset: 0, limit: 100, hasMore: true,
        items: [record({ id: 'e2', kind: 'event', title: 'Second', observedTick: 9 }), record({ id: 'e1', kind: 'event', title: 'First', observedTick: 3, availableAtTick: 5 })], notice: '' } },
      onOpen: () => undefined,
    }));
    expect(timeline.indexOf('First')).toBeLessThan(timeline.indexOf('Second'));
    expect(timeline).toContain('released T+5');
    expect(timeline).toContain('first 2 of 3');
  });

  it('marks a public reference differently from authored material', () => {
    const pub = renderToStaticMarkup(createElement(RecordDetail, {
      detail: { ...detail, record: record({ kind: 'historical', provenance: 'public-reference', title: 'Public history' }) }, aor, aorName: (id: string) => id, onOpen: () => undefined,
    }));
    expect(pub).toContain('Public reference');
    expect(pub).toContain('Real public reference');
    expect(html).not.toContain('Real public reference');
  });
});

const page = (items: CatalogRecord[]) => ({
  loading: false, error: null,
  page: { schema: 'replay.catalog-page/1' as const, version: '1', query: {}, total: items.length, offset: 0, limit: 100, hasMore: false, items, notice: '' },
});

describe('persona to case flow', () => {
  const personaId = 'taiwan/persona/demo-a';
  const caseId = 'taiwan/case/demo-a-1';

  it('asks for the persona\'s cases only, so all three render', () => {
    const params = new URL(catalogSearchUrl(personaCasesQuery(personaId, 40)), 'https://replay.test').searchParams;
    expect(params.get('personaId')).toBe(personaId);
    expect(params.get('kind')).toBe('case');
    expect(params.get('cutoffTick')).toBe('40');
  });

  it('leads a persona with strengths, limitations and focus, hides the self-link and tucks IDs into metadata', () => {
    const persona = record({
      id: personaId, kind: 'persona', title: 'Demo A', personaId, body: 'Long repeated persona body.',
      fields: { strengths: ['Audits lineage'], limitations: ['Double counts first'], focusLessonId: 'taiwan/lesson/source-lineage', authenticatedUser: false, caseIds: [caseId] },
    });
    const lesson = record({ id: 'taiwan/lesson/source-lineage', kind: 'lesson', title: 'Source lineage', summary: 'Group reports by lineage.' });
    const out = renderToStaticMarkup(createElement(RecordDetail, {
      detail: { record: persona, links: [{ relation: 'uses', record: lesson }], backlinks: [], sources: [], notice: 'n' },
      aor, aorName: (id: string) => id, onOpen: () => undefined, globalNotice: 'n',
    }));
    expect(out).not.toContain('Open author persona');
    expect(out).toContain('Audits lineage');
    expect(out).toContain('Double counts first');
    expect(out).toContain('Source lineage');
    expect(out).toContain('not a sign-in identity');
    const [lead, meta] = out.split('<details class="catalog-meta">');
    expect(lead).not.toContain(personaId);
    expect(lead).not.toContain('Long repeated persona body.');
    expect(meta).toContain(personaId);
    expect(meta).toContain('Authenticated user');
  });

  it('orders case events with decision and review stages and resolves the report chain', () => {
    const report = (n: number, fields: CatalogRecord['fields']) =>
      record({ id: `${caseId}/report-${n}`, kind: 'report', title: `Report ${n}`, caseId, observedTick: n, availableAtTick: n + 1, fields: { sequence: n, ...fields } });
    const items = [
      record({ id: caseId, kind: 'case', caseId }),
      record({ id: `${caseId}/event-2`, kind: 'event', caseId, observedTick: 30, fields: { label: 'Post-hoc review: reasoning', phase: 'post-hoc', rating: 'unsupported', reviewFocus: 'reasoning' } }),
      record({ id: `${caseId}/event-1`, kind: 'event', caseId, observedTick: 20, fields: { label: 'Decision deadline', phase: 'in-exercise', eventType: 'decision', isDecisionDeadline: true, citedReportIds: [`${caseId}/report-1`, `${caseId}/report-2`] } }),
      report(2, { lineage: 'derivative', independent: false, derivedFromReportId: `${caseId}/report-1` }),
      report(1, { lineage: 'primary', independent: true, supersededByReportId: `${caseId}/report-9` }),
    ];
    const { events, reports } = partitionCaseRecords(items, caseId);
    expect(events.map((e) => e.fields.label)).toEqual(['Decision deadline', 'Post-hoc review: reasoning']);
    expect(reports.map((r) => r.id)).toEqual([`${caseId}/report-1`, `${caseId}/report-2`]);
    const handles = reportHandles(reports);
    expect(reportRelations(reports[1], handles)).toEqual([{ label: 'Derived from', targetId: `${caseId}/report-1`, handle: 'R1' }]);
    expect(reportRelations(reports[0], handles)).toEqual([]);

    const timeline = renderToStaticMarkup(createElement(CaseTimeline, { state: page(items), caseId, onOpen: () => undefined }));
    expect(timeline.indexOf('Decision')).toBeLessThan(timeline.indexOf('Review'));
    expect(timeline).toContain('R1');
    expect(timeline).toContain('Unsupported');
    expect(timeline).not.toMatch(/play|scrub|replay/i);
    const chain = renderToStaticMarkup(createElement(SourceChain, { state: page(items), caseId, onOpen: () => undefined }));
    expect(chain).toContain('Derived from');
    expect(chain).toContain('Not independent');
  });
});
