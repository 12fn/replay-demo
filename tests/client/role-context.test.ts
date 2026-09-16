import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleContextPanel } from '../../src/client/components/RoleContextPanel';
import {
  resolveOrganizationPack,
  type OrganizationPackRole,
  type ResolvedOrganizationPack,
} from '../../src/context/organization-packs';

const context = (role: OrganizationPackRole = 'commander', packId = 'crosscurrent-joint-coordination') =>
  resolveOrganizationPack({ packId, version: '1.0.0', role });
const render = (pack: ResolvedOrganizationPack | null) => renderToStaticMarkup(createElement(RoleContextPanel, { pack }));

afterEach(() => vi.unstubAllGlobals());

describe('optional role context', () => {
  it('renders nothing when the caller supplies no retained pack', () => {
    expect(render(null)).toBe('');
  });

  it('starts collapsed with an accessible native disclosure and labels the context honestly', () => {
    const html = render(context());
    expect(html).toMatch(/^<details[^>]*><summary>Your role context<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:\s|=|>)/);
    expect(html).toMatch(/<h2>Current seat: Commander<\/h2>/);
    expect(html).toContain('Fictional · provisional');
    expect(html).toContain('Version 1.0.0');
    expect(html).toContain('Use these optional prompts during play or review. They describe your current seat; exercise objectives are provisional.');
    expect(html).toContain('panel panel-doc');
    expect(html).toContain('<summary>Exercise glossary</summary>');
    expect(html).toContain('Force reserves');
    expect(html).toContain('Source currency');
  });

  it.each([
    { role: 'commander' as const, seat: 'Commander', report: 'Coordination brief', field: 'Commitment and retained reserve',
      prompt: 'What would remain available after this commitment', absent: 'Currency and supersession' },
    { role: 'intelligence' as const, seat: 'Intelligence', report: 'Source assessment', field: 'Currency and supersession',
      prompt: 'Which claims can you trace to a report available at this tick', absent: 'Commitment and retained reserve' },
    { role: 'instructor' as const, seat: 'Instructor', report: 'Learning evidence review', field: 'Timing and assistance',
      prompt: 'Which reasons were recorded during the decision', absent: 'Commitment and retained reserve' },
  ])('renders the supplied $role report and prompts without another seat’s template', ({ role, seat, report, field, prompt, absent }) => {
    const pack = context(role);
    const html = render(pack);
    expect(html).toContain(`Current seat: ${seat}`);
    expect(html).toContain(pack.roleView.purpose);
    expect(html).toContain(`Report template: ${report}`);
    expect(html).toContain(field);
    expect(html).toContain(prompt);
    expect(html).not.toContain(absent);
    expect(html).toContain('Observation tick');
    expect(html).toContain('Evidence references');
    expect(html).toContain('Keep report IDs, source ticks and availability distinct from later interpretations.');
    expect(html).toContain('aria-label="Learning prompts"');
    expect(html).not.toMatch(/<(?:button|input|textarea|select|form)\b/);
  });

  it('uses the supplied optional island content and drops it on a subsequent generic render', () => {
    const island = render(context('commander', 'crosscurrent-island-network'));
    expect(island).toContain('Crosscurrent island network');
    expect(island).toContain('Stations and objective continuity');
    expect(island).toContain('Priority station');
    expect(island).toContain('A holdings snapshot alone does not prove continuous control or earlier points.');
    const generic = render(context());
    expect(generic).not.toContain('Stations and objective continuity');
    expect(generic).not.toContain('Priority station');
  });

  it('renders pack prose as escaped text rather than markup', () => {
    const pack = context();
    const text = '<img src=x onerror=alert(1)>';
    const annotated: ResolvedOrganizationPack = {
      ...pack, title: text,
      roleView: { ...pack.roleView, purpose: text,
        report: { ...pack.roleView.report, fields: [{ ...pack.roleView.report.fields[0], description: text }] },
        learningPrompts: [{ ...pack.roleView.learningPrompts[0], prompt: text }],
      },
      glossary: [{ ...pack.glossary[0], definition: text }],
    };
    const html = render(annotated);
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)).toHaveLength(5);
    expect(html).not.toMatch(/<img\b/);
  });

  it('renders repeatedly from frozen props without requests, controls or shared-data changes', () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', fetch);
    const pack = context('intelligence');
    const before = JSON.stringify(pack);
    const first = render(pack);
    render(context('instructor'));
    expect(render(pack)).toBe(first);
    expect(JSON.stringify(pack)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(first).not.toMatch(/<(?:button|input|textarea|select|form|script|iframe)\b/);
  });
});
