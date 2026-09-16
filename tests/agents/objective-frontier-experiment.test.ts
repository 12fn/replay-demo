/** Public generated engine fixtures; historical recorded-state parity is in tests/private-fixtures. */
import { describe, expect, test } from 'vitest';
import { ReplayEngine, type Side } from '../../src/engine/engine';
import { FRONTIER_FIRST_CONTROLLER, FRONTIER_FIRST_TICKS_PER_CHECK, OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS, OBJECTIVE_RULES, frontierFirstAssess, objectiveAssess } from '../../src/agents/objective-controller';
import { createNetworkLayout, initialNetwork, networkView, type NetworkState } from '../../src/campaign/network';
import { BLUE_STYLES, determinism, initialDeployment, runGame } from '../../scripts/qualify-frontier-experiment';

console.debug = () => {}; console.warn = () => {};

async function generatedCheckpoint() {
  const start = await initialDeployment('PUBTEST1');
  return {record: start.record, network: initialNetwork(start.tick)};
}
async function restore(cp: Awaited<ReturnType<typeof generatedCheckpoint>>, verification: 'checkpoints' | 'every-tick' = 'checkpoints') {
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, verification);
  const view = networkView(e, createNetworkLayout(e), cp.network as NetworkState);
  return { e, view };
}
describe('version distinction and assessment purity', () => {
  test('separate names; the experiment policy refuses the native 45-tick cadence and any interval but 270', async () => {
    expect(FRONTIER_FIRST_CONTROLLER).not.toBe(OBJECTIVE_CONTROLLER);
    const cp = await generatedCheckpoint(); const { e, view } = await restore(cp);
    for (const n of [OBJECTIVE_INTERVAL_TICKS, 90, 540]) expect(() => frontierFirstAssess(e, 'red', view, n)).toThrow(/only for 270-tick checks/);
    // The v1 assessment serializes with no frontier-first field.
    expect(Object.keys(objectiveAssess(e, 'red', view)).sort()).toEqual(['category', 'controller', 'intent', 'objectiveId', 'observed', 'reason', 'side', 'source', 'tick']);
    // Board contract is shared: a stale board throws for both.
    const stale = { ...view, tick: view.tick - 1 };
    expect(() => objectiveAssess(e, 'red', stale)).toThrow(/stale/); expect(() => frontierFirstAssess(e, 'red', stale, 270)).toThrow(/stale/);
  }, 60_000);

  test('assessment mutates neither the engine, its record, the board nor the generated checkpoint, and repeats exactly', async () => {
    const cp = await generatedCheckpoint(); const frozen = JSON.stringify(cp);
    const { e, view } = await restore(cp);
    const before = { fingerprint: e.state().fingerprint, record: JSON.stringify(e.record()), view: JSON.stringify(view), ticks: e.game.ticks(), troops: (['blue', 'red'] as Side[]).map((s) => e.player(s).troops()) };
    const a = frontierFirstAssess(e, 'red', view, 270), b = frontierFirstAssess(e, 'red', view, 270); objectiveAssess(e, 'red', view);
    expect(b).toEqual(a);
    expect({ fingerprint: e.state().fingerprint, record: JSON.stringify(e.record()), view: JSON.stringify(view), ticks: e.game.ticks(), troops: (['blue', 'red'] as Side[]).map((s) => e.player(s).troops()) }).toEqual(before);
    expect(JSON.stringify(cp)).toBe(frozen);
  }, 60_000);

  test('the same generated record restored twice, with different verification, gives identical assessments for both versions', async () => {
    const cp = await generatedCheckpoint();
    const x = await restore(cp, 'checkpoints'), y = await restore(cp, 'every-tick');
    expect(y.e.state().fingerprint).toBe(x.e.state().fingerprint);
    expect(frontierFirstAssess(y.e, 'red', y.view, 270)).toEqual(frontierFirstAssess(x.e, 'red', x.view, 270));
    expect(objectiveAssess(y.e, 'red', y.view)).toEqual(objectiveAssess(x.e, 'red', x.view));
  }, 120_000);
});

describe('experiment loop', () => {
  test('a short frontier-first game is byte-deterministic and its record restores to the same fingerprint; Blue orders stay legal', async () => {
    const d = await determinism('PAIR0001', 'aggressive', FRONTIER_FIRST_CONTROLLER, 855);
    expect(d).toMatchObject({ sameRecord: true, sameRedChecks: true, restoredFingerprintMatched: true });
    const r = await runGame({ seed: 'PAIR0001', blue: 'aggressive', policy: FRONTIER_FIRST_CONTROLLER, capTicks: 855 });
    // Like the trial harness, Red also checks at the final tick; that order cannot execute inside the run.
    expect(r.redChecks.map((c) => c.tick)).toEqual([45, 315, 585, 855]);
    expect(r.redChecks.at(-1)!.executedAtTick).toBeNull();
    expect(r.redChecks.every((c) => c.source === FRONTIER_FIRST_CONTROLLER || c.source === 'maneuver/1' || c.source === 'none')).toBe(true);
    expect(r.redChecks.find((c) => c.tick === 315)).toMatchObject({ category: 'expansion', displaced: { category: 'transport' }, precedenceDeclined: null });
    // Precedence only promotes objectives/1's own station-directed land push. Here it declined, so the elective post keeps the check with land still open, and the audit says why.
    const kept = r.redChecks.find((c) => c.tick === 855)!;
    expect(kept).toMatchObject({ category: 'construction', source: 'maneuver/1', displaced: null });
    expect(kept.neutralBorder).toBeGreaterThan(0); expect(kept.precedenceDeclined).toEqual(expect.any(String));
    expect(r.blueDecisions.map((b) => b.label)).toEqual(['opening expansion', 'opening expansion', expect.stringMatching(/^station boat|attack red|expansion$/)]);
    expect(r.blueSummary.droppedAtTick + r.redSummary.droppedAtTick + r.redSummary.refusedAtSubmission).toBe(0);
    expect(Object.keys(BLUE_STYLES)).toEqual(['hold', 'first-troop-even', 'aggressive', 'cautious']);
  }, 300_000);
});
