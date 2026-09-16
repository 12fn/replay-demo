import {privateFixtureRoot} from './root';
/**
 * `objectives/frontier-first/1` against `objectives/1` on saved Red decision states from the immutable full-game trials
 * (read-only). Locks the original policy to the recorded receipts, checks the one precedence change selects a legal
 * expansion within the unchanged reserve and frontier limits, keeps the versions distinct, never mutates the world during
 * assessment and gives the same answer after restoring the same record. Nothing in this file writes evidence.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ReplayEngine, type Side } from '../../src/engine/engine';
import { FRONTIER_FIRST_CONTROLLER, FRONTIER_FIRST_TICKS_PER_CHECK, OBJECTIVE_CONTROLLER, OBJECTIVE_INTERVAL_TICKS, OBJECTIVE_RULES, frontierFirstAssess, objectiveAssess } from '../../src/agents/objective-controller';
import { createNetworkLayout, networkView, type NetworkState } from '../../src/campaign/network';
import type { Checkpoint } from '../../scripts/ai-player-trial';
const ROOT = privateFixtureRoot;
import { BLUE_STYLES, determinism, harnessParity, runGame } from '../../scripts/qualify-frontier-experiment';

console.debug = () => {}; console.warn = () => {};

const SOL = path.join(ROOT, 'evidence/ai-player-trial/fullgame-sol-guarded-20260915');
const OPUS = path.join(ROOT, 'evidence/ai-player-trial/fullgame-opus-guarded-20260915');
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
type Pulse = { tick: number; category: string; intentType: string | null; reason: string };
/** Red's decision at `tick` as saved: the checkpoint (pending Red order included) and the receipt pulse with its reason. */
function saved(dir: string, decision: number) {
  const d = String(decision).padStart(2, '0'), prev = String(decision - 1).padStart(2, '0');
  const cp = readJson<Checkpoint>(path.join(dir, `decisions/${d}/replay.json`));
  const pulse = readJson<{ opponent: { pulses: Pulse[] } }>(path.join(dir, `outcomes/${prev}/receipts.json`)).opponent.pulses.find((p) => p.tick === cp.tick)!;
  const order = cp.pending.find((o) => o.side === 'red')!;
  return { cp, pulse, order };
}
async function restore(cp: Checkpoint, verification: 'checkpoints' | 'every-tick' = 'checkpoints') {
  const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, verification);
  const view = networkView(e, createNetworkLayout(e), cp.network as NetworkState);
  return { e, view };
}
/** Sol trial decisions 01, 03, 04: Red checks at 315 (Ember boat), 855 and 1125 (maneuver/1 contact-line Defense Posts). */
const OPENING = [{ decision: 1, tick: 315, category: 'transport' }, { decision: 3, tick: 855, category: 'construction' }, { decision: 4, tick: 1125, category: 'construction' }] as const;

describe(`${OBJECTIVE_CONTROLLER} is unchanged on saved Red states`, () => {
  for (const s of OPENING) test(`tick ${s.tick}: reproduces the recorded receipt and order exactly`, async () => {
    const { cp, pulse, order } = saved(SOL, s.decision);
    expect(cp.tick).toBe(s.tick); expect(pulse.category).toBe(s.category);
    const { e, view } = await restore(cp);
    expect(e.state().fingerprint).toBe(cp.record.fingerprints[s.tick]);
    const a = objectiveAssess(e, 'red', view);
    expect({ category: a.category, intentType: a.intent?.type ?? null, reason: a.reason }).toEqual({ category: pulse.category, intentType: pulse.intentType, reason: pulse.reason });
    expect(a.intent).toEqual(order.intent);
    expect(a.controller).toBe(OBJECTIVE_CONTROLLER); expect('displaced' in a).toBe(false);
    expect(a.source).toBe(s.category === 'construction' ? 'maneuver/1' : OBJECTIVE_CONTROLLER);
  }, 60_000);
});

describe(`${FRONTIER_FIRST_CONTROLLER}: the one precedence change`, () => {
  for (const s of OPENING) test(`tick ${s.tick}: an admitted expansion within the reserve and frontier limits replaces the recorded ${s.category}`, async () => {
    const { cp, order } = saved(SOL, s.decision);
    const { e, view } = await restore(cp);
    const v1 = objectiveAssess(e, 'red', view);
    const ff = frontierFirstAssess(e, 'red', view, FRONTIER_FIRST_TICKS_PER_CHECK);
    const o = ff.observed;
    expect(o.neutralBorder).toBeGreaterThan(0);
    expect(ff).toMatchObject({ controller: FRONTIER_FIRST_CONTROLLER, source: FRONTIER_FIRST_CONTROLLER, category: 'expansion', intent: { type: 'attack', targetID: null } });
    expect(() => e.validate('red', ff.intent!)).not.toThrow();
    // Same limits as objectives/1 would apply to this push: band share, reserve guard, per-border-tile frontier room.
    const troops = Number(ff.intent!.troops);
    expect(troops).toBeGreaterThanOrEqual(OBJECTIVE_RULES.minTroops);
    expect(troops).toBeLessThanOrEqual(o.spendableTroops);
    expect(troops).toBeLessThanOrEqual(o.neutralBorder * OBJECTIVE_RULES.expansionTroopsPerBorderTile - o.committedNeutralTroops);
    expect(ff.displaced).toEqual({ category: v1.category, intent: order.intent, source: v1.source, objectiveId: v1.objectiveId, reason: v1.reason });
    expect(ff.reason).toContain(`frontier-first precedence over ${s.category}`);
    // Observation is the same scan; only the order differs.
    expect(ff.observed).toEqual(v1.observed);
  }, 60_000);

  test('where no precedence applies (threatened Red station, Opus trial 4905) both versions give the same order', async () => {
    const { cp, pulse, order } = saved(OPUS, 18);
    expect(cp.tick).toBe(4905);
    const { e, view } = await restore(cp);
    const v1 = objectiveAssess(e, 'red', view), ff = frontierFirstAssess(e, 'red', view, FRONTIER_FIRST_TICKS_PER_CHECK);
    expect(v1.reason).toBe(pulse.reason); expect(v1.intent).toEqual(order.intent);
    expect({ ...ff, controller: v1.controller, source: v1.source }).toEqual(v1);
    expect('displaced' in ff).toBe(false);
  }, 120_000);
});

describe('version distinction and assessment purity', () => {
  test('separate names; the experiment policy refuses the native 45-tick cadence and any interval but 270', async () => {
    expect(FRONTIER_FIRST_CONTROLLER).not.toBe(OBJECTIVE_CONTROLLER);
    const { cp } = saved(SOL, 1); const { e, view } = await restore(cp);
    for (const n of [OBJECTIVE_INTERVAL_TICKS, 90, 540]) expect(() => frontierFirstAssess(e, 'red', view, n)).toThrow(/only for 270-tick checks/);
    // The v1 assessment serializes with no frontier-first field.
    expect(Object.keys(objectiveAssess(e, 'red', view)).sort()).toEqual(['category', 'controller', 'intent', 'objectiveId', 'observed', 'reason', 'side', 'source', 'tick']);
    // Board contract is shared: a stale board throws for both.
    const stale = { ...view, tick: view.tick - 1 };
    expect(() => objectiveAssess(e, 'red', stale)).toThrow(/stale/); expect(() => frontierFirstAssess(e, 'red', stale, 270)).toThrow(/stale/);
  }, 60_000);

  test('assessment mutates neither the engine, its record, the board nor the saved checkpoint, and repeats exactly', async () => {
    const { cp } = saved(SOL, 3); const frozen = JSON.stringify(cp);
    const { e, view } = await restore(cp);
    const before = { fingerprint: e.state().fingerprint, record: JSON.stringify(e.record()), view: JSON.stringify(view), ticks: e.game.ticks(), troops: (['blue', 'red'] as Side[]).map((s) => e.player(s).troops()) };
    const a = frontierFirstAssess(e, 'red', view, 270), b = frontierFirstAssess(e, 'red', view, 270); objectiveAssess(e, 'red', view);
    expect(b).toEqual(a);
    expect({ fingerprint: e.state().fingerprint, record: JSON.stringify(e.record()), view: JSON.stringify(view), ticks: e.game.ticks(), troops: (['blue', 'red'] as Side[]).map((s) => e.player(s).troops()) }).toEqual(before);
    expect(JSON.stringify(cp)).toBe(frozen);
  }, 60_000);

  test('the same saved record restored twice, with different verification, gives identical assessments for both versions', async () => {
    const { cp } = saved(SOL, 4);
    const x = await restore(cp, 'checkpoints'), y = await restore(cp, 'every-tick');
    expect(y.e.state().fingerprint).toBe(x.e.state().fingerprint);
    expect(frontierFirstAssess(y.e, 'red', y.view, 270)).toEqual(frontierFirstAssess(x.e, 'red', x.view, 270));
    expect(objectiveAssess(y.e, 'red', y.view)).toEqual(objectiveAssess(x.e, 'red', x.view));
  }, 120_000);
});

describe('experiment loop', () => {
  test('recorded Sol Blue orders against objectives/1 reproduce the saved outcome and every Red check', async () => {
    const p = await harnessParity(SOL);
    expect(p.checks).toEqual({ outcome: true, finalTick: true, scores: true, stopReason: true, redChecks: true });
    expect(p.finalTick).toBe(2004);
  }, 300_000);

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
