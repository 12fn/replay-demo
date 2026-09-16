import { describe, expect, it } from 'vitest';
import { buildDebriefContext, buildDossier, DISCLAIMER, formatDebriefMarkdown, formatDossierMarkdown, validateDebrief, type Debrief } from '../../src/learning/index';
import { curriculum, ev, learner, liveAttempt, order } from './fixtures';

describe('Markdown artifacts', () => {
  const current = liveAttempt('cur');
  const branch = liveAttempt('cur-branch', { kind: 'branch', parentId: 'cur', forkTick: 200, createdAt: '2026-09-13T11:00:00Z' });
  const dossier = buildDossier({ identity: learner, current, candidates: [branch, liveAttempt('theirs', { ownerSubject: 'user-bravo' })], curriculum });

  it('renders a clean dossier with local evidence IDs and no guessed URLs', () => {
    const md = formatDossierMarkdown(dossier);
    expect(md.startsWith('# Learning dossier · commander · user-alpha\n\n> ')).toBe(true);
    expect(md).toContain(DISCLAIMER);
    expect(md).toContain('| Attempt | Label | Assistance | Orders | With reason | Citing source | Responses/releases |');
    expect(md).toMatch(/\| cur \| current \| unassisted \| 3 \| 1 \| 1 \| 2\/2 \|/);
    expect(md).toMatch(/\| cur-branch \| informed-practice \|/);
    expect(md).toContain('`cur-o2`');
    expect(md).not.toMatch(/https?:\/\//);
    expect(md).not.toMatch(/\]\(/);
    expect(md).toContain('## Questions for you');
    expect(md).toContain('## Next session plan · commander · variant PV-1');
    expect(md).toContain('## Counterfactual practice (separate)');
    expect(md).toContain('- `theirs`: different-subject');
    expect(md).not.toMatch(/\n{3,}/);
    expect(md.endsWith('\n')).toBe(true);
    expect(md.split('\n').filter(l => l.startsWith('## ')).length).toBeGreaterThanOrEqual(7);
  });

  it('uses the caller-supplied link resolver only when it returns a target', () => {
    const md = formatDossierMarkdown(dossier, { link: id => (id === 'cur-o2' ? '#event/cur-o2' : undefined) });
    expect(md).toContain('[`cur-o2`](#event/cur-o2)');
    expect(md).toContain('`cur-o1`');
    expect(md).not.toContain('[`cur-o1`](');
  });

  it('renders a validated debrief with hindsight marks and a reference table', () => {
    const ctx = buildDebriefContext(current, 'cur-o2', curriculum);
    const debrief: Debrief = {
      headline: { text: 'Order issued without a recorded reason.', citations: ['cur-o2'] },
      observations: [{ text: 'You committed 700 of 1,000.', citations: ['cur-o2:before'], basis: 'available-then' }, { text: 'A new estimate arrived later.', citations: ['cur-r2'], basis: 'hindsight' }],
      opponentPerspective: [],
      tradeoffs: [],
      questions: [{ text: 'What did you expect?', citations: [] }],
      nextPractice: [{ text: 'Write the reason first.', citations: ['C5'] }],
      limitations: [{ text: 'Criteria are provisional.', citations: [] }],
    };
    const v = validateDebrief(debrief, ctx);
    expect(v.ok).toBe(true);
    const md = formatDebriefMarkdown(v.debrief!, ctx);
    expect(md.startsWith('# Debrief · order `cur-o2` · tick 200\n\n> ')).toBe(true);
    expect(md).toContain('- A new estimate arrived later. _(hindsight)_ [`cur-r2`]');
    expect(md).toContain('- You committed 700 of 1,000. [`cur-o2:before`]');
    expect(md).not.toContain('## Opponent record');
    expect(md).toContain('| `cur-r2` | report | 300 | hindsight |');
    expect(md).toContain('| `cur-r1` | report | 0 | available-then |');
    expect(md).not.toMatch(/https?:\/\//);
    expect(md).not.toMatch(/\n{3,}/);
  });

  // D5: the hindsight mark follows the citations, so a claim without `basis` (or the headline) is still marked.
  it('marks hindsight from citations when basis is absent, headline included', () => {
    const ctx = buildDebriefContext(current, 'cur-o2', curriculum);
    const debrief: Debrief = {
      headline: { text: 'The later estimate changed the picture.', citations: ['cur-r2'] },
      observations: [{ text: 'A new estimate arrived later.', citations: ['cur-r2'] }, { text: 'You committed 700 of 1,000.', citations: ['cur-o2:before'] }],
      opponentPerspective: [], tradeoffs: [], questions: [], nextPractice: [{ text: 'Write the reason first.', citations: ['C5'] }],
      limitations: [{ text: 'Criteria are provisional.', citations: [] }],
    };
    const md = formatDebriefMarkdown(debrief, ctx);
    expect(md).toContain('**The later estimate changed the picture.** _(hindsight)_ [`cur-r2`]');
    expect(md).toContain('- A new estimate arrived later. _(hindsight)_ [`cur-r2`]');
    expect(md).toContain('- You committed 700 of 1,000. [`cur-o2:before`]');
  });

  // D1 / D4: the dossier artifact names citation-only evidence and multiple statements explicitly.
  it('labels citation-only orders and multiple statements in the dossier artifact', () => {
    const rec = liveAttempt('cur');
    const cited = order({ id: 'cur-o4', tick: 500 });
    cited.details.sourceIds = ['cur-r1'];
    cited.details.rationaleTiming = 'contemporaneous';
    rec.events.push(cited);
    rec.events.push(ev({ id: 'dl-a', kind: 'decision_log', tick: 450, details: { commandId: 'cmd-cur-o2', text: 'First.', timing: 'post-hoc' } }));
    rec.events.push(ev({ id: 'dl-b', kind: 'decision_log', tick: 460, details: { commandId: 'cmd-cur-o2', text: 'Second.', timing: 'post-hoc' } }));
    const md = formatDossierMarkdown(buildDossier({ identity: learner, current: rec, candidates: [], curriculum }));
    expect(md).toMatch(/`cur-o4` · tick 500 · command · .* · citation only, no written reason \(contemporaneous\) · cites `cur-r1` superseded/);
    expect(md).not.toMatch(/`cur-o4`[^\n]*reason recorded/);
    expect(md).toMatch(/`cur-o2`[^\n]*reason recorded \(post-hoc; 2 statements on record, latest post-hoc statement current\)/);
    expect(md).toMatch(/\| cur \| current \| unassisted \| 4 \| 2 \| 2 \| 2\/2 \|/);
  });
});
