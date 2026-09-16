import { describe, expect, it } from 'vitest';
import { selectKeyMoments, KEY_MOMENT_GROUPING, KEY_MOMENT_LIMITATIONS, type KeyMoment, type KeyMomentSelection } from '../../src/learning/key-moments';
import type { ExerciseRecord, LearningEvent } from '../../src/learning/index';
import { ev, learner, meta, order, other, report } from './fixtures';

const EX = 'ex-km';

function boatOrder(id: string, tick: number, opts: { actor?: string; tile?: number; troops?: number; observedTick?: number } = {}): LearningEvent {
  return ev({ id, kind: 'command', tick, actor: opts.actor, summary: `Transport ${opts.troops ?? 150} forces`, details: { commandId: `cmd-${id}`, origin: 'human', intent: { type: 'boat', targetID: null, troops: opts.troops ?? 150, dst: opts.tile ?? 4200 }, observedTick: opts.observedTick ?? tick - 1, before: { troops: 1000, tiles: 30 }, inputKey: { turnNumber: tick, intentIndex: 0, clientID: 'blue' }, sourceExerciseId: EX, effectObserved: true } });
}

function feedback(id: string, tick: number, commandEventId: string, status: string, observed: Record<string, unknown> = {}): LearningEvent {
  return ev({ id, kind: 'execution_feedback', tick, actor: learner.subject, summary: status.replaceAll('-', ' '), details: { schema: 'replay.execution-receipt/1', version: 1, feedback: { status, observed: { kind: 'transport', ...observed } }, commandId: `cmd-${commandEventId}`, sourceExerciseId: EX, inherited: false } });
}

function objective(id: string, tick: number, controllers: Record<string, 'blue' | 'red' | null>, scores = { blue: 0, red: 0 }, award: any = null, inherited = false): LearningEvent {
  return ev({ id, kind: 'objective_update', tick, actor: 'exercise-director', side: null, summary: 'Station control or priority changed', details: { schema: 'replay.objective-update/1', state: { schema: 'replay.network-state/1', tick, scores, lastAwardTick: 0, controllers, priorityId: 'aster' }, award, inherited } });
}

const STATIONS = { aster: null, beacon: null, cedar: null } as Record<string, 'blue' | 'red' | null>;

/** A varied attempt: tradeoff order, superseded release, ineffective transport, follow-on, rejection, effective transport, station flip, staff update, opponent records. */
function varied(): ExerciseRecord {
  const reports = [report(`${EX}-r1`, 0), report(`${EX}-r2`, 300, `${EX}-r1`)];
  const events: LearningEvent[] = [
    ev({ id: 'started', kind: 'exercise_started', tick: 0, actor: 'facilitator', side: null }),
    ev({ id: 'rel-1', kind: 'report', tick: 0, actor: 'exercise-reporter', details: { reportId: reports[0].id } }),
    objective('obj-0', 0, STATIONS),
    order({ id: 'o-tradeoff', tick: 50, troops: 700, rationale: 'Commit hard early while the estimate is fresh.', rationaleTiming: 'contemporaneous', sourceIds: [reports[0].id] }),
    ev({ id: 'task-1', kind: 'task_created', tick: 60, summary: 'Staff assigned: watch estimates', details: { taskId: 't1', objective: 'source currency', kind: 'watch' } }),
    ev({ id: 'md-1', kind: 'model_decision', tick: 120, actor: 'luna-red', side: 'red', summary: 'Opponent decision', details: { receipt: { id: 'rcpt-1' }, observation: { secret: 'hidden' }, calls: [] } }),
    ev({ id: 'tr-1', kind: 'tool_result', tick: 120, actor: 'luna-red', side: 'red', summary: 'submit_order completed', details: { tool: 'submit_order', output: {} } }),
    ev({ id: 'red-cmd', kind: 'command', tick: 125, actor: 'luna-red', side: 'red', summary: 'Red expanded', details: { commandId: 'cmd-red', origin: 'agent', intent: { type: 'attack', troops: 300 } } }),
    boatOrder('o-boat-fail', 200),
    feedback('fb-fail', 205, 'o-boat-fail', 'transport-not-launched', { orderedTroops: 150, troopsDelta: 0, transportsAtSeaAtAttempt: 3, transportLimit: 3 }),
    order({ id: 'o-follow', tick: 260, troops: 100 }),
    ev({ id: 'rel-2', kind: 'report', tick: 300, actor: 'exercise-reporter', summary: 'Updated resource estimate', details: { reportId: reports[1].id, supersedes: reports[0].id } }),
    ev({ id: 'su-1', kind: 'staff_update', tick: 305, actor: 'staff-watcher', summary: 'Assessment changed: r2 supersedes r1.', details: { taskId: 't1', sourceIds: [reports[1].id, reports[0].id], method: 'deterministic provenance watcher', observedTick: 305 } }),
    ev({ id: 'rej-1', kind: 'command_rejected', tick: 400, summary: 'Order could not execute', details: { commandId: 'cmd-rej', reason: 'Not enough troops' } }),
    boatOrder('o-boat-ok', 500, { tile: 5100 }),
    feedback('fb-launch', 501, 'o-boat-ok', 'transport-launched', { troopsEmbarked: 150 }),
    feedback('fb-land', 540, 'o-boat-ok', 'transport-landed', { targetOwnerBefore: null, targetOwnerAfter: 'blue' }),
    objective('obj-1', 600, { ...STATIONS, beacon: 'blue' }, { blue: 0, red: 0 }),
    objective('obj-2', 900, { ...STATIONS, beacon: 'blue' }, { blue: 1, red: 0 }, { blue: { stations: 1, priority: 0, reserve: 0, total: 1 }, red: { stations: 0, priority: 0, reserve: 0, total: 0 } }),
  ];
  return { exercise: meta({ id: EX }), events, reports };
}

const kinds = (sel: KeyMomentSelection) => sel.selected.map(m => m.kind);
const ids = (ms: KeyMoment[]) => ms.map(m => m.id);

describe('selectKeyMoments · meaningful diverse moments', () => {
  const sel = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 1000 }, limit: 6 });

  it('surfaces ineffective orders, rejections, recoveries, effects and rule changes rather than the last N orders', () => {
    expect(sel.schema).toBe('replay.key-moments/1');
    expect(sel.selected).toHaveLength(6);
    for (const k of ['order-ineffective', 'follow-on-after-ineffective', 'order-rejected', 'objective-control-changed', 'order-tradeoff']) expect(kinds(sel)).toContain(k);
    expect(new Set(sel.candidates.map(m => m.kind)).size).toBe(9);
    const ticks = sel.selected.map(m => m.tick);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    // Temporal spread: the late award (tick 900) is preferred over a second moment in the tick 500–600 stretch.
    expect(ticks.at(-1)).toBe(900);
    expect(new Set(kinds(sel)).size).toBe(6);
  });

  it('gives every moment explicit reasons and evidence refs that exist in the record', () => {
    const known = new Set(varied().events.map(e => e.id));
    for (const m of [...sel.selected, ...sel.candidates]) {
      expect(m.reasons.length).toBeGreaterThan(0);
      expect(m.evidence.length).toBeGreaterThan(0);
      for (const e of m.evidence) expect(known.has(e.id)).toBe(true);
      expect(m.interpretation).toContain('No causal link');
    }
  });

  it('links an ineffective order to its engine observation by command ID and reports the measured status', () => {
    const m = sel.selected.find(m => m.kind === 'order-ineffective')!;
    expect(ids([m])).toEqual(['km:order-ineffective:o-boat-fail']);
    expect(m.evidence.map(e => `${e.id}:${e.basis}`)).toEqual(['o-boat-fail:recorded-order', 'fb-fail:engine-observation']);
    expect(m.reasons[0]).toContain('transport-not-launched');
    expect(m.observedTick).toBe(199);
  });

  it('labels the effective transport with landed evidence and the tradeoff order with its written reason and source currency', () => {
    const ok = sel.candidates.find(m => m.id === 'km:order-effective:o-boat-ok')!;
    expect(ok.evidence.map(e => e.id)).toEqual(['o-boat-ok', 'fb-land']);
    const tradeoff = sel.candidates.find(m => m.id === 'km:order-tradeoff:o-tradeoff')!;
    expect(tradeoff.reasons.some(r => r.startsWith('Committed 70%'))).toBe(true);
    expect(tradeoff.reasons.some(r => r.includes('contemporaneous written reason') && r.includes(`${EX}-r1`))).toBe(true);
    expect(tradeoff.reasons.some(r => r.includes('superseded'))).toBe(false); // r2 arrived after tick 49
  });

  it('exposes rule and release records with exercise attribution and staff updates linked by task ID', () => {
    const flip = sel.candidates.find(m => m.kind === 'objective-control-changed')!;
    expect(flip.attribution).toBe('exercise');
    expect(flip.reasons[0]).toContain('beacon: none → blue');
    expect(sel.candidates.find(m => m.kind === 'objective-award')!.reasons[0]).toContain('Blue +1');
    expect(sel.candidates.find(m => m.kind === 'source-superseded')!.reasons[0]).toContain(`supersedes ${EX}-r1`);
    const staff = sel.candidates.find(m => m.kind === 'staff-update')!;
    expect(staff.evidence.map(e => e.id)).toEqual(['su-1', 'task-1']);
  });

  it('never reads or surfaces opponent-controller records or opponent orders', () => {
    const all = JSON.stringify([sel.selected, sel.candidates]);
    expect(all).not.toContain('md-1');
    expect(all).not.toContain('tr-1');
    expect(all).not.toContain('red-cmd');
    expect(all).not.toContain('hidden');
    expect(sel.excluded.filter(x => x.reason === 'opponent-controller-record').map(x => x.id)).toEqual(['md-1', 'tr-1']);
    expect(sel.excluded.find(x => x.id === 'red-cmd')?.reason).toBe('other-side');
    const both = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 1000 }, bothSidesVisible: true });
    expect(JSON.stringify(both.candidates)).not.toContain('red-cmd');
    expect(both.limitations).toEqual([...KEY_MOMENT_LIMITATIONS]);
  });
});

describe('selectKeyMoments · repeated spam', () => {
  function spam(): ExerciseRecord {
    const events: LearningEvent[] = [ev({ id: 'started', kind: 'exercise_started', tick: 0, actor: 'facilitator', side: null })];
    for (let i = 0; i < 10; i++) events.push(order({ id: `spam-${i}`, tick: 100 + i * 5, troops: 600 }));
    events.push(order({ id: 'distinct', tick: 400, troops: 550, rationale: 'Shift weight to the north shore.', rationaleTiming: 'contemporaneous' }));
    for (let i = 0; i < 4; i++) events.push(order({ id: `spam2-${i}`, tick: 500 + i * 5, troops: 600 }));
    return { exercise: meta({ id: EX }), events, reports: [] };
  }
  const sel = selectKeyMoments({ record: spam(), scope: { kind: 'shared' }, cutoff: { tick: 800 }, limit: 6 });

  it('collapses identical consecutive orders into one moment with a repeat count', () => {
    const first = sel.candidates.find(m => m.id === 'km:order-tradeoff:spam-0')!;
    expect(first.repeatCount).toBe(10);
    expect(first.repeatKind).toBe('identical');
    expect(first.repeatRange).toEqual({ troops: [600, 600], ratio: [0.6, 0.6], ticks: [100, 145] });
    expect(first.evidence).toHaveLength(10);
    expect(first.reasons.some(r => r.includes('recorded 10 times consecutively'))).toBe(true);
    expect(sel.candidates).toHaveLength(3);
  });

  it('down-weights a later run of the same order below a distinct decision', () => {
    const second = sel.candidates.find(m => m.id === 'km:order-tradeoff:spam2-0')!;
    const distinct = sel.candidates.find(m => m.id === 'km:order-tradeoff:distinct')!;
    expect(second.repeatCount).toBe(4);
    expect(second.weight).toBeLessThan(distinct.weight);
    expect(second.reasons.some(r => r.includes('down-weighted as a repeat'))).toBe(true);
  });
});

describe('selectKeyMoments · cutoff and future evidence', () => {
  it('excludes records after the cutoff, including later effects of earlier orders', () => {
    const sel = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 203 } });
    const boat = sel.candidates.find(m => m.evidence[0].id === 'o-boat-fail');
    expect(boat).toBeUndefined(); // no observation yet and no tradeoff evidence: not a moment
    expect(sel.excluded.find(x => x.id === 'fb-fail')?.reason).toBe('after-cutoff');
    expect(sel.excluded.find(x => x.id === 'o-boat-fail')?.reason).toBe('not-a-moment');
    expect(sel.candidates.some(m => m.kind === 'follow-on-after-ineffective')).toBe(false);
    expect(sel.candidates.some(m => m.kind === 'objective-control-changed')).toBe(false);
    expect(JSON.stringify([sel.selected, sel.candidates])).not.toContain('obj-1');
    expect(sel.excluded.find(x => x.id === 'obj-1')?.reason).toBe('after-cutoff');
  });

  it('honours a sequence cutoff within the same tick', () => {
    const rec = varied();
    const rel = rec.events.find(e => e.id === 'rel-2')!;
    const before = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 300, sequence: rel.sequence! - 1 } });
    const at = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 300, sequence: rel.sequence } });
    expect(before.candidates.some(m => m.kind === 'source-superseded')).toBe(false);
    expect(before.excluded.find(x => x.id === 'rel-2')?.reason).toBe('after-cutoff');
    expect(at.candidates.some(m => m.kind === 'source-superseded')).toBe(true);
  });

  it('does not treat an order as a recovery until the failure was observable', () => {
    const rec = varied();
    // A second order placed before the engine observation at tick 205 cannot be a follow-on to it.
    rec.events.push(order({ id: 'o-early', tick: 202, troops: 50 }));
    const sel = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    const follow = sel.candidates.find(m => m.kind === 'follow-on-after-ineffective')!;
    expect(follow.evidence[0].id).toBe('o-follow');
  });
});

describe('selectKeyMoments · no causality or quality claims', () => {
  const sel = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 1000 } });

  it('describes a follow-on order as adjacency and objective changes as unattributed rule records', () => {
    const follow = sel.candidates.find(m => m.kind === 'follow-on-after-ineffective')!;
    expect(follow.reasons[0]).toContain('Adjacency in the record only');
    expect(follow.reasons[0]).toContain('not established');
    expect(follow.evidence.map(e => e.id)).toEqual(['o-follow', 'o-boat-fail', 'fb-fail']);
    const flip = sel.candidates.find(m => m.kind === 'objective-control-changed')!;
    expect(flip.reasons.at(-1)).toContain('does not say which order produced the change');
  });

  it('uses no causal or evaluative vocabulary and carries no per-decision score', () => {
    const text = [...sel.candidates.flatMap(m => [m.title, ...m.reasons])].join(' ').toLowerCase();
    for (const banned of ['because', 'caused', 'led to', 'blunder', 'mistake', 'good decision', 'bad decision', 'should have']) expect(text).not.toContain(banned);
    for (const m of sel.candidates) expect(Object.keys(m)).not.toContain('score');
  });

  it('marks unconfirmed engine observations as excluded rather than as effects', () => {
    const rec = varied();
    rec.events.push(boatOrder('o-unconf', 700, { tile: 6100 }), feedback('fb-unconf', 720, 'o-unconf', 'transport-ended-unconfirmed'));
    const sel2 = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    expect(sel2.candidates.some(m => m.evidence.some(e => e.id === 'fb-unconf'))).toBe(false);
    expect(sel2.excluded.find(x => x.id === 'fb-unconf')?.reason).toBe('unconfirmed-observation');
  });
});

describe('selectKeyMoments · scope', () => {
  it('own scope keeps only the subject\'s orders as decisions but retains exercise-level records', () => {
    const rec = varied();
    rec.events.push(order({ id: 'bravo-o', tick: 450, troops: 800, actor: other.subject }), ev({ id: 'bravo-rej', kind: 'command_rejected', tick: 460, actor: other.subject, summary: 'Order could not execute', details: { commandId: 'cmd-bravo-rej', reason: 'Unknown target' } }));
    const own = selectKeyMoments({ record: rec, scope: { kind: 'own', subject: learner.subject }, cutoff: { tick: 1000 } });
    const shared = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    expect(JSON.stringify(own.candidates)).not.toContain('bravo');
    expect(own.excluded.filter(x => x.reason === 'other-participant').map(x => x.id)).toEqual(['bravo-o', 'bravo-rej']);
    expect(own.candidates.some(m => m.kind === 'objective-control-changed')).toBe(true);
    expect(shared.candidates.some(m => m.id === 'km:order-tradeoff:bravo-o')).toBe(true);
    expect(shared.candidates.some(m => m.id === 'km:order-rejected:bravo-rej')).toBe(true);
  });

  it('excludes inherited branch context from candidates', () => {
    const rec = varied();
    rec.events.unshift(ev({ id: 'inh-1', kind: 'inherited_event', tick: 10, actor: learner.subject, summary: 'Inherited', details: { originalKind: 'command', parentId: 'parent', originalDetails: { origin: 'human', intent: { type: 'attack', troops: 900 } } } }));
    const sel = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    expect(sel.excluded.find(x => x.id === 'inh-1')?.reason).toBe('inherited-context');
    expect(JSON.stringify(sel.candidates)).not.toContain('inh-1');
  });
});

describe('selectKeyMoments · source stability', () => {
  it('is deterministic and independent of input event order when sequences are present', () => {
    const a = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    const b = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    const shuffled = varied();
    shuffled.events = [...shuffled.events].reverse();
    const c = selectKeyMoments({ record: shuffled, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
  });

  it('does not mutate its inputs', () => {
    const rec = varied();
    const snapshot = JSON.stringify(rec);
    selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    expect(JSON.stringify(rec)).toBe(snapshot);
  });

  it('changes only when evidence changes: adding a later observation adds a moment without renaming earlier ones', () => {
    const base = selectKeyMoments({ record: varied(), scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    const rec = varied();
    rec.events.push(boatOrder('o-late', 950, { tile: 7000 }), feedback('fb-late', 960, 'o-late', 'transport-forces-returned', { retreatObserved: true }));
    const grown = selectKeyMoments({ record: rec, scope: { kind: 'shared' }, cutoff: { tick: 1000 } });
    for (const id of ids(base.candidates)) expect(ids(grown.candidates)).toContain(id);
    expect(ids(grown.candidates)).toContain('km:order-ineffective:o-late');
  });
});

// ---------------------------------------------------------------------------
// Semantic grouping of equivalent orders (fixed share, varying force)
// ---------------------------------------------------------------------------

const LOAD_REASON = 'Automated campaign load check: fixed18percent neutral expansion, not a human or AI player decision.';

/** A fixed-share order like the native load run: 18% of a growing force, same target, same recorded reason. */
function fixedShare(id: string, tick: number, before: number, opts: { share?: number; target?: string | null; reason?: string | null; sourceIds?: string[]; actor?: string } = {}): LearningEvent {
  const share = opts.share ?? 0.18;
  const troops = Math.floor(before * share);
  const reason = opts.reason === undefined ? LOAD_REASON : opts.reason;
  return ev({ id, kind: 'command', tick, actor: opts.actor, summary: `Expanded with ${troops} forces`, details: { commandId: `cmd-${id}`, origin: 'human', intent: { type: 'attack', targetID: opts.target ?? null, troops }, observedTick: tick - 1, before: { troops: before, tiles: 30 }, observation: { player: { troops: before } }, ...(reason ? { rationale: reason, rationaleTiming: 'contemporaneous', sourceIds: opts.sourceIds ?? [] } : {}) } });
}

/** N fixed-share orders every `step` ticks starting at `from`, force growing by 4% each time. */
function loadRun(from: number, n: number, step = 10, before0 = 10000, prefix = 'load'): LearningEvent[] {
  const out: LearningEvent[] = [];
  let before = before0;
  for (let i = 0; i < n; i++) { out.push(fixedShare(`${prefix}-${i}`, from + i * step, before)); before = Math.round(before * 1.04); }
  return out;
}

function withEvents(events: LearningEvent[], reports = [report(`${EX}-r1`, 0)]): ExerciseRecord {
  return { exercise: meta({ id: EX }), events: [ev({ id: 'started', kind: 'exercise_started', tick: 0, actor: 'facilitator', side: null }), ...events], reports };
}

const shared = (record: ExerciseRecord, cutoff = 5000) => selectKeyMoments({ record, scope: { kind: 'shared' }, cutoff: { tick: cutoff }, limit: 6 });
const orderMoments = (sel: KeyMomentSelection) => sel.candidates.filter(m => m.kind === 'order-tradeoff' || m.kind === 'order-effective' || m.kind === 'order-ineffective');

describe('selectKeyMoments · equivalent orders with varying force', () => {
  it('preserves a changed observation basis or reason timing instead of attributing the anchor evidence to both orders',()=>{
    const a=fixedShare('a',10,10000),b=fixedShare('b',20,10400),c=fixedShare('c',30,10800);
    delete b.details.observation;
    c.details.rationaleTiming='unknown';
    expect(orderMoments(shared(withEvents([a,b,c]))).map(m=>m.repeatCount)).toEqual([1,1,1]);
  });
  it('preserves a decision boundary when the same side records a new assessment',()=>{
    const a=fixedShare('a',10,10000),b=fixedShare('b',20,10400);
    const note=ev({id:'assessment',kind:'assessment_log',tick:15,actor:other.subject,side:'blue',details:{text:'New observation from the analyst'}});
    expect(orderMoments(shared(withEvents([a,note,b]))).map(m=>m.repeatCount)).toEqual([1,1]);
    expect(orderMoments(shared(withEvents([a,{...note,side:'red'},b]))).map(m=>m.repeatCount)).toEqual([2]);
  });
  const run = loadRun(10, 12); // ticks 10–120, troops 1800 → ~2769
  const sel = shared(withEvents(run));

  it('groups fixed-share orders whose troop counts drift into one moment and labels them equivalent, not identical', () => {
    expect(orderMoments(sel)).toHaveLength(1);
    const m = orderMoments(sel)[0];
    expect(m.id).toBe('km:order-tradeoff:load-0');
    expect(m.repeatCount).toBe(12);
    expect(m.repeatKind).toBe('equivalent');
    expect(m.repeatRange!.troops[0]).toBeLessThan(m.repeatRange!.troops[1]);
    expect(m.repeatRange!.ticks).toEqual([10, 120]);
    expect(m.repeatRange!.ratio![0]).toBeCloseTo(0.18, 2);
    const text = m.reasons.join(' ');
    expect(text).not.toContain('identical order');
    expect(text).toContain('12 equivalent orders');
    expect(text).toContain('Not identical inputs');
    expect(text).toContain('Committed 18% of forces');
  });

  it('retains every grouped order with its exact record ID and tick as evidence', () => {
    const m = orderMoments(sel)[0];
    expect(m.evidence.map(e => e.id)).toEqual(run.map(r => r.id));
    expect(m.evidence.map(e => e.tick)).toEqual(run.map(r => r.tick));
    expect(m.evidence.every(e => e.basis === 'recorded-order')).toBe(true);
    expect(sel.excluded.some(x => x.id.startsWith('load-'))).toBe(false);
  });

  it('starts a new group when the declared window is exceeded and down-weights it as a repeat run', () => {
    const long = shared(withEvents(loadRun(10, 40, 20))); // ticks 10–790, one every 20 ticks
    const groups = orderMoments(long);
    expect(groups.length).toBeGreaterThan(1);
    for (const g of groups) expect(g.repeatRange!.ticks[1] - g.repeatRange!.ticks[0]).toBeLessThanOrEqual(KEY_MOMENT_GROUPING.windowTicks);
    expect(groups.reduce((n, g) => n + g.repeatCount, 0)).toBe(40);
    expect(groups[0].reasons.some(r => r.includes('earlier run'))).toBe(false);
    expect(groups[1].reasons.some(r => r.includes('1 earlier run'))).toBe(true);
    expect(groups[1].weight).toBe(groups[0].weight - 2);
    // Only one group per window stretch; the greedy pick still spreads the selection across time.
    const ticks = long.selected.map(m => m.tick);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });

  it('keeps a bounded candidate list on a long session of the same act', () => {
    const long = shared(withEvents(loadRun(10, 600, 10)), 7000); // 600 orders across ~6000 ticks
    const groups = orderMoments(long);
    expect(groups.length).toBeLessThanOrEqual(Math.ceil(6000 / KEY_MOMENT_GROUPING.windowTicks) + 1);
    expect(groups.reduce((n, g) => n + g.repeatCount, 0)).toBe(600);
    expect(long.selected).toHaveLength(6);
  });
});

describe('selectKeyMoments · material changes are never merged', () => {
  it('separates a significant change in commitment share, a changed target and a crossing of the tradeoff threshold', () => {
    const events = [
      ...loadRun(10, 3),
      fixedShare('big', 40, 11249, { share: 0.4 }),
      fixedShare('big-2', 50, 11700, { share: 0.4 }),
      fixedShare('vs-red', 60, 12000, { share: 0.4, target: 'red' }),
      fixedShare('under', 70, 12000, { share: 0.48 }),
      fixedShare('over', 80, 12000, { share: 0.52 }),
    ];
    const sel = shared(withEvents(events));
    expect(ids(orderMoments(sel))).toEqual(['km:order-tradeoff:load-0', 'km:order-tradeoff:big', 'km:order-tradeoff:vs-red', 'km:order-tradeoff:under', 'km:order-tradeoff:over']);
    const big = sel.candidates.find(m => m.id === 'km:order-tradeoff:big')!;
    expect(big.repeatCount).toBe(2);
    expect(big.repeatKind).toBe('equivalent');
    expect(big.reasons.some(r => r.includes('earlier run'))).toBe(false); // a different share is not a repeat of the 18% run
  });

  it('separates orders whose recorded reason or cited sources changed, even at the same share', () => {
    const reports = [report(`${EX}-r1`, 0), report(`${EX}-r2`, 0)];
    const events = [
      fixedShare('a-0', 10, 10000, { sourceIds: [reports[0].id] }),
      fixedShare('a-1', 20, 10400, { sourceIds: [reports[0].id] }),
      fixedShare('b-0', 30, 10800, { sourceIds: [reports[1].id] }),
      fixedShare('c-0', 40, 11200, { reason: 'Shift weight north while the estimate is fresh.', sourceIds: [reports[1].id] }),
      fixedShare('d-0', 50, 11600, { reason: null }),
      fixedShare('d-1', 60, 12000, { reason: null }),
    ];
    const sel = shared(withEvents(events, reports));
    expect(ids(orderMoments(sel))).toEqual(['km:order-tradeoff:a-0', 'km:order-tradeoff:b-0', 'km:order-tradeoff:c-0']);
    expect(sel.candidates.find(m => m.id === 'km:order-tradeoff:a-0')!.evidence.map(e => e.id)).toEqual(['a-0', 'a-1']);
    // An 18% order with no reason and no measured effect is not a moment at all; it is neither merged nor surfaced.
    expect(sel.excluded.filter(x => x.reason === 'not-a-moment').map(x => x.id)).toEqual(['d-0', 'd-1']);
  });

  it('separates orders on either side of a report release, an objective control change, a rejection or an engine observation', () => {
    const reports = [report(`${EX}-r1`, 0), report(`${EX}-r2`, 25, `${EX}-r1`)];
    const events = [
      objective('obj-0', 0, STATIONS),
      fixedShare('p-0', 10, 10000), fixedShare('p-1', 20, 10400),
      ev({ id: 'rel-2', kind: 'report', tick: 25, actor: 'exercise-reporter', details: { reportId: reports[1].id, supersedes: reports[0].id } }),
      fixedShare('q-0', 30, 10800), fixedShare('q-1', 40, 11200),
      objective('obj-1', 45, { ...STATIONS, aster: 'blue' }),
      fixedShare('r-0', 50, 11600), fixedShare('r-1', 60, 12000),
      objective('obj-2', 65, { ...STATIONS, aster: 'blue' }, { blue: 1, red: 0 }, { blue: { stations: 1, priority: 0, reserve: 0, total: 1 }, red: { stations: 0, priority: 0, reserve: 0, total: 0 } }),
      fixedShare('r-2', 70, 12400), // an award without a controller change is not a context boundary
      ev({ id: 'rej-1', kind: 'command_rejected', tick: 75, summary: 'Order could not execute', details: { commandId: 'cmd-rej', reason: 'Not enough troops' } }),
      fixedShare('s-0', 80, 12800), fixedShare('s-1', 90, 13200),
      boatOrder('boat', 95, { tile: 5100 }),
      feedback('fb-boat', 100, 'boat', 'transport-landed', { targetOwnerBefore: null, targetOwnerAfter: 'blue' }),
      fixedShare('t-0', 110, 13600), fixedShare('t-1', 120, 14000),
    ];
    const sel = shared(withEvents(events, reports));
    const groups = orderMoments(sel).filter(m => m.kind === 'order-tradeoff');
    expect(groups.map(m => [m.id, m.repeatCount])).toEqual([
      ['km:order-tradeoff:p-0', 2], ['km:order-tradeoff:q-0', 2], ['km:order-tradeoff:r-0', 3], ['km:order-tradeoff:s-0', 2], ['km:order-tradeoff:t-0', 2],
    ]);
    // The boat with its landed observation stays its own moment with its own measured evidence.
    const landed = sel.candidates.find(m => m.id === 'km:order-effective:boat')!;
    expect(landed.repeatCount).toBe(1);
    expect(landed.evidence.map(e => e.id)).toEqual(['boat', 'fb-boat']);
    // The follow-on after the rejection is the first order after it, inside a group, and is still reported separately.
    expect(sel.candidates.find(m => m.kind === 'follow-on-after-ineffective')!.evidence[0].id).toBe('s-0');
  });

  it('never merges an order that carries a measured outcome with a merely similar one', () => {
    const events = [
      boatOrder('b-0', 10, { troops: 150 }), boatOrder('b-1', 20, { troops: 150 }),
      feedback('fb-0', 25, 'b-0', 'transport-not-launched', { orderedTroops: 150 }),
      boatOrder('b-2', 30, { troops: 160 }), feedback('fb-2', 35, 'b-2', 'transport-not-launched', { orderedTroops: 160 }),
      boatOrder('b-3', 40, { troops: 160 }), feedback('fb-3', 45, 'b-3', 'transport-not-launched', { orderedTroops: 160 }),
    ];
    const sel = shared(withEvents(events));
    const ineffective = sel.candidates.filter(m => m.kind === 'order-ineffective');
    // b-0 (observed) and b-1 (no observation) differ in outcome; b-2 and b-3 are identical inputs but an observation lies between them.
    expect(ineffective.map(m => [m.id, m.repeatCount, m.repeatKind])).toEqual([['km:order-ineffective:b-0', 1, 'none'], ['km:order-ineffective:b-2', 1, 'none'], ['km:order-ineffective:b-3', 1, 'none']]);
    for (const m of ineffective) expect(m.evidence.filter(e => e.basis === 'engine-observation')).toHaveLength(1);
    expect(sel.excluded.find(x => x.id === 'b-1')?.reason).toBe('not-a-moment');
  });

  it('ignores post-hoc annotations when deciding whether two orders share a reason and never cites them', () => {
    const reports = [report(`${EX}-r1`, 0)];
    const events = [
      fixedShare('h-0', 10, 10000), fixedShare('h-1', 20, 10400),
      ev({ id: 'log-post', kind: 'decision_log', tick: 900, summary: 'Later note', details: { commandId: 'cmd-h-1', text: 'In hindsight this was too cautious.', timing: 'post-hoc', sourceIds: [reports[0].id] } }),
    ];
    const sel = shared(withEvents(events, reports));
    const m = orderMoments(sel)[0];
    expect(orderMoments(sel)).toHaveLength(1);
    expect(m.repeatCount).toBe(2);
    expect(JSON.stringify(m)).not.toContain('log-post');
    expect(m.reasons.join(' ')).not.toContain(`${EX}-r1`);
    expect(m.reasons.some(r => r.includes('contemporaneous written reason'))).toBe(true);
  });
});

describe('selectKeyMoments · grouping respects cutoff, privacy, branch context and source stability', () => {
  it('groups only orders at or before the cutoff and excludes the rest', () => {
    const sel = selectKeyMoments({ record: withEvents(loadRun(10, 12)), scope: { kind: 'shared' }, cutoff: { tick: 55 }, limit: 6 });
    const m = orderMoments(sel)[0];
    expect(m.repeatCount).toBe(5);
    expect(m.evidence.map(e => e.tick)).toEqual([10, 20, 30, 40, 50]);
    expect(sel.excluded.filter(x => x.reason === 'after-cutoff')).toHaveLength(7);
  });

  it('never folds another participant\'s orders into the subject\'s group in either scope', () => {
    const events = [
      fixedShare('me-0', 10, 10000), fixedShare('me-1', 20, 10400),
      fixedShare('you-0', 25, 10400, { actor: other.subject }),
      fixedShare('me-2', 30, 10800), fixedShare('me-3', 40, 11200),
    ];
    const own = selectKeyMoments({ record: withEvents(events), scope: { kind: 'own', subject: learner.subject }, cutoff: { tick: 5000 } });
    expect(orderMoments(own).map(m => [m.id, m.repeatCount])).toEqual([['km:order-tradeoff:me-0', 4]]);
    expect(JSON.stringify(own.candidates)).not.toContain('you-0');
    expect(own.excluded.find(x => x.id === 'you-0')?.reason).toBe('other-participant');
    const team = shared(withEvents(events));
    for (const m of orderMoments(team)) expect(new Set(m.evidence.map(e => e.id.split('-')[0])).size).toBe(1);
    expect(orderMoments(team).map(m => m.actor)).toEqual([learner.subject, other.subject, learner.subject]);
  });

  it('does not let opponent-side or inherited records join or split a group', () => {
    const events = [
      ev({ id: 'inh-1', kind: 'inherited_event', tick: 5, summary: 'Inherited', details: { originalKind: 'command', parentId: 'parent', originalDetails: { origin: 'human', intent: { type: 'attack', targetID: null, troops: 1800 } } } }),
      objective('obj-inh', 5, { ...STATIONS, aster: 'red' }, { blue: 0, red: 0 }, null, true),
      fixedShare('k-0', 10, 10000),
      ev({ id: 'red-cmd', kind: 'command', tick: 15, actor: 'luna-red', side: 'red', summary: 'Red expanded', details: { commandId: 'cmd-red', origin: 'agent', intent: { type: 'attack', targetID: null, troops: 300 } } }),
      ev({ id: 'red-rej', kind: 'command_rejected', tick: 16, actor: 'luna-red', side: 'red', summary: 'Order could not execute', details: { commandId: 'cmd-red-2', reason: 'Not enough troops' } }),
      ev({ id: 'red-rel', kind: 'report', tick: 17, actor: 'exercise-reporter', side: 'red', details: { reportId: 'red-r1' } }),
      fixedShare('k-1', 20, 10400),
      objective('obj-first', 25, { ...STATIONS, aster: 'red' }),
      fixedShare('k-2', 30, 10800),
    ];
    const sel = selectKeyMoments({ record: withEvents(events), scope: { kind: 'shared' }, cutoff: { tick: 5000 }, bothSidesVisible: true });
    expect(orderMoments(sel).map(m => [m.id, m.repeatCount])).toEqual([['km:order-tradeoff:k-0', 3]]);
    expect(JSON.stringify(sel.candidates)).not.toContain('red-');
    expect(JSON.stringify(sel.candidates)).not.toContain('inh-1');
    // The first post-fork objective record matching the inherited state is not a control change.
    expect(sel.candidates.some(m => m.kind === 'objective-control-changed')).toBe(false);
  });

  it('is deterministic under input reordering, stable when later orders are appended, and does not mutate inputs', () => {
    const rec = withEvents([...loadRun(10, 12), fixedShare('late', 500, 20000, { share: 0.4 })]);
    const snapshot = JSON.stringify(rec);
    const a = shared(rec);
    const reversed = { ...rec, events: [...rec.events].reverse() };
    const b = shared(reversed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(rec)).toBe(snapshot);
    const grown = shared(withEvents([...rec.events.slice(1), ...loadRun(800, 3, 10, 30000, 'more')]));
    for (const id of ids(a.candidates)) expect(ids(grown.candidates)).toContain(id);
    for (const id of ids(a.candidates)) expect(grown.candidates.find(m => m.id === id)!.evidence).toEqual(a.candidates.find(m => m.id === id)!.evidence);
  });

  it('uses no causal or evaluative vocabulary in grouped reasons or the declared limitation', () => {
    const sel = shared(withEvents(loadRun(10, 40, 20)));
    const text = [...sel.candidates.flatMap(m => [m.title, ...m.reasons]), ...sel.limitations].join(' ').toLowerCase();
    for (const banned of ['because', 'caused', 'led to', 'blunder', 'mistake', 'good decision', 'bad decision', 'should have', 'identical orders grouped']) expect(text).not.toContain(banned);
    expect(sel.limitations.some(l => l.includes(`${KEY_MOMENT_GROUPING.windowTicks} ticks`))).toBe(true);
  });
});
