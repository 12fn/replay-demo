import {afterEach, describe, expect, it, vi} from 'vitest';
import {applyProvenance, interpretWatch, isWatchRequest, materialEvent, newWatch, type WatchTask} from '../../src/agents/staff';
import type {AgentContext, SideReport} from '../../src/agents/tools';
import {initialNetwork, networkView, type Station} from '../../src/campaign/network';
import {navalEngine, T} from '../naval-fixture';

console.debug = () => {};
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const engine = await navalEngine();
  const reports: (SideReport & {side?: 'blue' | 'red'})[] = [{id: 'blue-initial', side: 'blue', tick: 1, title: 'Initial source'}];
  const layout: Station[] = [
    {id: 'aster', name: 'Aster', tile: T(5, 3), tiles: [T(5, 3), T(6, 3), T(7, 3)]},
    {id: 'beacon', name: 'Beacon', tile: T(5, 12), tiles: [T(5, 12)]},
  ];
  const ctx: AgentContext = {exerciseId: 'watch-fixture', side: 'blue', engine, reports: () => reports, events: () => [], objectives: () => networkView(engine, layout, initialNetwork(engine.game.ticks()))};
  const watch = (objective: string) => newWatch({id: 'watch', owner: 'learner', side: 'blue', objective, tick: engine.game.ticks(), ctx});
  const forces = (amount: number, side: 'blue' | 'red' = 'blue') => {const player = engine.player(side); player.removeTroops(player.troops()); player.addTroops(amount);};
  const apply = (task: WatchTask) => {const event = materialEvent(task, ctx); expect(event).not.toBeNull(); return applyProvenance(task, event!, ctx);};
  return {engine, reports, layout, ctx, watch, forces, apply};
}

describe('versioned watch interpretation', () => {
  it('records immutable fast cadence only for newly created reserve/control watches', async () => {
    const f = await fixture();
    for (const title of ['Watch reserves', 'Watch objective changes', 'Watch Aster control']) {
      const task = f.watch(title);
      expect(task.watchConfig?.evaluationEveryTicks).toBe(1);
      expect(task.interpretation).toContain('after every committed simulation tick');
      expect(task.interpretation).not.toContain('every 100 simulation ticks');
    }
    for (const title of ['Monitor report provenance', 'Watch supersession']) {
      const task = f.watch(title);
      expect(task.watchConfig?.evaluationEveryTicks).toBe(100);
      expect(task.interpretation).toContain('every 100 simulation ticks and on report release');
    }
    f.forces(100);
    const old = f.watch('Watch reserves below 50');
    delete old.watchConfig!.evaluationEveryTicks;
    old.interpretation = 'Checked every 100 simulation ticks and on report release; changes between checks may be missed.';
    const config = structuredClone(old.watchConfig), interpretation = old.interpretation;
    f.forces(1); f.apply(old);
    expect(old.watchConfig).toEqual(config);
    expect(old.watchConfig).not.toHaveProperty('evaluationEveryTicks');
    expect(old.interpretation).toBe(interpretation);
  });

  it('discloses the default and preserves explicit force and capacity thresholds', async () => {
    const f = await fixture();
    expect(f.watch('Watch reserves')).toMatchObject({watchConfig: {schema: 'replay.watch-config/1', kind: 'reserve', threshold: {unit: 'capacity-fraction', value: .3}, defaultThreshold: true}, interpretation: expect.stringContaining('Default threshold: 30%'), lastResult: null, modelEnabled: false});
    expect(f.watch('Watch available forces below 1,000').watchConfig).toMatchObject({kind: 'reserve', threshold: {unit: 'forces', value: 1000}, defaultThreshold: false});
    expect(f.watch('Alert me when my reserves fall below 25 percent of force capacity').watchConfig).toMatchObject({kind: 'reserve', threshold: {unit: 'capacity-fraction', value: .25}, defaultThreshold: false});
    expect(f.watch('Monitor reserves under 12.5%').watchConfig).toMatchObject({threshold: {value: .125}});
    expect(isWatchRequest('Notify me if Aster becomes vulnerable')).toBe(true);
    expect(() => f.watch('Notify me if Aster becomes vulnerable')).toThrow(/unsupported or ambiguous/);
  });

  it.each(['Watch everything', 'Watch enemy reserves below 30%', 'Watch reserves above 30%', 'Watch reserves below 0%', 'Watch reserves below 101%', 'Watch reserves below 1,00', 'Watch reserves below 1.5 forces', 'Watch reserves below 30% and report changes', 'Monitor report provenance and recommend attacks', 'Predict Aster control', 'Watch arbitrary control', 'Watch reserves for the next ten ticks'])('rejects unsupported/ambiguous wording: %s', async text => {
    const f = await fixture();
    expect(() => f.watch(text)).toThrow(/Try:.*Watch reserves below 30%/);
  });

  it('requires a current objective board and resolves exactly one existing station', async () => {
    const f = await fixture();
    expect(f.watch('Watch objective changes').watchConfig).toEqual({schema: 'replay.watch-config/1', evaluationEveryTicks: 1, kind: 'objective-control', stationIds: null, includePriority: true});
    expect(f.watch('Watch Aster control').watchConfig).toMatchObject({stationIds: ['aster'], includePriority: false});
    expect(f.watch('Monitor control at Beacon').watchConfig).toMatchObject({stationIds: ['beacon']});
    expect(() => f.watch('Watch Atlantis control')).toThrow(/Name one station/);
    const board = f.ctx.objectives!()!;
    f.ctx.objectives = () => ({...board, tick: board.tick + 1});
    expect(() => f.watch('Watch objectives')).toThrow(/no current objective board/);
    f.ctx.objectives = () => null;
    expect(() => f.watch('Watch objectives')).toThrow(/use a reserve or report watch/);
  });
});

describe('objective-specific material changes', () => {
  it('alerts only on own available-force threshold crossings, including equality recovery, with no full-state/report scans', async () => {
    const f = await fixture(); f.forces(100);
    const task = f.watch('Watch available forces below 50');
    const state = vi.spyOn(f.engine, 'state');
    const reports = vi.spyOn(f.ctx, 'reports');
    const board = vi.spyOn(f.ctx, 'objectives');
    f.forces(5000, 'red');
    f.reports.push({id: 'new', tick: f.engine.game.ticks(), title: 'Unrelated report'});
    f.forces(50);
    expect(materialEvent(task, f.ctx)).toBeNull();
    f.forces(49);
    const input = structuredClone(task), engineState = f.engine.record();
    const event = materialEvent(task, f.ctx)!;
    expect(event.watch?.state).toMatchObject({available: 49, below: true});
    expect(task).toEqual(input); // Evaluation is pure; only applying the event advances the durable baseline.
    const result = applyProvenance(task, event, f.ctx);
    expect(result).toMatchObject({text: expect.stringContaining('below 50 forces'), sourceIds: []});
    expect(f.engine.record()).toEqual(engineState);
    expect(materialEvent(task, f.ctx)).toBeNull();
    f.forces(40); expect(materialEvent(task, f.ctx)).toBeNull();
    f.forces(50); expect(f.apply(task).text).toContain('at or above 50 forces');
    expect(state).not.toHaveBeenCalled(); expect(reports).not.toHaveBeenCalled(); expect(board).not.toHaveBeenCalled();
  });

  it('measures percentage against current own capacity and starts below-threshold watches quietly', async () => {
    const f = await fixture(), player = f.engine.player('blue');
    const capacity = f.engine.game.config().maxTroops(player);
    f.forces(1);
    const task = f.watch('Watch reserves below 30%');
    expect(task.watchState).toMatchObject({below: true, capacity});
    expect(materialEvent(task, f.ctx)).toBeNull();
    f.forces(Math.ceil(capacity * .3));
    expect(f.apply(task).text).toContain('at or above 30% of current capacity');
  });

  it('compares real station controllers, ignoring partial tile movement, reserves and unrelated stations', async () => {
    const f = await fixture();
    const all = f.watch('Watch objective changes'), aster = f.watch('Watch Aster control');
    f.forces(5); f.engine.player('red').conquer(f.layout[0].tiles[0]);
    expect(materialEvent(all, f.ctx)).toBeNull(); // Blue still holds 2/3, above the actual control threshold.
    f.engine.player('red').conquer(f.layout[0].tiles[1]);
    expect(f.apply(all).text).toContain('aster: blue → red');
    expect(f.apply(aster).text).toContain('aster: blue → red');
    expect(materialEvent(all, f.ctx)).toBeNull();
    f.engine.player('blue').conquer(f.layout[1].tile);
    expect(materialEvent(aster, f.ctx)).toBeNull();
    expect(f.apply(all).text).toContain('beacon: red → blue');
  });

  it('reports actual scheduled priority changes only for the all-objectives watch', async () => {
    const f = await fixture();
    const all = f.watch('Watch objectives'), one = f.watch('Watch Aster control');
    while (f.engine.game.ticks() < 1801) f.engine.step();
    expect(f.ctx.objectives!()!.priorityId).toBe('beacon');
    expect(f.apply(all).text).toContain('priority: aster → beacon');
    expect(materialEvent(one, f.ctx)).toBeNull();
  });

  it('reports own released sources and explicit supersession without inventing estimates or citing future/opponent records', async () => {
    const f = await fixture();
    const all = f.watch('Monitor report provenance'), supersession = f.watch('Watch supersession');
    f.reports.push({id: 'red-private', side: 'red', tick: 1, title: 'Private opposing source'}, {id: 'future', side: 'blue', tick: 999, title: 'Future source'});
    expect(materialEvent(all, f.ctx)).toBeNull();
    f.reports.push({id: 'new', side: 'blue', tick: f.engine.game.ticks(), title: 'New own source', supersedes: 'red-private'});
    expect(materialEvent(supersession, f.ctx)).toBeNull();
    expect(f.apply(all)).toEqual({text: `New own source (tick ${f.engine.game.ticks()}) released. Sources describe their own observation ticks.`, sourceIds: ['new']});
    f.reports.push({id: 'replacement', side: 'blue', tick: f.engine.game.ticks(), title: 'Revised estimate', supersedes: 'blue-initial'});
    const result = f.apply(supersession);
    expect(result.sourceIds).toEqual(['replacement', 'blue-initial']);
    expect(result.text).toContain('supersedes Initial source (tick 1)');
    expect(result.text).not.toContain('0 →');
    expect(result.text).not.toContain('Private');
    expect(materialEvent(supersession, f.ctx)).toBeNull();
  });

  it('does not evaluate a future baseline, another side or a cancelled watch, and rejects stale event application', async () => {
    const f = await fixture(); f.forces(100);
    const task = f.watch('Watch reserves below 50 forces'); f.forces(1);
    const event = materialEvent(task, f.ctx)!;
    expect(materialEvent(task, {...f.ctx, side: 'red'})).toBeNull();
    expect(materialEvent({...task, createdTick: 100}, f.ctx)).toBeNull();
    expect(materialEvent({...task, status: 'cancelled'}, f.ctx)).toBeNull();
    f.engine.step();
    expect(() => applyProvenance(task, event, f.ctx)).toThrow(/observation tick/);
  });

  it('never reinterprets a legacy title or silently treats an unknown config version as legacy', async () => {
    const f = await fixture(); f.forces(100);
    const configured = f.watch('Watch reserves below 50');
    const {watchConfig: _config, interpretation: _text, watchState: _state, ...legacy} = configured;
    legacy.seenReportIds = ['blue-initial']; // Legacy creation already accounted for existing reports.
    f.forces(1);
    expect(materialEvent(legacy, f.ctx)).toBeNull();
    f.reports.push({id: 'new-source', tick: f.engine.game.ticks(), title: 'Legacy source update'});
    expect(materialEvent(legacy, f.ctx)?.newReports.map(r => r.id)).toContain('new-source');
    expect(legacy).not.toHaveProperty('watchConfig');
    const unknown = {...configured, watchConfig: {...configured.watchConfig!, schema: 'replay.watch-config/99'}} as unknown as WatchTask;
    expect(materialEvent(unknown, f.ctx)).toBeNull();
    expect(interpretWatch('Watch supersession', f.ctx).watchConfig).toMatchObject({mode: 'supersessions'});
  });
});
