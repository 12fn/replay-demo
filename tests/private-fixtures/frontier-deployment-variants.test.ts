import {privateFixtureRoot} from './root';
/**
 * Opt-in deployment variants for the offline frontier-first experiment (docs/demo/frontier-deployment-variants.md).
 * Proves the predeclared variants start from materially different map positions for both sides, that the difference is
 * geometric rather than a seed/player-ID artefact, that variant games restore deterministically, and that the default
 * (no variant) path still reproduces the immutable main receipt game-for-game. Reads evidence only; writes nothing.
 */
import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ReplayEngine, type Side } from '../../src/engine/engine';
import { FRONTIER_FIRST_CONTROLLER, OBJECTIVE_CONTROLLER } from '../../src/agents/objective-controller';
import { NETWORK_RULES } from '../../src/campaign/network';
import { selectScenario } from '../../src/scenarios/catalog';
const ROOT = privateFixtureRoot;
import { TRIAL_SCENARIO_ID } from '../../scripts/ai-player-trial';
import {
  BLUE_STYLES, DEPLOYMENT_VARIANTS, DEPLOYMENT_VARIANTS_SCHEMA, EXPERIMENT_SCHEMA, HELD_OUT_SEEDS, POLICIES, RECORDED_DEPLOYMENT, RECORDED_SEED,
  deploymentSpawn, determinism, initialDeployment, runDeploymentVariants, runGame, startDifference, type BlueStyle, type Deployment, type DeploymentVariant, type GameResult, type InitialDeployment,
} from '../../scripts/qualify-frontier-experiment';

console.debug = () => {}; console.warn = () => {};

const SIDES: Side[] = ['blue', 'red'];
const VARIANTS = Object.keys(DEPLOYMENT_VARIANTS) as DeploymentVariant[];
const ALL: Deployment[] = [RECORDED_DEPLOYMENT, ...VARIANTS];
const RECEIPT = path.join(ROOT, 'evidence/campaign/frontier-policy-main-20260915.json');
const stationAt = ([x, y]: readonly [number, number]) => NETWORK_RULES.stations.find((s) => s.x === x && s.y === y)?.id;

describe('predeclared variants', () => {
  test('three fixed layouts, each side on a station fraction, none reusing that side\'s recorded start', () => {
    const scenario = selectScenario(TRIAL_SCENARIO_ID);
    expect(VARIANTS).toEqual(['blue-delta-red-aster/1', 'blue-beacon-red-cedar/1', 'blue-cedar-red-ember/1']);
    expect(SIDES.map((s) => stationAt(scenario.spawn[s]))).toEqual(['aster', 'delta']);
    for (const v of VARIANTS) {
      const spawn = deploymentSpawn(scenario, v);
      expect(`blue-${stationAt(spawn.blue)}-red-${stationAt(spawn.red)}/1`).toBe(v);
      for (const s of SIDES) expect(spawn[s]).not.toEqual(scenario.spawn[s]);
    }
    expect(deploymentSpawn(scenario)).toBe(scenario.spawn); expect(deploymentSpawn(scenario, RECORDED_DEPLOYMENT)).toBe(scenario.spawn);
    expect(() => deploymentSpawn(scenario, 'toString' as DeploymentVariant)).toThrow(/Unknown deployment variant/);
  });
});

describe('starting conditions', () => {
  const starts = new Map<Deployment, InitialDeployment>();
  const start = async (d: Deployment) => { if (!starts.has(d)) starts.set(d, await initialDeployment(RECORDED_SEED, d)); return starts.get(d)!; };

  test('every pair of deployments differs for both sides: different spawn tile, no owned tile in common, well apart', async () => {
    for (const d of ALL) await start(d);
    for (const [i, a] of ALL.entries()) for (const b of ALL.slice(i + 1)) {
      const diff = startDifference(starts.get(a)!, starts.get(b)!);
      for (const s of SIDES) {
        expect(diff[s], `${a} vs ${b} ${s}`).toMatchObject({ sameSpawnTile: false, sharedOwnedTiles: 0 });
        expect(diff[s].spawnDistanceTiles, `${a} vs ${b} ${s}`).toBeGreaterThanOrEqual(50);
      }
    }
    // Both sides deploy on land of their own in every layout with the recorded starting troops (no force bonus); the seed and players are identical across layouts.
    for (const d of ALL) {
      const x = starts.get(d)!;
      for (const s of SIDES) { expect(x[s].ownedTiles).toBeGreaterThan(0); expect(x[s].owned).toContain(x[s].spawnTile); expect(x[s].troops).toBe(starts.get(RECORDED_DEPLOYMENT)!.blue.troops); }
      expect(x.playerIds).toEqual(starts.get(RECORDED_DEPLOYMENT)!.playerIds);
    }
  }, 120_000);

  test('landmass relationships are the declared geometry, measured on the map', async () => {
    const land = async (d: Deployment) => { const x = await start(d); return { shared: x.sharedLandmass, blue: x.blue.stationsOnLandmass, red: x.red.stationsOnLandmass }; };
    const main = ['beacon', 'cedar', 'delta'];
    expect(await land(RECORDED_DEPLOYMENT)).toEqual({ shared: false, blue: ['aster'], red: main });
    expect(await land('blue-delta-red-aster/1')).toEqual({ shared: false, blue: main, red: ['aster'] });
    expect(await land('blue-beacon-red-cedar/1')).toEqual({ shared: true, blue: main, red: main });
    expect(await land('blue-cedar-red-ember/1')).toEqual({ shared: false, blue: main, red: ['ember'] });
  }, 120_000);

  test('a start depends on the layout, not the seed: four seed identifiers change player IDs and fingerprints but not a single tile', async () => {
    for (const d of ['blue-beacon-red-cedar/1', RECORDED_DEPLOYMENT] as Deployment[]) {
      const bySeed = await Promise.all([RECORDED_SEED, ...HELD_OUT_SEEDS].map((s) => initialDeployment(s, d)));
      expect(new Set(bySeed.map((x) => x.playerIds.red)).size).toBe(4);
      expect(new Set(bySeed.map((x) => x.fingerprint)).size).toBe(4);
      for (const x of bySeed) for (const s of SIDES) expect(x[s]).toEqual(bySeed[0]![s]);
    }
  }, 120_000);

  test('the deployment record restores to the same fingerprint and the same owned tiles', async () => {
    for (const d of VARIANTS) {
      const x = await start(d);
      const spawns = x.record.turns[0]!.intents.filter((i) => i.type === 'spawn').map((i) => (i as { tile: number }).tile);
      expect(spawns).toEqual([x.blue.spawnTile, x.red.spawnTile]);
      const r = await ReplayEngine.restore(x.record, x.record.turns.length, 'every-tick');
      expect(r.state().fingerprint).toBe(x.fingerprint);
      for (const s of SIDES) expect([...r.player(s).tiles()].sort((a, b) => a - b)).toEqual(x[s].owned);
    }
  }, 120_000);
});

describe('variant games', () => {
  test('a capped variant game is byte-deterministic, restores to its final fingerprint and starts from the variant spawns', async () => {
    const v: DeploymentVariant = 'blue-delta-red-aster/1';
    const d = await determinism(RECORDED_SEED, 'aggressive', FRONTIER_FIRST_CONTROLLER, 855, v);
    expect(d).toMatchObject({ deployment: v, sameRecord: true, sameRedChecks: true, restoredFingerprintMatched: true });
    const [game, legacy, start] = await Promise.all([
      runGame({ seed: RECORDED_SEED, blue: 'aggressive', policy: FRONTIER_FIRST_CONTROLLER, capTicks: 855, deployment: v, keepRecord: true }),
      runGame({ seed: RECORDED_SEED, blue: 'aggressive', policy: FRONTIER_FIRST_CONTROLLER, capTicks: 855, keepRecord: true }),
      initialDeployment(RECORDED_SEED, v),
    ]);
    expect(game.deployment).toBe(v); expect(game.recordSha256).toBe(d.recordSha256);
    const spawnTiles = (g: GameResult) => g.record!.turns[0]!.intents.map((i) => (i as { tile: number }).tile);
    expect(spawnTiles(game)).toEqual([start.blue.spawnTile, start.red.spawnTile]);
    expect(spawnTiles(game)).not.toEqual(spawnTiles(legacy));
    // Same bounds and cadence as the recorded deployment; only the start moved.
    expect(game.firstDecisionTick).toBe(legacy.firstDecisionTick);
    expect(game.redChecks.map((c) => c.tick)).toEqual(legacy.redChecks.map((c) => c.tick));
    expect(game.blueSummary.droppedAtTick + game.redSummary.droppedAtTick + game.redSummary.refusedAtSubmission).toBe(0);
  }, 300_000);
});

describe('recorded deployment is unchanged', () => {
  type Receipt = { schema: string; kind: string; games: GameResult[]; determinism: { blue: string; policy: string; recordSha256: string }[] };
  const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8')) as Receipt;

  test('no variant: all eight PAIR0001 games reproduce the main receipt entry exactly, with no deployment field', async () => {
    expect({ schema: receipt.schema, kind: receipt.kind, games: receipt.games.length }).toEqual({ schema: EXPERIMENT_SCHEMA, kind: 'experiment', games: 32 });
    for (const blue of Object.keys(BLUE_STYLES) as BlueStyle[]) for (const policy of POLICIES) {
      const saved = receipt.games.find((g) => g.seed === RECORDED_SEED && g.blue === blue && g.policy === policy)!;
      const r = await runGame({ seed: RECORDED_SEED, blue, policy });
      expect(Object.keys(r), `${blue} ${policy}`).toEqual(Object.keys(saved));
      expect('deployment' in r).toBe(false);
      expect(JSON.stringify(r), `${blue} ${policy}`).toBe(JSON.stringify(saved));
    }
    for (const saved of receipt.determinism) expect(saved.recordSha256).toBe((await runGame({ seed: RECORDED_SEED, blue: saved.blue as BlueStyle, policy: saved.policy as typeof OBJECTIVE_CONTROLLER })).recordSha256);
  }, 600_000);
});

describe(`${DEPLOYMENT_VARIANTS_SCHEMA} output`, () => {
  test('smoke run: separately versioned, starts proven distinct before games, variant games labelled, legacy games not', async () => {
    const out = await runDeploymentVariants({ smoke: true });
    expect(out).toMatchObject({ schema: DEPLOYMENT_VARIANTS_SCHEMA, kind: 'smoke-not-experiment', harnessParity: { matched: true } });
    expect(out.schema).not.toBe(EXPERIMENT_SCHEMA);
    expect(Object.keys(out.method.deployments)).toEqual([RECORDED_DEPLOYMENT, VARIANTS[0]]);
    expect(out.startingConditions.seedInvariance.every((x) => x.sameStartAcrossSeeds && x.distinctPlayerIds === 4)).toBe(true);
    expect(out.startingConditions.differences).toHaveLength(1);
    for (const x of out.startingConditions.deployments) expect(Object.keys(x)).not.toContain('record');
    expect(out.games.map((g) => ('deployment' in g ? g.deployment : null))).toEqual([null, null, VARIANTS[0], VARIANTS[0]]);
    expect(out.determinism.every((d) => d.sameRecord && d.sameRedChecks && d.restoredFingerprintMatched)).toBe(true);
    expect(out.method.deployments[VARIANTS[0]!]).toEqual(DEPLOYMENT_VARIANTS[VARIANTS[0]!]);
  }, 600_000);
});

// This orchestration entry point has a fixed historical trial prerequisite.
vi.mock('../../scripts/qualify-pacing', async importOriginal => ({...await importOriginal<typeof import('../../scripts/qualify-pacing')>(), ROOT: process.env.REPLAY_PRIVATE_FIXTURE_ROOT}));
