import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCatalog } from '../../src/client/agent-api';
import { StaffDecisionAid, aidPrompts, type AidRole } from '../../src/client/components/StaffDecisionAid';
import { isWatchRequest } from '../../src/agents/watch-request';
import { interpretWatch } from '../../src/agents/staff';

const ROLES: AidRole[] = ['commander', 'intelligence', 'instructor'];

const catalog = (over: Partial<ToolCatalog> = {}): ToolCatalog => ({
  exerciseId: 'ex-1',
  side: 'blue',
  scope: 'player',
  tools: [
    { name: 'list_reports', kind: 'query', description: 'List own-side reports <script>alert(1)</script> & "sources"', args: { type: 'object', properties: {}, required: [] } },
    { name: 'delegate_watch', kind: 'action', description: 'Create a free durable watch.', args: { type: 'object', properties: {}, required: ['objective'] } },
  ],
  staffTools: ['list_reports'],
  unavailable: ['code execution', 'network'],
  pulseBudget: { maxSteps: 4, maxCompletions: 2 },
  opponent: { enabled: false, playstyle: 'cautious', model: 'red-model-x' },
  budget: { requestsUsed: 1, maxRequests: 100, committedUsd: 0.01, maxUsd: 5 },
  ...over,
});

const render = (role: AidRole, cat: ToolCatalog | null, disabled?: boolean) =>
  renderToStaticMarkup(createElement(StaffDecisionAid, { role, catalog: cat, onPrepareQuestion: vi.fn(), disabled }));

// Minimal context: only what interpretWatch reads for these grammars.
const watchCtx = { engine: { game: { ticks: () => 10 } }, objectives: () => ({ tick: 10, stations: [] }) } as unknown as Parameters<typeof interpretWatch>[1];

describe('staff decision aid prompts', () => {
  it.each(ROLES)('%s gets distinct provenance and watch prompts', (role) => {
    const prompts = aidPrompts(role);
    const provenance = prompts.filter((p) => p.kind === 'provenance');
    const watches = prompts.filter((p) => p.kind === 'watch');
    expect(provenance.length).toBeGreaterThan(0);
    expect(watches.length).toBeGreaterThan(0);
    for (const p of provenance) {
      expect(p.question).toMatch(/source/i);
      expect(p.question).toMatch(/tick/i);
      expect(isWatchRequest(p.question)).toBe(false);
    }
    for (const w of watches) {
      expect(isWatchRequest(w.question)).toBe(true);
      expect(() => interpretWatch(w.question, watchCtx)).not.toThrow();
    }
  });

  it('tailors prompts by role', () => {
    const questions = ROLES.map((r) => aidPrompts(r).map((p) => p.question).join('|'));
    expect(new Set(questions).size).toBe(ROLES.length);
    expect(render('commander', null)).toContain('commit, hold or shift forces');
    expect(render('intelligence', null)).toContain('which conflict');
    expect(render('instructor', null)).toContain('at the decision point');
  });

  it('starts collapsed with the aid essentials and no governance scaffolding', () => {
    const html = render('commander', catalog());
    expect(html).toMatch(/^<details class="tool-disclosure"><summary>Choose useful AI support<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain('Use a watch for recurring checks; ask staff when you need interpretation.');
    expect(html).toContain('Compare source, tick and any conflict before choosing.');
    expect(html).toContain('You own the decision.');
    expect(html).not.toMatch(/mastery|doctrine|approval required|must pause/i);
  });
});

describe('prepared question buttons', () => {
  it('have accessible labels that start with the visible text and fill the question', () => {
    const onPrepareQuestion = vi.fn();
    const el = StaffDecisionAid({ role: 'intelligence', catalog: null, onPrepareQuestion });
    const html = renderToStaticMarkup(el);
    for (const p of aidPrompts('intelligence')) {
      expect(html).toContain(`aria-label="${p.label}: fill question &quot;${p.question}&quot;"`);
      expect(html).toContain(`>${p.label}</button>`);
    }
    // Walk the element tree to invoke the real click handler: it only passes the question text.
    const buttons: { props: { onClick: () => void; 'aria-label': string } }[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object' || !('props' in node) || !('type' in node)) return;
      const props = (node as { type: unknown; props: Record<string, unknown> }).props;
      if ((node as { type: unknown }).type === 'button') buttons.push(node as never);
      walk(props.children);
    };
    walk(el);
    expect(buttons).toHaveLength(2);
    buttons.forEach((b) => b.props.onClick());
    expect(onPrepareQuestion.mock.calls.map((c) => c[0])).toEqual(aidPrompts('intelligence').map((p) => p.question));
  });

  it('respects disabled state', () => {
    expect(render('commander', null).match(/<button[^>]*disabled/g)).toBeNull();
    expect(render('commander', null, true).match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  });
});

describe('catalog view', () => {
  it('missing catalog does not claim available capabilities', () => {
    const html = render('commander', null);
    expect(html).toContain('Tool catalog not loaded. Available tools and model settings are unknown.');
    expect(html).not.toContain('tool-list');
    expect(html).not.toMatch(/Not available|Paid pulses|opponent|<code>/);
  });

  it('shows actual tool titles and descriptions escaped', () => {
    const html = render('intelligence', catalog());
    expect(html).toContain('<code>list_reports</code>');
    expect(html).toContain('<code>delegate_watch</code>');
    expect(html).toContain('query · watch read-only · List own-side reports &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;sources&quot;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('action · Create a free durable watch.');
    expect(html).toContain('Not available: code execution, network.');
    expect(html).toContain('up to 2 requests, 4 tool steps');
  });

  it('reports model config only as the catalog states it', () => {
    const off = render('commander', catalog());
    expect(off).toContain('Red Cell opponent: off.');
    expect(off).not.toContain('red-model-x');
    expect(off).toContain('Staff model: not reported by this catalog.');
    const on = render('commander', catalog({ opponent: { enabled: true, playstyle: 'aggressive', model: 'red-model-x' } }));
    expect(on).toContain('Red Cell opponent: on · aggressive · Connected model.');
    expect(on).not.toContain('red-model-x');
  });

  it('an empty catalog says so rather than inventing tools', () => {
    const html = render('instructor', catalog({ tools: [], staffTools: [], unavailable: [] }));
    expect(html).toContain('This catalog lists no tools.');
    expect(html).not.toContain('Not available:');
  });
});
