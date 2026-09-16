import { describe, expect, it } from 'vitest';
import { buildDebriefContext, validateDebrief, type Debrief, type ExerciseRecord } from '../../src/learning/index';
import { curriculum, ev, learner, liveAttempt, order, report } from './fixtures';

/** Live attempt with a model-driven opponent decision after the second order and a later release. */
function withOpponent(): ExerciseRecord {
  const rec = liveAttempt('cur');
  rec.events.push(
    ev({ kind: 'model_decision', id: 'md-1', tick: 210, actor: 'luna-cur-red', side: 'red', summary: 'Expanded into unclaimed adjoining territory with 180 forces and asked staff to watch estimates.', details: { receipt: { id: 'rcpt-1', usd: 0.01 }, observation: { reports: [{ id: 'red-secret' }] }, calls: [{ tool: 'submit_order', arguments: '{"intent":{"type":"attack","targetID":null,"troops":180}}' }, { tool: 'delegate_watch', arguments: '{"title":"Watch estimates"}' }] } }),
    ev({ kind: 'tool_result', id: 'tr-1', tick: 210, actor: 'luna-cur-red', side: 'red', summary: 'submit_order completed', details: { tool: 'submit_order', output: { id: 'c9', status: 'queued' }, receiptId: 'rcpt-1' } }),
    ev({ kind: 'staff_update', id: 'su-late', tick: 300, actor: learner.subject, side: 'blue', summary: 'Assessment changed: r2 supersedes r1.', details: { taskId: 't1', sourceIds: ['cur-r2', 'cur-r1'] } }),
  );
  rec.reports.push(report('cur-r3', 600, 'cur-r2'));
  return rec;
}

function goodDebrief(ctx: ReturnType<typeof buildDebriefContext>): Debrief {
  return {
    headline: { text: 'A 70% commitment was issued with no recorded reason while the initial estimate was current.', citations: ['cur-o2', 'cur-r1'] },
    observations: [
      { text: 'At submission you held 1,000 forces and committed 700.', citations: ['cur-o2', 'cur-o2:before'], basis: 'available-then' },
      { text: 'The updated estimate arrived after this order.', citations: ['cur-r2'], basis: 'hindsight' },
    ],
    opponentPerspective: [{ text: 'The opponent controller then expanded with 180 forces and delegated a watch; its order was queued.', citations: ['md-1', 'tr-1'], basis: 'hindsight' }],
    tradeoffs: [{ text: 'Retaining 300 forces limited the response to the later release.', citations: ['cur-o2', ctx.hindsightIds.find(id => id.endsWith(':after'))!], basis: 'hindsight' }],
    questions: [{ text: 'What did you expect the 700-force commitment to achieve, and what did you keep in reserve?', citations: ['cur-o2'] }],
    nextPractice: [{ text: 'Write the reason before the order next session.', citations: ['C5'] }],
    limitations: [{ text: 'Criteria are provisional and unreviewed; no reviewed source is loaded.', citations: ['SRC-000'] }],
  };
}

describe('buildDebriefContext', () => {
  it('requires an empty opponent section when no opponent action was supplied, without weakening validation', () => {
    const ctx=buildDebriefContext(liveAttempt('cur'),'cur-o2',curriculum);
    expect(JSON.parse(ctx.prompt.input).references.some((r:any)=>['model_decision','tool_result'].includes(r.kind))).toBe(false);
    expect((ctx.outputSchema.schema as any).properties.opponentPerspective.maxItems).toBe(0);
    expect(ctx.prompt.instructions).toContain('Leave opponentPerspective empty');
    const candidate=goodDebrief(ctx);candidate.opponentPerspective=[];
    expect(validateDebrief(candidate,ctx).ok).toBe(true);
    candidate.opponentPerspective=[{text:'Opponent activity was absent.',citations:['cur-o2'],basis:'available-then'}];
    expect(validateDebrief(candidate,ctx).errors).toContain('opponentPerspective[0]: must cite an opponent action record');
    const supported=buildDebriefContext(withOpponent(),'cur-o2',curriculum);
    expect((supported.outputSchema.schema as any).properties.opponentPerspective.maxItems).toBe(1);
    expect(validateDebrief(goodDebrief(supported),supported).ok).toBe(true);
  });

  it('bases the opponent section limit on the final bounded prompt, not the full reference catalog', () => {
    const ctx=buildDebriefContext(withOpponent(),'cur-o2',curriculum,{maxChars:500});
    expect(ctx.references.some(r=>r.kind==='model_decision')).toBe(true);
    expect(JSON.parse(ctx.prompt.input).references.some((r:any)=>['model_decision','tool_result'].includes(r.kind))).toBe(false);
    expect((ctx.outputSchema.schema as any).properties.opponentPerspective.maxItems).toBe(0);
  });

  it('separates what was available at the observed tick from explicit hindsight', () => {
    const ctx = buildDebriefContext(withOpponent(), 'cur-o2', curriculum);
    expect(ctx.observedTick).toBe(199);
    expect(ctx.availableThenIds).toEqual(expect.arrayContaining(['cur-o2', 'cur-o2:before', 'cur-r1']));
    expect(ctx.availableThenIds).not.toContain('cur-r2');
    expect(ctx.availableThenIds).not.toContain('su-late');
    expect(ctx.availableThenIds).not.toContain('md-1');
    expect(ctx.hindsightIds).toEqual(expect.arrayContaining(['md-1', 'tr-1', 'cur-o2:after', 'cur-r2', 'cur-r3', 'su-late']));
    const later = ctx.references.filter(r => r.tick !== undefined && r.tick > ctx.observedTick);
    expect(later.every(r => r.availability === 'hindsight')).toBe(true);
    expect(ctx.criterionIds).toEqual(expect.arrayContaining(['C1', 'C7', 'SRC-000']));
  });

  it('includes the opponent action summary and tool receipts as data only, never its observation payload', () => {
    const ctx = buildDebriefContext(withOpponent(), 'cur-o2', curriculum);
    const md = ctx.references.find(r => r.id === 'md-1')!;
    expect(md.content).toMatch(/not reasoning/);
    expect(md.content).toContain('submit_order(');
    expect(ctx.prompt.input).not.toContain('red-secret');
    expect(ctx.prompt.input).not.toContain('usd');
    expect(ctx.references.find(r => r.id === 'tr-1')?.content).toMatch(/status queued/);
    expect(ctx.prompt.instructions).toMatch(/never state or guess why/);
    expect(ctx.prompt.instructions).toMatch(/cite at least one supplied reference ID/);
  });

  it('uses the earliest opponent decision after the order, not one before it', () => {
    const rec = withOpponent();
    rec.events.push(ev({ kind: 'model_decision', id: 'md-early', tick: 100, actor: 'luna-cur-red', side: 'red', summary: 'earlier', details: { calls: [] } }));
    const ctx = buildDebriefContext(rec, 'cur-o2', curriculum);
    expect(ctx.references.some(r => r.id === 'md-early')).toBe(false);
    expect(ctx.references.some(r => r.id === 'md-1')).toBe(true);
  });

  it('labels post-hoc rationale as hindsight and contemporaneous rationale as available then', () => {
    const rec = liveAttempt('cur');
    rec.events.push(ev({ kind: 'decision_log', id: 'dl-1', tick: 450, details: { commandId: 'cmd-cur-o2', text: 'Pressing early.', timing: 'post-hoc' } }));
    expect(buildDebriefContext(rec, 'cur-o2', curriculum).hindsightIds).toContain('dl-1:rationale');
    expect(buildDebriefContext(rec, 'cur-o1', curriculum).availableThenIds).toContain('cur-o1:rationale');
  });

  // D1: a source-only citation enters the catalogue as provenance, not as a rationale statement.
  it('catalogues a citation without text as provenance and never as a statement', () => {
    const rec = liveAttempt('cur');
    const cited = order({ id: 'cur-o4', tick: 500 });
    cited.details.sourceIds = ['cur-r1'];
    cited.details.rationaleTiming = 'contemporaneous';
    rec.events.push(cited);
    const ctx = buildDebriefContext(rec, 'cur-o4', curriculum);
    const ref = ctx.references.find(r => r.id === 'cur-o4:citation')!;
    expect(ref).toMatchObject({ kind: 'rationale', availability: 'available-then', tick: 499 });
    expect(ref.content).toMatch(/cited cur-r1 at submission without a written reason/);
    expect(ref.content).toMatch(/not a statement of reasoning/);
    expect(ctx.references.some(r => r.id === 'cur-o4:rationale')).toBe(false);
    expect(ctx.prompt.instructions).toMatch(/citation reference without a statement is provenance only/);
  });

  // D4: every statement is catalogued, the earlier one is marked superseded, and the context input
  // (which the service hashes for cache staleness) changes when a statement is added.
  it('catalogues every decision statement with the latest post-hoc one current', () => {
    const rec = liveAttempt('cur');
    rec.events.push(ev({ id: 'dl-first', kind: 'decision_log', tick: 450, details: { commandId: 'cmd-cur-o2', text: 'First reason.', sourceIds: [], timing: 'post-hoc' } }));
    const one = buildDebriefContext(rec, 'cur-o2', curriculum);
    rec.events.push(ev({ id: 'dl-second', kind: 'decision_log', tick: 460, details: { commandId: 'cmd-cur-o2', text: 'Corrected reason.', sourceIds: ['cur-r1'], timing: 'post-hoc' } }));
    const two = buildDebriefContext(rec, 'cur-o2', curriculum);
    expect(two.hindsightIds).toEqual(expect.arrayContaining(['dl-first:rationale', 'dl-second:rationale']));
    expect(two.references.find(r => r.id === 'dl-first:rationale')?.content).toMatch(/earlier post-hoc statement, superseded by the later statement dl-second/);
    expect(two.references.find(r => r.id === 'dl-second:rationale')?.content).toMatch(/^Participant's post-hoc statement: "Corrected reason." citing cur-r1\./);
    expect(two.prompt.input).not.toBe(one.prompt.input);
    // A post-hoc annotation never displaces the submission-time statement.
    rec.events.push(ev({ id: 'dl-o1', kind: 'decision_log', tick: 470, details: { commandId: 'cmd-cur-o1', text: 'Afterthought.', timing: 'post-hoc' } }));
    const o1 = buildDebriefContext(rec, 'cur-o1', curriculum);
    expect(o1.availableThenIds).toContain('cur-o1:rationale');
    expect(o1.hindsightIds).toContain('dl-o1:rationale');
    expect(o1.references.find(r => r.id === 'cur-o1:rationale')?.content).toMatch(/^Participant's contemporaneous statement/);
  });

  it('bounds the prompt input and rejects non-human commands', () => {
    const rec = withOpponent();
    rec.reports[0].body = 'x'.repeat(5000);
    const ctx = buildDebriefContext(rec, 'cur-o2', curriculum, { maxChars: 3000 });
    expect(ctx.prompt.input.length).toBeLessThanOrEqual(3000);
    expect(ctx.prompt.truncated).toBe(true);
    expect(JSON.parse(ctx.prompt.input).commandEventId).toBe('cur-o2');
    rec.events.push(order({ id: 'bot', tick: 700, actor: 'baseline-controller', side: 'red', origin: 'deterministic-baseline' }));
    expect(() => buildDebriefContext(rec, 'bot', curriculum)).toThrow(/not a human order/);
    expect(() => buildDebriefContext(rec, 'nope', curriculum)).toThrow(/not found/);
  });
});

describe('validateDebrief', () => {
  const ctx = buildDebriefContext(withOpponent(), 'cur-o2', curriculum);

  it('accepts a debrief whose every citation exists, including a JSON string', () => {
    const good = goodDebrief(ctx);
    expect(validateDebrief(good, ctx)).toEqual({ ok: true, errors: [], debrief: good });
    expect(validateDebrief(JSON.stringify(good), ctx).ok).toBe(true);
  });

  it('rejects unknown citations and uncited claims', () => {
    const bad = goodDebrief(ctx);
    bad.observations[0].citations = ['made-up-id'];
    bad.tradeoffs[0].citations = [];
    const v = validateDebrief(bad, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(expect.arrayContaining([expect.stringMatching(/observations\[0\]: unknown citation "made-up-id"/), expect.stringMatching(/tradeoffs\[0\]: claim has no citation/)]));
    expect(v.debrief).toBeUndefined();
  });

  it('rejects hindsight cited as available then', () => {
    const bad = goodDebrief(ctx);
    bad.observations[1].basis = 'available-then';
    expect(validateDebrief(bad, ctx).errors).toEqual([expect.stringMatching(/observations\[1\]: cites hindsight but is labelled available-then/)]);
  });

  // D5: a claim that cites hindsight with no basis at all is rejected, headline included.
  it('rejects hindsight citations that carry no basis', () => {
    const bad = goodDebrief(ctx);
    delete bad.observations[1].basis;
    bad.headline = { text: 'The later estimate changed the picture.', citations: ['cur-r2'] };
    const v = validateDebrief(bad, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([expect.stringMatching(/^headline: cites hindsight without basis "hindsight"/), expect.stringMatching(/^observations\[1\]: cites hindsight without basis "hindsight"/)]);
    // Claims that cite only available-then references may still omit basis.
    const ok = goodDebrief(ctx);
    delete ok.observations[0].basis;
    expect(validateDebrief(ok, ctx).ok).toBe(true);
  });

  it('rejects inferred opponent reasoning and opponent claims without an action record', () => {
    const bad = goodDebrief(ctx);
    bad.opponentPerspective = [
      { text: 'The opponent wanted to bait a large commitment.', citations: ['md-1'], basis: 'hindsight' },
      { text: 'The opponent expanded.', citations: ['cur-r2'], basis: 'hindsight' },
    ];
    const v = validateDebrief(bad, ctx);
    expect(v.errors).toEqual(expect.arrayContaining([expect.stringMatching(/opponentPerspective\[0\]: attributes hidden reasoning/), expect.stringMatching(/opponentPerspective\[1\]: must cite an opponent action record/)]));
  });

  it('rejects doctrine or mastery claims with no approved source, and real-world framing', () => {
    const bad = goodDebrief(ctx);
    bad.headline = { text: 'You have mastered evidence currency per approved doctrine.', citations: ['cur-o2', 'SRC-000'] };
    bad.tradeoffs.push({ text: 'In real-world targeting this would be decisive.', citations: ['cur-o2'] });
    const v = validateDebrief(bad, ctx);
    expect(v.errors).toEqual(expect.arrayContaining([expect.stringMatching(/headline: doctrine\/mastery claim without an approved source/), expect.stringMatching(/tradeoffs\[1\]: real-world tactical framing/)]));
    // Approval only counts when that source was in the actual submitted prompt.
    const reviewedCurriculum=structuredClone(curriculum);reviewedCurriculum.sources.push({id:'SRC-9',title:'Reviewed',status:'approved'} as typeof reviewedCurriculum.sources[number]);
    const approvedCtx=buildDebriefContext(withOpponent(),'cur-o2',reviewedCurriculum);
    const ok = goodDebrief(ctx);
    ok.headline = { text: 'Reviewed doctrine source applied.', citations: ['SRC-9'] };
    expect(validateDebrief(ok, approvedCtx).ok).toBe(true);
  });

  it('requires nextPractice to cite a criterion and limitations to say provisional', () => {
    const bad = goodDebrief(ctx);
    bad.nextPractice = [{ text: 'Practice more.', citations: ['cur-o2'] }];
    bad.limitations = [{ text: 'None.', citations: [] }];
    const v = validateDebrief(bad, ctx);
    expect(v.errors).toEqual(expect.arrayContaining([expect.stringMatching(/nextPractice\[0\]: must cite a criterion ID/), 'limitations: must state that criteria are provisional']));
  });

  it('rejects malformed shapes without throwing', () => {
    expect(validateDebrief('not json', ctx).ok).toBe(false);
    expect(validateDebrief({ headline: 'string' }, ctx).errors).toEqual(expect.arrayContaining([expect.stringMatching(/headline must be a claim/), expect.stringMatching(/observations must be an array/)]));
  });
});

 it('supplies a closed strict schema with every field required for provider acceptance',()=>{const schema=buildDebriefContext(withOpponent(),'cur-o2',curriculum).outputSchema.schema;const visit=(node:any)=>{if(!node||typeof node!=='object')return;if(node.type==='object'){expect(node.additionalProperties).toBe(false);expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());}for(const v of Object.values(node))if(v&&typeof v==='object'){if(Array.isArray(v))v.forEach(visit);else visit(v);}};visit(schema);});
