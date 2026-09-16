import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENTS, ReplayEngine, TRANSPORT_ADMISSION, type Side } from '../../src/engine/engine';
import { NETWORK_RULES, STRAIT_NETWORK_RULES } from '../../src/campaign/network';
import { selectScenario } from '../../src/scenarios/catalog';
import { STRAIT_RED_CELL_VERSION, straitRedCellInstructions, straitRedCellPublicBrief } from '../../src/scenarios/strait-red-cell';
import { spawnTarget } from '../../scripts/qualify-pacing';
import { playerOutputSchema, renderSeatPrompt, seatSnapshotId, type SeatSnapshot } from '../../scripts/ai-player-trial';
import { BOARD_WINDOW, DUAL_CLAIMS, DUAL_FULL_GAME_MODE, DUAL_SCENARIO_CONTEXT, DUAL_SCHEMA, DualRejection, FULL_GAME_MAX_ROUNDS, MAX_ROUNDS, OWN_ORDER_WINDOW, ROUND_FEEDBACK_CLAIM, ROUND_FEEDBACK_PROFILE, SCENARIO_SOURCE_FILES, TAIWAN_SCENARIO_CLAIM, checkDualConfig, claimsFor, gameStatus, initGame, leadingSeat, parseDualArgs, rebuildSavedRound, renderDualPrompt, stepGame, type DualCheckpoint, type DualConfig, type DualManifest } from '../../scripts/dual-model-trial';

// Deterministic file responses only: no provider, model, network or scripted player. Each rejection case runs on a copy of one pristine game.
const SEATS: Side[] = ['blue', 'red'];
let tmp: string;
const read = (dir: string, p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
const readJson = <T>(dir: string, p: string) => JSON.parse(read(dir, p)) as T;
const snapOf = (dir: string, m: DualManifest, seat: Side) => readJson<SeatSnapshot>(dir, m.cursor!.seats[seat].snapshot);
const copy = (dir: string, name: string) => { const to = path.join(tmp, name); fs.cpSync(dir, to, { recursive: true }); return to; };
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)])).sort();
const tree = (dir: string) => Object.fromEntries(files(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]));
const code = async (p: Promise<unknown>) => { try { await p; } catch (err) { return (err as { code?: string }).code ?? `other: ${(err as Error).message}`; } return 'accepted'; };
const secret = (seat: Side, round: number) => `${seat.toUpperCase()}-PRIVATE-RATIONALE-R${round}`;
/** First troop-bearing candidate at share 0.2, else hold. Deterministic; not a player policy. */
const pick = (s: SeatSnapshot) => { const c = s.candidates.find((x) => x.troopOptions?.some((o) => o.share === 0.2)); return c ? { choice: c.index, share: 0.2 } : { choice: 'hold' as const, share: null }; };
const reply = (s: { snapshotId: string }, choice: number | 'hold', share: number | null, rationale: string) => JSON.stringify({ snapshotId: s.snapshotId, choice, share, rationale });
function writeReplies(dir: string, m: DualManifest, tag: string, override: Partial<Record<Side, string>> = {}) {
  const out = {} as Record<Side, string>;
  for (const seat of SEATS) {
    const s = snapOf(dir, m, seat), p = pick(s);
    out[seat] = path.join(tmp, `${tag}-${seat}.json`);
    fs.writeFileSync(out[seat], override[seat] ?? reply(s, p.choice, p.share, secret(seat, m.cursor!.round)));
  }
  return { blueResponse: out.blue, redResponse: out.red };
}
const cleanup = () => { if (tmp) { for (const f of files(tmp)) fs.chmodSync(f, 0o644); fs.rmSync(tmp, { recursive: true, force: true }); } };
/** Rewrite a saved JSON file in place (tamper cases only). */
const rewrite = (dir: string, p: string, edit: (v: any) => unknown) => { const f = path.join(dir, p); const v = readJson<any>(dir, p); fs.chmodSync(f, 0o644); fs.writeFileSync(f, JSON.stringify(edit(v), null, 2) + '\n'); };

/** Step a game to completion with the deterministic replies, checking the queue order and fingerprint chain each round. */
async function playOut(dir: string, m: DualManifest, tag: string) {
  while (m.status === 'awaiting-responses') {
    const k = m.cursor!.round, blue = snapOf(dir, m, 'blue');
    expect(blue.fingerprint).toBe(snapOf(dir, m, 'red').fingerprint);
    if (k > 0) expect(readJson<{ fingerprintAfter: string }>(dir, `${m.history[k - 1]!.result}/outcome.json`).fingerprintAfter).toBe(blue.fingerprint);
    m = await stepGame({ dir, ...writeReplies(dir, m, `${tag}-${k}`) });
    expect(m.history[k]!.queue).toEqual(k % 2 === 0 ? ['blue', 'red'] : ['red', 'blue']);
  }
  return m;
}

/** The final record holds exactly the listed executed seat orders, counts match the history, and the restored record reaches finalFingerprint. */
async function expectListedAndReconstructed(dir: string, m: DualManifest, summary: any) {
  const final = readJson<DualCheckpoint>(dir, 'final/replay.json');
  const orders = final.record.turns.flatMap((t) => t.intents.map((i, idx) => ({ ...i, key: `${t.turnNumber}:${idx}:${i.clientID}` }))).filter((i) => i.type !== 'spawn');
  const listed = m.history.flatMap((h) => SEATS.filter((s) => h.seats[s].executedKey).map((s) => ({ key: h.seats[s].executedKey, intent: h.seats[s].intent })));
  expect(orders.length).toBeGreaterThan(0);
  expect(orders.map((o) => o.key).sort()).toEqual(listed.map((l) => l.key).sort());
  for (const o of orders) { const { key, clientID, ...intent } = o; expect(intent).toEqual(expect.objectContaining(listed.find((l) => l.key === key)!.intent)); }
  expect(summary.reconstruction).toMatchObject({ unlistedOrders: 0, recordedOrders: orders.length, listedSeatOrders: listed.length });
  for (const seat of SEATS) {
    const rs = m.history.map((h) => h.seats[seat]);
    expect(summary.orders[seat]).toEqual({ rounds: rs.length, holds: rs.filter((r) => r.choice === 'hold').length, submitted: rs.filter((r) => r.choice !== 'hold').length, executedAtTick: rs.filter((r) => r.executedKey).length, droppedAtTick: rs.filter((r) => r.droppedAtTick).length });
    for (const r of rs) expect(r.executedKey === null && r.choice !== 'hold').toBe(r.droppedAtTick !== null);
  }
  expect(summary.leadingSeatByRound).toEqual(m.history.map((_, k) => leadingSeat(k)));
  const last = m.history.at(-1)!;
  expect(summary.sources.map((s: { path: string }) => s.path)).toEqual(expect.arrayContaining([`${last.result}/blue/response.raw.json`, `${last.result}/red/decision.json`, 'initialization/game.json']));
  const restored = await ReplayEngine.restore(final.record, final.record.turns.length, 'checkpoints');
  expect([restored.state().fingerprint, restored.game.ticks()]).toEqual([summary.reconstruction.finalFingerprint, summary.ticksSimulated]);
}

describe('dual-model/1 argument and bound contract', () => {
  it('uses the fixed CLI shape, defaults to 6 rounds x 270 ticks and refuses rounds outside 1-6', () => {
    expect(parseDualArgs(['init', '--dir', 'g'])).toMatchObject({ command: 'init', config: { maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001' } });
    expect(parseDualArgs(['init', '--dir', 'g', '--rounds', '6', '--ticks-per-round', '270', '--seed', 'DUAL0001']).config).toEqual({ maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001' });
    expect(parseDualArgs(['step', '--dir', 'g', '--blue-response', 'b.json', '--red-response', 'r.json'])).toMatchObject({ command: 'step' });
    expect(MAX_ROUNDS).toBe(6);
    const usage = (argv: string[]) => { try { parseDualArgs(argv); return 'accepted'; } catch (err) { return (err as DualRejection).code; } };
    for (const bad of [['--rounds', '0'], ['--rounds', '7'], ['--rounds', '45'], ['--rounds', '2.5'], ['--rounds', '-1'], ['--ticks-per-round', '100'], ['--ticks-per-round', '945'], ['--seed', 'bad seed'], ['--decisions', '6'], ['--rounds']]) expect(usage(['init', '--dir', 'g', ...bad])).toBe('usage');
    expect(usage(['step', '--dir', 'g', '--blue-response', 'b.json'])).toBe('usage');
    expect(usage(['step', '--dir', 'g', '--blue-response', 'x.json', '--red-response', 'x.json'])).toBe('usage');
    expect(usage(['bounds'])).toBe('usage');
    for (const bad of [{ maxRounds: 7, ticksPerRound: 270, seed: 'A' }, { maxRounds: 6, ticksPerRound: 270, seed: 'A', mode: 'full-game' }, { maxRounds: '6', ticksPerRound: 270, seed: 'A' }]) expect(() => checkDualConfig(bad)).toThrow(/integrity/);
    // Short claims are pinned to the text saved by the actual six-round games.
    expect(claimsFor({ maxRounds: 3, ticksPerRound: 90, seed: 'A' })).toBe(DUAL_CLAIMS);
    expect(DUAL_CLAIMS.horizon).toBe('At most 6 rounds: a short capped exercise. A round-limit stop has no result, and its provisional scores are not a win, a strength measure or evidence of mastery.');
  });

  it('opts into full-game/1 only with an explicit --mode, defaults to 45 rounds x 270 ticks and refuses anything past 45', () => {
    const usage = (argv: string[]) => { try { parseDualArgs(argv); return 'accepted'; } catch (err) { return (err as DualRejection).code; } };
    const full = parseDualArgs(['init', '--dir', 'g', '--mode', 'full-game']).config!;
    expect(full).toEqual({ mode: DUAL_FULL_GAME_MODE, maxRounds: 45, ticksPerRound: 270, seed: 'DUAL0001' });
    expect(Object.keys(full)).toEqual(['mode', 'maxRounds', 'ticksPerRound', 'seed']);
    expect([DUAL_FULL_GAME_MODE, FULL_GAME_MAX_ROUNDS]).toEqual(['full-game/1', 45]);
    for (const n of ['1', '7', '45']) expect(parseDualArgs(['init', '--dir', 'g', '--mode', 'full-game', '--rounds', n]).config).toEqual({ ...full, maxRounds: Number(n) });
    // `--mode short` is the omitted default: exactly the old three-key config.
    expect(parseDualArgs(['init', '--dir', 'g', '--mode', 'short']).config).toEqual({ maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001' });
    expect(Object.keys(parseDualArgs(['init', '--dir', 'g']).config!)).toEqual(['maxRounds', 'ticksPerRound', 'seed']);
    for (const bad of [['--mode', 'full-game', '--rounds', '46'], ['--mode', 'full-game', '--rounds', '0'], ['--mode', 'full-game', '--ticks-per-round', '100'], ['--mode', 'full-game/1'], ['--mode', 'full'], ['--mode', 'FULL-GAME'], ['--mode', 'full-game', '--mode', 'full-game'], ['--mode'], ['--mode', 'short', '--rounds', '7']]) expect(usage(['init', '--dir', 'g', ...bad])).toBe('usage');
    expect(usage(['step', '--dir', 'g', '--mode', 'full-game', '--blue-response', 'b.json', '--red-response', 'r.json'])).toBe('usage');
    expect(usage(['status', '--dir', 'g', '--mode', 'full-game'])).toBe('usage');
    expect(() => parseDualArgs(['init', '--dir', 'g', '--rounds', '45'])).toThrow(/--mode full-game/);

    // A saved config: the recorded mode alone selects the bound, and only the one known mode version exists.
    expect(() => checkDualConfig({ mode: 'full-game/1', maxRounds: 45, ticksPerRound: 270, seed: 'A' })).not.toThrow();
    for (const bad of [{ mode: 'full-game/1', maxRounds: 46, ticksPerRound: 270, seed: 'A' }, { mode: 'full-game/2', maxRounds: 45, ticksPerRound: 270, seed: 'A' }, { mode: null, maxRounds: 6, ticksPerRound: 270, seed: 'A' }, { mode: 'short', maxRounds: 6, ticksPerRound: 270, seed: 'A' }, { mode: 'full-game/1', maxRounds: 45, ticksPerRound: 270, seed: 'A', extra: 1 }, { maxRounds: 45, ticksPerRound: 270, seed: 'A' }]) expect(() => checkDualConfig(bad)).toThrow(/integrity/);

    const claims = claimsFor({ mode: DUAL_FULL_GAME_MODE, maxRounds: 45, ticksPerRound: 270, seed: 'A' });
    expect(claims).toMatchObject({ mode: DUAL_FULL_GAME_MODE, players: DUAL_CLAIMS.players, timing: DUAL_CLAIMS.timing, information: DUAL_CLAIMS.information, ordering: DUAL_CLAIMS.ordering, harnessModelCalls: 0, humanPlaytest: false, claim: DUAL_CLAIMS.claim });
    expect(claims.horizon).toMatch(/^Full-game mode \(full-game\/1\): at most 45 rounds of 270 ticks, stopping earlier at elimination or the 12000-tick objective limit\./);
    expect(claims.horizon).toMatch(/provisional scores are not a win/);
    expect(claimsFor({ mode: DUAL_FULL_GAME_MODE, maxRounds: 8, ticksPerRound: 45, seed: 'A' }).horizon).toMatch(/at most 8 rounds of 45 ticks/);
  });

  it('refuses a seventh short round or a 46th full-game round before creating anything', async () => {
    const dir = path.join(os.tmpdir(), `dual-model-refused-${process.pid}`);
    expect(await code(initGame({ dir, config: { maxRounds: 7, ticksPerRound: 270, seed: 'DUAL0001' } }))).toBe('usage');
    expect(await code(initGame({ dir, config: { mode: DUAL_FULL_GAME_MODE, maxRounds: 46, ticksPerRound: 270, seed: 'DUAL0001' } }))).toBe('usage');
    expect(await code(initGame({ dir, config: { mode: 'full-game/2', maxRounds: 45, ticksPerRound: 270, seed: 'DUAL0001' } as unknown as DualConfig }))).toBe('usage');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('selects taiwan-strait/1 only with an explicit --scenario from the allowlist, recorded last in the config', async () => {
    const usage = (argv: string[]) => { try { parseDualArgs(argv); return 'accepted'; } catch (err) { return (err as DualRejection).code; } };
    const short = parseDualArgs(['init', '--dir', 'g', '--scenario', 'taiwan-strait/1']).config!;
    expect(short).toEqual({ maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001', scenario: 'taiwan-strait/1' });
    expect(Object.keys(short)).toEqual(['maxRounds', 'ticksPerRound', 'seed', 'scenario']);
    const full = parseDualArgs(['init', '--dir', 'g', '--mode', 'full-game', '--rounds', '7', '--scenario', 'taiwan-strait/1']).config!;
    expect(Object.keys(full)).toEqual(['mode', 'maxRounds', 'ticksPerRound', 'seed', 'scenario']);
    for (const bad of [['--scenario', 'crosscurrent-objectives/1'], ['--scenario', 'taiwan-strait/2'], ['--scenario', 'TAIWAN-STRAIT/1'], ['--scenario', 'taiwan-strait'], ['--scenario', ''], ['--scenario'], ['--scenario', 'taiwan-strait/1', '--scenario', 'taiwan-strait/1'], ['--scenario', 'taiwan-strait/1', '--rounds', '7']]) expect(usage(['init', '--dir', 'g', ...bad])).toBe('usage');
    expect(usage(['step', '--dir', 'g', '--scenario', 'taiwan-strait/1', '--blue-response', 'b.json', '--red-response', 'r.json'])).toBe('usage');
    expect(usage(['status', '--dir', 'g', '--scenario', 'taiwan-strait/1'])).toBe('usage');
    for (const bad of [{ ...short, scenario: 'crosscurrent-objectives/1' }, { ...short, scenario: null }, { ...short, scenario: 'taiwan-strait/2' }, { ...short, maxRounds: 7 }, { ...short, extra: 1 }]) expect(() => checkDualConfig(bad)).toThrow(/integrity/);
    expect(() => checkDualConfig(full)).not.toThrow();

    const claims = claimsFor(short as DualConfig);
    expect(claims).toEqual({ ...DUAL_CLAIMS, scenarioId: 'taiwan-strait/1', scenario: TAIWAN_SCENARIO_CLAIM });
    expect(TAIWAN_SCENARIO_CLAIM).toMatch(/not the native continuous Taiwan exercise/);
    expect(TAIWAN_SCENARIO_CLAIM).toMatch(/Red alone receives the strait-red-cell\/1 brief/);
    expect(claimsFor(full as DualConfig)).toMatchObject({ mode: DUAL_FULL_GAME_MODE, scenarioId: 'taiwan-strait/1', horizon: expect.stringMatching(/at most 7 rounds/) });

    const dir = path.join(os.tmpdir(), `dual-model-refused-scenario-${process.pid}`);
    expect(await code(initGame({ dir, config: { ...short, scenario: 'taiwan-strait/2' } as unknown as DualConfig }))).toBe('usage');
    expect(await code(initGame({ dir, config: { ...short, maxRounds: 7 } as DualConfig }))).toBe('usage');
    expect(fs.existsSync(dir)).toBe(false);
  });


});

describe('dual-model/1 two-seat game (offline, deterministic replies)', () => {
  const config = { maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001' }; // the actual first-trial contract
  let pristine: string; let m0: DualManifest;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-model-trial-'));
    pristine = path.join(tmp, 'pristine');
    m0 = await initGame({ dir: pristine, config });
  }, 120_000);
  afterAll(cleanup);

  it('writes the manifest contract with relative paths and builds both seats from one pre-order state', async () => {
    expect(Object.keys(m0)).toEqual(['schema', 'gameId', 'config', 'status', 'cursor', 'history']);
    expect(m0).toMatchObject({ schema: DUAL_SCHEMA, config, status: 'awaiting-responses', history: [] });
    for (const seat of SEATS) {
      expect(Object.keys(m0.cursor!.seats[seat])).toEqual(['prompt', 'snapshot', 'schema']);
      for (const p of Object.values(m0.cursor!.seats[seat])) { expect(path.isAbsolute(p)).toBe(false); expect(p.startsWith(`rounds/00/${seat}/`)).toBe(true); }
      expect(readJson(pristine, m0.cursor!.seats[seat].schema)).toEqual(playerOutputSchema());
    }
    const blue = snapOf(pristine, m0, 'blue'), red = snapOf(pristine, m0, 'red');
    const cp = readJson<DualCheckpoint>(pristine, 'rounds/00/replay.json');
    const e = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints');
    expect([blue.tick, red.tick, cp.tick, e.game.ticks()]).toEqual([m0.cursor!.tick, m0.cursor!.tick, m0.cursor!.tick, m0.cursor!.tick]);
    expect(blue.fingerprint).toBe(red.fingerprint);
    expect(blue.fingerprint).toBe(e.state().fingerprint);
    expect([blue.seat, red.seat, blue.snapshotId === red.snapshotId]).toEqual(['blue', 'red', false]);
    expect(read(pristine, m0.cursor!.seats.red.prompt)).toBe(renderSeatPrompt(red));
    expect(cp.record.options.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(blue.transportAdmission).toBe(TRANSPORT_ADMISSION);
    // Deployment issued no orders: the record holds the spawn turn only.
    expect(cp.record.turns.flatMap((t) => t.intents).map((i) => i.type)).toEqual(['spawn', 'spawn']);
    expect(readJson(pristine, 'initialization/game.json')).toMatchObject({ gameId: m0.gameId, opponentController: null, transportAdmission: TRANSPORT_ADMISSION });
    // Short mode is the pre-existing game shape: no mode key anywhere, the original claims object.
    const game = readJson<any>(pristine, 'initialization/game.json');
    expect(Object.keys(game)).toEqual(['schema', 'gameId', 'createdAt', 'config', 'scenarioId', 'map', 'transportAdmission', 'engine', 'deploymentFromTick', 'firstRoundTick', 'seats', 'opponentController', 'claims']);
    expect(Object.keys(game.config)).toEqual(['maxRounds', 'ticksPerRound', 'seed']);
    expect(Object.keys(m0.config)).toEqual(['maxRounds', 'ticksPerRound', 'seed']);
    expect(game.claims).toEqual(DUAL_CLAIMS);
    expect(game.schema).toBe('replay.dual-model-trial/1#game');
    for (const f of files(pristine).filter((f) => !f.endsWith('manifest.json'))) expect(fs.statSync(f).mode & 0o222).toBe(0);
    expect(await code(initGame({ dir: pristine, config }))).toBe('usage');
  });

  it('halts on a wrong-seat, malformed or illegal reply without applying either choice, and refuses a retry', async () => {
    const blue = snapOf(pristine, m0, 'blue'), red = snapOf(pristine, m0, 'red'), pb = pick(blue), pr = pick(red);
    expect(typeof pb.choice).toBe('number'); expect(typeof pr.choice).toBe('number');
    const cases: { name: string; override: Partial<Record<Side, string>>; code: string; accepted: Record<Side, boolean> }[] = [
      { name: 'swapped', override: { blue: reply(red, pr.choice, pr.share, 'x'), red: reply(blue, pb.choice, pb.share, 'x') }, code: 'unknown-snapshot', accepted: { blue: false, red: false } },
      { name: 'red-malformed', override: { red: '{"snapshotId": ' }, code: 'malformed', accepted: { blue: true, red: false } },
      { name: 'red-prose', override: { red: `Sure! ${reply(red, pr.choice, pr.share, 'x')}` }, code: 'malformed', accepted: { blue: true, red: false } },
      { name: 'blue-bad-share', override: { blue: reply(blue, pb.choice, 0.3, 'x') }, code: 'illegal-choice', accepted: { blue: false, red: true } },
      { name: 'red-missing-share', override: { red: JSON.stringify({ snapshotId: red.snapshotId, choice: 'hold', rationale: 'x' }) }, code: 'malformed', accepted: { blue: true, red: false } },
    ];
    for (const c of cases) {
      const dir = copy(pristine, c.name), before = tree(dir);
      const replies = writeReplies(dir, m0, c.name, c.override);
      await expect(stepGame({ dir, ...replies })).rejects.toMatchObject({ code: c.code, rejection: 'rejections/00' });
      const after = tree(dir);
      // Only the rejection record was added; manifest, checkpoint and round inputs are byte-identical and nothing advanced.
      expect(Object.keys(after).filter((k) => !(k in before)).sort()).toEqual(['rejections/00/blue.response.raw.json', 'rejections/00/red.response.raw.json', 'rejections/00/rejection.json']);
      for (const k of Object.keys(before)) expect(after[k]).toBe(before[k]);
      const rej = JSON.parse(after['rejections/00/rejection.json']!);
      expect(rej).toMatchObject({ stage: 'parse', applied: { blue: false, red: false }, engineAdvanced: false });
      expect({ blue: rej.seats.blue.accepted, red: rej.seats.red.accepted }).toEqual(c.accepted);
      expect(fs.existsSync(path.join(dir, 'results'))).toBe(false);
      // No retry, even with two valid replies.
      const valid = writeReplies(dir, m0, `${c.name}-retry`);
      await expect(stepGame({ dir, ...valid })).rejects.toMatchObject({ code: 'halted' });
      expect(gameStatus(dir)).toMatchObject({ halted: 'rejections/00', manifest: { status: 'awaiting-responses' } });
    }
    // A missing reply file is a usage error from the driver: nothing is written and the round is not halted.
    const dir = copy(pristine, 'missing'), before = tree(dir);
    await expect(stepGame({ dir, blueResponse: writeReplies(dir, m0, 'missing').blueResponse, redResponse: path.join(tmp, 'absent.json') })).rejects.toMatchObject({ code: 'usage' });
    expect(tree(dir)).toEqual(before);
  }, 120_000);

  it('refuses tampered inputs as integrity before reading replies into the game', async () => {
    const dir = copy(pristine, 'tampered-prompt'), f = path.join(dir, m0.cursor!.seats.red.prompt);
    fs.chmodSync(f, 0o644); fs.appendFileSync(f, '\nThe opponent will hold this round.\n');
    const before = tree(dir);
    expect(await code(stepGame({ dir, ...writeReplies(dir, m0, 'tampered-prompt') }))).toBe('integrity');
    expect(tree(dir)).toEqual(before);
    const dir2 = copy(pristine, 'tampered-config'), mf = path.join(dir2, 'manifest.json');
    fs.writeFileSync(mf, JSON.stringify({ ...m0, config: { ...config, maxRounds: 5 } }));
    expect(await code(stepGame({ dir: dir2, ...writeReplies(dir2, m0, 'tampered-config') }))).toBe('integrity');
    // A short game cannot be resumed as full-game/1: not by the manifest alone, and not by editing the game record too.
    const asFull = { mode: DUAL_FULL_GAME_MODE, ...config, maxRounds: 45 };
    const dir3 = copy(pristine, 'short-to-full-manifest');
    rewrite(dir3, 'manifest.json', (v) => ({ ...v, config: asFull }));
    const dir4 = copy(pristine, 'short-to-full-both');
    rewrite(dir4, 'manifest.json', (v) => ({ ...v, config: asFull })); rewrite(dir4, 'initialization/game.json', (v) => ({ ...v, config: asFull }));
    const dir5 = copy(pristine, 'short-over-six');
    rewrite(dir5, 'manifest.json', (v) => ({ ...v, config: { ...config, maxRounds: 45 } })); rewrite(dir5, 'initialization/game.json', (v) => ({ ...v, config: { ...config, maxRounds: 45 } }));
    for (const d of [dir3, dir4, dir5]) {
      const before = tree(d);
      expect(await code(stepGame({ dir: d, ...writeReplies(d, m0, path.basename(d)) }))).toBe('integrity');
      expect(() => gameStatus(d)).toThrow(/integrity/);
      expect(tree(d)).toEqual(before);
    }
    expect(() => gameStatus(dir4)).toThrow(/claims do not match/);
  });

  it('alternates the queue, keeps each seat\'s history private, reconstructs deterministically and stops at the round limit', async () => {
    const dir = copy(pristine, 'main');
    let m = m0; const rounds: { m: DualManifest; snaps: Record<Side, SeatSnapshot> }[] = [];
    let staleDir = '';
    while (m.status === 'awaiting-responses') {
      const snaps = { blue: snapOf(dir, m, 'blue'), red: snapOf(dir, m, 'red') };
      rounds.push({ m, snaps });
      const k = m.cursor!.round;
      if (k === 1) staleDir = copy(dir, 'stale');
      const cp = readJson<DualCheckpoint>(dir, `rounds/0${k}/replay.json`);
      expect(snaps.blue.fingerprint).toBe(snaps.red.fingerprint);
      if (k > 0) expect(readJson<{ fingerprintAfter: string }>(dir, `results/0${k - 1}/outcome.json`).fingerprintAfter).toBe(snaps.blue.fingerprint);
      m = await stepGame({ dir, ...writeReplies(dir, m, `main-${k}`) });
      const out = readJson<{ queue: { leadingSeat: Side; order: Side[]; orders: { seat: Side; executedKey: string | null; droppedAtTick: string | null }[] }; reconstruction: { fingerprintMatched: boolean } }>(dir, `results/0${k}/outcome.json`);
      expect(out.queue.leadingSeat).toBe(leadingSeat(k));
      expect(out.queue.order).toEqual(k % 2 === 0 ? ['blue', 'red'] : ['red', 'blue']);
      expect(out.reconstruction.fingerprintMatched).toBe(true);
      // The recorded engine turn carries both orders in queue order, keyed by position.
      const turnNumber = cp.record.turns.length, h = m.history[k]!;
      expect(h.queue).toEqual(out.queue.order);
      const executed = out.queue.orders.filter((o) => o.executedKey !== null);
      executed.forEach((o, i) => expect(o.executedKey).toBe(`${turnNumber}:${i}:${CLIENTS[o.seat]}`));
      for (const o of out.queue.orders) expect(o.executedKey === null).toBe(o.droppedAtTick !== null);
    }
    expect(rounds.map((r) => r.m.cursor!.round)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rounds.every(({ snaps }) => SEATS.every((s) => snaps[s].candidates.some((c) => c.troopOptions)))).toBe(true);
    expect(m.history.filter((h) => SEATS.some((s) => h.seats[s].executedKey !== null)).length).toBeGreaterThan(0);

    // Stale: replying to round 0 at round 1 is refused, and neither reply is applied.
    const m1 = rounds[1]!.m, old = rounds[0]!.snaps.blue;
    const stale = writeReplies(staleDir, m1, 'stale', { blue: reply(old, pick(old).choice, pick(old).share, 'x') });
    await expect(stepGame({ dir: staleDir, ...stale })).rejects.toMatchObject({ code: 'stale-snapshot' });
    expect(fs.existsSync(path.join(staleDir, 'results/01'))).toBe(false);

    // Private context: a seat's later files carry only its own earlier choices, never the opponent's reply or any rationale.
    for (const { m: rm, snaps } of rounds.slice(1)) {
      for (const seat of SEATS) {
        const other = seat === 'blue' ? 'red' : 'blue', k = rm.cursor!.round;
        const text = read(dir, rm.cursor!.seats[seat].snapshot) + read(dir, rm.cursor!.seats[seat].prompt);
        for (let j = 0; j < k; j++) { expect(text).not.toContain(secret(other, j)); expect(text).not.toContain(secret(seat, j)); expect(text).not.toContain(m.history[j]!.seats[other].snapshotId); }
        const prev = snaps[seat].observation.previousDecisions as Record<string, unknown>[];
        expect(prev.map((p) => p.choice)).toEqual(m.history.slice(0, k).map((h) => h.seats[seat].choice));
        for (const p of prev) expect(Object.keys(p)).not.toContain('rationale');
      }
    }
    for (const seat of SEATS) expect(readJson<{ rationale: string }>(dir, `results/00/${seat}/decision.json`).rationale).toBe(secret(seat, 0));

    // Completion: round limit, no outcome claimed, and the record holds no order that did not come from a listed seat reply.
    const summary = readJson<any>(dir, 'final/summary.json');
    expect(m).toMatchObject({ status: 'complete', cursor: null });
    expect(summary).toMatchObject({ outcome: null, stopReason: 'round-limit', scoresStatus: 'provisional', rounds: 6, leadingSeatByRound: ['blue', 'red', 'blue', 'red', 'blue', 'red'], reconstruction: { unlistedOrders: 0 }, engine: { transportAdmission: TRANSPORT_ADMISSION } });
    expect(summary.ticksSimulated).toBe(m0.cursor!.tick + 6 * config.ticksPerRound);
    expect(summary.outcomeNote).toBe(`No outcome: the 6-round limit stopped the game at tick ${summary.ticksSimulated}, before elimination or the 12000-tick objective limit. Scores are provisional; this short capped run is not a win or evidence of mastery.`);
    expect(Object.keys(summary)).toEqual(['schema', 'gameId', 'config', 'rounds', 'firstRoundTick', 'ticksSimulated', 'simulatedSeconds', 'outcome', 'stopReason', 'scoresStatus', 'outcomeNote', 'scores', 'controllers', 'orders', 'leadingSeatByRound', 'reconstruction', 'engine', 'sources', 'sourcesNote', 'claims']);
    expect(summary.config).toEqual(config);
    expect(summary.claims).toEqual(DUAL_CLAIMS);
    for (const seat of SEATS) {
      const o = summary.orders[seat], rs = m.history.map((h) => h.seats[seat]);
      expect(o).toEqual({ rounds: 6, holds: rs.filter((r) => r.choice === 'hold').length, submitted: rs.filter((r) => r.choice !== 'hold').length, executedAtTick: rs.filter((r) => r.executedKey).length, droppedAtTick: rs.filter((r) => r.droppedAtTick).length });
    }
    const final = readJson<DualCheckpoint>(dir, 'final/replay.json');
    const orders = final.record.turns.flatMap((t) => t.intents.map((i, idx) => ({ ...i, key: `${t.turnNumber}:${idx}:${i.clientID}` }))).filter((i) => i.type !== 'spawn');
    const listed = m.history.flatMap((h) => SEATS.filter((s) => h.seats[s].executedKey).map((s) => ({ key: h.seats[s].executedKey, intent: h.seats[s].intent })));
    expect(orders.map((o) => o.key).sort()).toEqual(listed.map((l) => l.key).sort());
    for (const o of orders) { const { key, clientID, ...intent } = o; expect(intent).toEqual(expect.objectContaining(listed.find((l) => l.key === key)!.intent)); }
    const restored = await ReplayEngine.restore(final.record, final.record.turns.length, 'checkpoints');
    expect(restored.state().fingerprint).toBe(summary.reconstruction.finalFingerprint);
    expect(summary.sources.map((s: { path: string }) => s.path)).toEqual(expect.arrayContaining(['rounds/00/blue/prompt.md', 'results/05/red/response.raw.json', 'initialization/game.json']));
    for (const f of files(dir).filter((f) => !f.endsWith('manifest.json'))) expect(fs.statSync(f).mode & 0o222).toBe(0);
    expect(await code(stepGame({ dir, ...writeReplies(staleDir, m1, 'late') }))).toBe('not-awaiting');

    // Determinism: a second game with the same seed and the same replies reaches the same states; only the game id differs.
    const twin = path.join(tmp, 'twin'); let t = await initGame({ dir: twin, config });
    expect(t.gameId).not.toBe(m0.gameId);
    for (const { m: rm, snaps } of rounds) {
      expect(t.cursor!.tick).toBe(rm.cursor!.tick);
      for (const seat of SEATS) { const ts = snapOf(twin, t, seat); expect(ts.fingerprint).toBe(snaps[seat].fingerprint); expect(ts.candidates).toEqual(snaps[seat].candidates); }
      t = await stepGame({ dir: twin, ...writeReplies(twin, t, `twin-${t.cursor!.round}`) });
    }
    expect(readJson<any>(twin, 'final/summary.json').reconstruction.finalFingerprint).toBe(summary.reconstruction.finalFingerprint);
    expect(readJson<DualCheckpoint>(twin, 'final/replay.json').record.turns).toEqual(final.record.turns);
  }, 300_000);
});

describe('dual-model full-game/1 (offline, deterministic replies)', () => {
  // Short cadences keep CPU down: every step replays the whole record, so an 8 x 45 game proves the >6-round bound cheaply.
  const capped: DualConfig = { mode: DUAL_FULL_GAME_MODE, maxRounds: 8, ticksPerRound: 45, seed: 'DUAL0001' };
  let pristine: string; let m0: DualManifest;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-model-full-'));
    pristine = path.join(tmp, 'pristine');
    m0 = await initGame({ dir: pristine, config: capped });
  }, 120_000);
  afterAll(cleanup);

  it('persists the versioned mode in the manifest and game record on the same seat contracts, and refuses edits to either', async () => {
    expect(m0).toMatchObject({ schema: DUAL_SCHEMA, config: capped, status: 'awaiting-responses', history: [] });
    expect(Object.keys(m0.config)).toEqual(['mode', 'maxRounds', 'ticksPerRound', 'seed']);
    const game = readJson<any>(pristine, 'initialization/game.json');
    expect(game).toMatchObject({ config: capped, opponentController: null, transportAdmission: TRANSPORT_ADMISSION, claims: claimsFor(capped) });
    expect(game.claims.horizon).toMatch(/full-game\/1\): at most 8 rounds of 45 ticks/);
    expect(gameStatus(pristine)).toMatchObject({ halted: null, manifest: { config: capped } });
    for (const seat of SEATS) {
      const s = snapOf(pristine, m0, seat);
      expect([s.seatContext, s.playerOutput, s.seat]).toEqual(['seat-context/1', 'player-output/1', seat]);
      expect(read(pristine, m0.cursor!.seats[seat].prompt)).toBe(renderSeatPrompt(s));
      expect(readJson(pristine, m0.cursor!.seats[seat].schema)).toEqual(playerOutputSchema());
    }

    const tampers: { name: string; manifest?: (c: any) => unknown; game?: (c: any) => unknown; message: RegExp }[] = [
      { name: 'drop-mode', manifest: ({ mode, ...c }) => c, message: /rounds must be an integer from 1 to 6/ },
      { name: 'drop-mode-both', manifest: ({ mode, ...c }) => ({ ...c, maxRounds: 6 }), game: ({ mode, ...c }) => ({ ...c, maxRounds: 6 }), message: /claims do not match/ },
      { name: 'mode-v2', manifest: (c) => ({ ...c, mode: 'full-game/2' }), message: /mode must be full-game\/1/ },
      { name: 'widen-manifest', manifest: (c) => ({ ...c, maxRounds: 45 }), message: /no longer matches/ },
      { name: 'widen-both', manifest: (c) => ({ ...c, maxRounds: 45 }), game: (c) => ({ ...c, maxRounds: 45 }), message: /claims do not match/ },
      { name: 'past-45', manifest: (c) => ({ ...c, maxRounds: 46 }), game: (c) => ({ ...c, maxRounds: 46 }), message: /from 1 to 45/ },
    ];
    for (const t of tampers) {
      const dir = copy(pristine, t.name);
      if (t.manifest) rewrite(dir, 'manifest.json', (v) => ({ ...v, config: t.manifest!(v.config) }));
      if (t.game) rewrite(dir, 'initialization/game.json', (v) => ({ ...v, config: t.game!(v.config) }));
      const before = tree(dir);
      await expect(stepGame({ dir, ...writeReplies(dir, m0, t.name) })).rejects.toMatchObject({ code: 'integrity', message: expect.stringMatching(t.message) });
      expect(() => gameStatus(dir)).toThrow(t.message);
      expect(tree(dir)).toEqual(before);
    }
  });

  it('plays past six rounds to the recorded bound: no outcome, provisional scores, every order listed and reconstructed', async () => {
    const dir = copy(pristine, 'capped');
    const m = await playOut(dir, m0, 'capped');
    expect(m).toMatchObject({ status: 'complete', cursor: null, config: capped });
    expect(m.history.map((h) => h.round)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const summary = readJson<any>(dir, 'final/summary.json');
    expect(summary).toMatchObject({ config: capped, rounds: 8, outcome: null, stopReason: 'round-limit', scoresStatus: 'provisional', claims: claimsFor(capped) });
    expect(summary.ticksSimulated).toBe(m0.cursor!.tick + 8 * 45);
    expect(summary.outcomeNote).toBe(`No outcome: the 8-round full-game/1 bound stopped the game at tick ${summary.ticksSimulated}, before elimination or the 12000-tick objective limit. Scores are provisional; this capped run is not a win or evidence of mastery.`);
    expect(Object.keys(summary)).toEqual(['schema', 'gameId', 'config', 'rounds', 'firstRoundTick', 'ticksSimulated', 'simulatedSeconds', 'outcome', 'stopReason', 'scoresStatus', 'outcomeNote', 'scores', 'controllers', 'orders', 'leadingSeatByRound', 'reconstruction', 'engine', 'sources', 'sourcesNote', 'claims']);
    await expectListedAndReconstructed(dir, m, summary);
    // Rounds 6 and 7 exist only because of the recorded mode; a ninth step is refused.
    expect(fs.existsSync(path.join(dir, 'results/07/outcome.json'))).toBe(true);
    expect(await code(stepGame({ dir, ...writeReplies(pristine, m0, 'capped-late') }))).toBe('not-awaiting');
  }, 120_000);

  it('stops at the normal objective limit before the round bound', async () => {
    // 900-tick rounds reach the 12000-tick objective limit on round 14 of a 45-round bound.
    const config: DualConfig = { mode: DUAL_FULL_GAME_MODE, maxRounds: FULL_GAME_MAX_ROUNDS, ticksPerRound: 900, seed: 'DUAL0001' };
    const dir = path.join(tmp, 'objective-limit');
    const m = await playOut(dir, await initGame({ dir, config }), 'limit');
    const summary = readJson<any>(dir, 'final/summary.json');
    expect(m).toMatchObject({ status: 'complete', cursor: null });
    expect(summary).toMatchObject({ config, stopReason: 'game-outcome', scoresStatus: 'final', claims: claimsFor(config) });
    expect(summary.outcome).not.toBeNull();
    expect(summary.outcome.scores).toEqual(summary.scores);
    expect(summary.outcomeNote).toBe(`Game outcome reached inside the bound (${summary.outcome.reason}).`);
    // Deterministic with these replies: neither seat is eliminated, and the last round is cut to the limit tick.
    expect([summary.outcome.reason, summary.ticksSimulated, summary.rounds]).toEqual(['time-limit', 12000, 14]);
    expect(m.history.at(-1)!.endTick - m.history.at(-1)!.tick).toBeLessThan(config.ticksPerRound);
    expect(readJson<any>(dir, `${m.history.at(-1)!.result}/outcome.json`).outcome).toEqual(summary.outcome);
    expect(m.history.at(-1)!.endTick).toBe(summary.ticksSimulated);
    for (const h of m.history.slice(0, -1)) expect(readJson<any>(dir, `${h.result}/outcome.json`).outcome).toBeNull();
    await expectListedAndReconstructed(dir, m, summary);
  }, 300_000);
});

describe('dual-model taiwan-strait/1 scenario (offline, deterministic replies)', () => {
  const TAIWAN = 'taiwan-strait/1' as const;
  const GAME = 'initialization/game.json';
  const config: DualConfig = { maxRounds: 3, ticksPerRound: 270, seed: 'DUAL0001', scenario: TAIWAN };
  const scenario = selectScenario(TAIWAN);
  const SUMMARY_KEYS = ['schema', 'gameId', 'config', 'rounds', 'firstRoundTick', 'ticksSimulated', 'simulatedSeconds', 'outcome', 'stopReason', 'scoresStatus', 'outcomeNote', 'scores', 'controllers', 'orders', 'leadingSeatByRound', 'reconstruction', 'engine', 'sources', 'sourcesNote', 'claims'];
  const sha256 = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
  let pristine: string; let m0: DualManifest; let world: string; let w0: DualManifest;
  const restoreAt = async (dir: string, p: string) => { const cp = readJson<DualCheckpoint>(dir, p); return { cp, e: await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints') }; };
  const spawnTiles = (cp: DualCheckpoint) => Object.fromEntries(SEATS.map((s) => [s, (cp.record.turns[0]!.intents.find((i) => i.type === 'spawn' && i.clientID === CLIENTS[s]) as unknown as { tile: number }).tile])) as Record<Side, number>;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-model-taiwan-'));
    pristine = path.join(tmp, 'pristine'); world = path.join(tmp, 'world');
    m0 = await initGame({ dir: pristine, config });
    w0 = await initGame({ dir: world, config: { maxRounds: 1, ticksPerRound: 270, seed: 'DUAL0001' } });
  }, 180_000);
  afterAll(cleanup);

  it('plays the actual catalog map, spawns and relay board, with recorded provenance that differs from the default game', async () => {
    expect(m0.config).toEqual(config);
    const game = readJson<any>(pristine, GAME);
    expect(Object.keys(game)).toEqual(['schema', 'gameId', 'createdAt', 'config', 'scenarioId', 'map', 'scenario', 'transportAdmission', 'engine', 'deploymentFromTick', 'firstRoundTick', 'seats', 'opponentController', 'claims']);
    expect(game).toMatchObject({ scenarioId: TAIWAN, map: 'taiwan-strait-400', opponentController: null, claims: claimsFor(config) });
    expect(game.scenario).toMatchObject({ context: DUAL_SCENARIO_CONTEXT, id: TAIWAN, map: 'taiwan-strait-400', spawn: scenario.spawn, objectiveRules: 'strait-stations-and-reserves/1', objectiveRulesSha256: sha256(JSON.stringify(STRAIT_NETWORK_RULES)), catalogController: 'objectives/1', controllerUsed: null, redCell: { profile: STRAIT_RED_CELL_VERSION, seat: 'red', instructionsSha256: sha256(straitRedCellInstructions()) } });
    expect(game.scenario.objectiveRulesSha256).not.toBe(sha256(JSON.stringify(NETWORK_RULES)));
    // Source provenance: every listed file with its current sha256.
    expect(game.scenario.sources).toEqual(SCENARIO_SOURCE_FILES.map((p) => ({ path: p, sha256: sha256(fs.readFileSync(p)) })).sort((a, b) => a.path.localeCompare(b.path)));

    const t = await restoreAt(pristine, 'rounds/00/replay.json'), d = await restoreAt(world, 'rounds/00/replay.json');
    // Engine terrain: the restored record is the Taiwan map, not world-500.
    expect([t.cp.record.options.map, d.cp.record.options.map]).toEqual(['taiwan-strait-400', 'world-500']);
    expect(game.scenario.terrain).toMatchObject({ width: t.e.game.width(), height: t.e.game.height() });
    expect([t.e.game.width(), t.e.game.height()]).not.toEqual([d.e.game.width(), d.e.game.height()]);
    // Initial positions: the engine's own target for the catalog fractions, recorded, and unlike the default game.
    const expected = Object.fromEntries(SEATS.map((s) => [s, spawnTarget(t.e.game, ...scenario.spawn[s])]));
    expect(spawnTiles(t.cp)).toEqual(expected);
    expect(game.scenario.spawnTiles).toEqual(expected);
    const xy = (e: ReplayEngine, tile: number) => [e.game.x(tile), e.game.y(tile)];
    expect(SEATS.map((s) => xy(t.e, spawnTiles(t.cp)[s]))).not.toEqual(SEATS.map((s) => xy(d.e, spawnTiles(d.cp)[s])));
    // Deployment still issued no orders.
    expect(t.cp.record.turns.flatMap((x) => x.intents).map((i) => i.type)).toEqual(['spawn', 'spawn']);

    const blue = snapOf(pristine, m0, 'blue'), red = snapOf(pristine, m0, 'red'), wb = snapOf(world, w0, 'blue');
    // Objectives: both seats see the strait relay board; the default game keeps the original stations.
    const board = (s: SeatSnapshot) => (s.observation.objectiveBoard as { stations: { name: string }[] }).stations.map((x) => x.name);
    expect(board(blue)).toEqual(STRAIT_NETWORK_RULES.stations.map((x) => x.name));
    expect(board(red)).toEqual(board(blue));
    expect(board(wb)).toEqual(NETWORK_RULES.stations.map((x) => x.name));
    expect(game.scenario.stationLayout.map((x: { name: string }) => x.name)).toEqual(board(blue));

    // Same pre-order state; public scenario context for both; the Red Cell brief for Red only.
    expect([blue.fingerprint, blue.tick]).toEqual([red.fingerprint, red.tick]);
    expect(blue.fingerprint).toBe(t.e.state().fingerprint);
    expect(blue.observation.scenario).toEqual(red.observation.scenario);
    expect(blue.observation.scenario).toMatchObject({ context: DUAL_SCENARIO_CONTEXT, id: TAIWAN, map: 'taiwan-strait-400', objectives: { rules: 'strait-stations-and-reserves/1' } });
    expect(red.observation.redCell).toMatchObject({ profile: STRAIT_RED_CELL_VERSION, visibility: 'red seat only', instructions: straitRedCellInstructions(), publicBrief: JSON.parse(JSON.stringify(straitRedCellPublicBrief())), provenance: { instructionsSha256: game.scenario.redCell.instructionsSha256, publicBriefSha256: game.scenario.redCell.publicBriefSha256 } });
    expect(blue.observation).not.toHaveProperty('redCell');
    const blueText = read(pristine, m0.cursor!.seats.blue.snapshot) + read(pristine, m0.cursor!.seats.blue.prompt);
    for (const leak of ['strait-red-cell', 'redCell', 'Strait Red Cell', straitRedCellInstructions().split('\n')[1]!]) expect(blueText).not.toContain(leak);
    expect(read(pristine, m0.cursor!.seats.red.prompt)).toContain(`Strait Red Cell brief (${STRAIT_RED_CELL_VERSION}, Red seat only)`);
    for (const seat of SEATS) expect(read(pristine, m0.cursor!.seats[seat].prompt)).toBe(renderDualPrompt(snapOf(pristine, m0, seat), scenario));
    expect(blue.observation.game).toMatch(/recognizable real geography/);

    // The default game is untouched by the scenario layer.
    const wgame = readJson<any>(world, GAME);
    expect(wgame).not.toHaveProperty('scenario');
    expect(wgame.claims).toEqual(DUAL_CLAIMS);
    for (const seat of SEATS) { const s = snapOf(world, w0, seat); expect(s.observation).not.toHaveProperty('scenario'); expect(s.observation).not.toHaveProperty('redCell'); expect(read(world, w0.cursor!.seats[seat].prompt)).toBe(renderSeatPrompt(s)); }
    expect(gameStatus(pristine)).toMatchObject({ halted: null, manifest: { config } });
  }, 120_000);

  it('refuses scenario conversion and modified scenario records or seat context, writing nothing', async () => {
    const reSnap = (dir: string, seat: Side, edit: (obs: Record<string, unknown>) => void) => {
      const p = m0.cursor!.seats[seat].snapshot; let id = '';
      rewrite(dir, p, (s: SeatSnapshot) => { edit(s.observation); const { snapshotId: _, ...rest } = s; id = seatSnapshotId(rest); return { ...rest, snapshotId: id }; });
      rewrite(dir, 'rounds/00/round.json', (r) => ({ ...r, snapshotIds: { ...r.snapshotIds, [seat]: id } }));
    };
    const { scenario: _drop, ...plain } = config;
    const worldAsTaiwan: DualConfig = { maxRounds: 1, ticksPerRound: 270, seed: 'DUAL0001', scenario: TAIWAN };
    const tampers: { name: string; from?: 'world'; edit: (dir: string) => void; message: RegExp; statusToo: boolean }[] = [
      { name: 'drop-scenario-manifest', edit: (d) => rewrite(d, 'manifest.json', (v) => ({ ...v, config: plain })), message: /no longer matches/, statusToo: true },
      { name: 'drop-scenario-both', edit: (d) => { rewrite(d, 'manifest.json', (v) => ({ ...v, config: plain })); rewrite(d, GAME, (v) => ({ ...v, config: plain })); }, message: /claims do not match/, statusToo: true },
      { name: 'drop-scenario-all', edit: (d) => { rewrite(d, 'manifest.json', (v) => ({ ...v, config: plain })); rewrite(d, GAME, (v) => ({ ...v, config: plain, claims: DUAL_CLAIMS })); }, message: /is not the recorded crosscurrent-objectives\/1/, statusToo: true },
      { name: 'world-to-taiwan', from: 'world', edit: (d) => { rewrite(d, 'manifest.json', (v) => ({ ...v, config: worldAsTaiwan })); rewrite(d, GAME, (v) => ({ ...v, config: worldAsTaiwan, claims: claimsFor(worldAsTaiwan) })); }, message: /is not the recorded taiwan-strait\/1/, statusToo: true },
      { name: 'unknown-scenario', edit: (d) => { const c = { ...config, scenario: 'taiwan-strait/2' }; rewrite(d, 'manifest.json', (v) => ({ ...v, config: c })); rewrite(d, GAME, (v) => ({ ...v, config: c })); }, message: /scenario must be one of taiwan-strait\/1/, statusToo: true },
      { name: 'brief-hash', edit: (d) => rewrite(d, GAME, (v) => ({ ...v, scenario: { ...v.scenario, redCell: { ...v.scenario.redCell, instructionsSha256: '0'.repeat(64) } } })), message: /scenario record differs/, statusToo: true },
      { name: 'spawn', edit: (d) => rewrite(d, GAME, (v) => ({ ...v, scenario: { ...v.scenario, spawn: { ...v.scenario.spawn, red: [0.5, 0.5] } } })), message: /scenario record differs/, statusToo: true },
      { name: 'relay-rules', edit: (d) => rewrite(d, GAME, (v) => ({ ...v, scenario: { ...v.scenario, objectiveRules: 'stations-and-reserves/1' } })), message: /scenario record differs/, statusToo: true },
      { name: 'terrain', edit: (d) => rewrite(d, GAME, (v) => ({ ...v, scenario: { ...v.scenario, terrain: { ...v.scenario.terrain, landTiles: v.scenario.terrain.landTiles + 1 } } })), message: /terrain, spawns or relay layout differ/, statusToo: false },
      { name: 'spawn-tiles', edit: (d) => rewrite(d, GAME, (v) => ({ ...v, scenario: { ...v.scenario, spawnTiles: { ...v.scenario.spawnTiles, blue: v.scenario.spawnTiles.blue + 1 } } })), message: /terrain, spawns or relay layout differ/, statusToo: false },
      { name: 'red-brief-removed', edit: (d) => reSnap(d, 'red', (o) => { delete o.redCell; }), message: /scenario context is not the taiwan-strait\/1 context for red/, statusToo: false },
      { name: 'red-brief-edited', edit: (d) => reSnap(d, 'red', (o) => { (o.redCell as { instructions: string }).instructions += ' Blue will hold.'; }), message: /scenario context is not/, statusToo: false },
      { name: 'blue-given-brief', edit: (d) => reSnap(d, 'blue', (o) => { o.redCell = snapOf(pristine, m0, 'red').observation.redCell; }), message: /scenario context is not the taiwan-strait\/1 context for blue/, statusToo: false },
      { name: 'prompt-without-brief', edit: (d) => { const f = path.join(d, m0.cursor!.seats.red.prompt); fs.chmodSync(f, 0o644); fs.writeFileSync(f, renderSeatPrompt(snapOf(pristine, m0, 'red'))); }, message: /differs from the prompt/, statusToo: false },
    ];
    for (const t of tampers) {
      const dir = copy(t.from === 'world' ? world : pristine, `tamper-${t.name}`);
      t.edit(dir);
      const before = tree(dir), m = t.from === 'world' ? w0 : m0;
      await expect(stepGame({ dir, ...writeReplies(dir, m, t.name) }), t.name).rejects.toMatchObject({ code: 'integrity', message: expect.stringMatching(t.message) });
      if (t.statusToo) expect(() => gameStatus(dir), t.name).toThrow(t.message); else expect(() => gameStatus(dir), t.name).not.toThrow();
      expect(tree(dir)).toEqual(before);
    }
  }, 300_000);

  it('plays same-prestate rounds with an alternating queue, private histories, a Red-only brief and reconstruction', async () => {
    const dir = copy(pristine, 'play');
    const m = await playOut(dir, m0, 'tw');
    expect(m).toMatchObject({ status: 'complete', cursor: null, config });
    expect(m.history.map((h) => h.queue)).toEqual([['blue', 'red'], ['red', 'blue'], ['blue', 'red']]);
    const brief = snapOf(pristine, m0, 'red').observation.redCell;
    for (let k = 0; k < 3; k++) {
      const cur = { blue: readJson<SeatSnapshot>(dir, `rounds/0${k}/blue/snapshot.json`), red: readJson<SeatSnapshot>(dir, `rounds/0${k}/red/snapshot.json`) };
      expect(cur.blue.fingerprint).toBe(cur.red.fingerprint);
      expect(cur.red.observation.redCell).toEqual(brief);
      for (const seat of SEATS) {
        const other = seat === 'blue' ? 'red' : 'blue';
        const text = read(dir, `rounds/0${k}/${seat}/snapshot.json`) + read(dir, `rounds/0${k}/${seat}/prompt.md`);
        for (let j = 0; j < k; j++) { expect(text).not.toContain(secret(other, j)); expect(text).not.toContain(secret(seat, j)); expect(text).not.toContain(m.history[j]!.seats[other].snapshotId); }
        expect((cur[seat].observation.previousDecisions as unknown[]).length).toBe(k);
        if (seat === 'blue') for (const leak of ['strait-red-cell', 'redCell']) expect(text).not.toContain(leak);
      }
    }
    const summary = readJson<any>(dir, 'final/summary.json');
    expect(Object.keys(summary)).toEqual([...SUMMARY_KEYS, 'scenario']);
    expect(summary).toMatchObject({ config, rounds: 3, stopReason: 'round-limit', outcome: null, scoresStatus: 'provisional', claims: claimsFor(config) });
    expect(summary.scenario).toEqual(readJson<any>(dir, GAME).scenario);
    expect(summary.ticksSimulated).toBe(m0.cursor!.tick + 3 * 270);
    await expectListedAndReconstructed(dir, m, summary);
    expect(readJson<DualCheckpoint>(dir, 'final/replay.json').record.options.map).toBe('taiwan-strait-400');
  }, 300_000);

  it('runs full-game/1 on Taiwan past six rounds under the same scenario record', async () => {
    const capped: DualConfig = { mode: DUAL_FULL_GAME_MODE, maxRounds: 7, ticksPerRound: 45, seed: 'DUAL0001', scenario: TAIWAN };
    const dir = path.join(tmp, 'full');
    const m = await playOut(dir, await initGame({ dir, config: capped }), 'twfull');
    const summary = readJson<any>(dir, 'final/summary.json');
    expect(summary).toMatchObject({ config: capped, rounds: 7, stopReason: 'round-limit', claims: { mode: DUAL_FULL_GAME_MODE, scenarioId: TAIWAN } });
    expect(summary.scenario).toEqual(readJson<any>(dir, GAME).scenario);
    expect(m.history).toHaveLength(7);
  }, 300_000);
});

describe('dual-model round-feedback/2 observation profile (offline, deterministic replies)', () => {
  const PROFILE = ROUND_FEEDBACK_PROFILE;
  const usage = (argv: string[]) => { try { parseDualArgs(argv); return 'accepted'; } catch (err) { return (err as DualRejection).code; } };
  // 7 rounds past the 5-order window; 45-tick rounds keep CPU down.
  const config: DualConfig = { mode: DUAL_FULL_GAME_MODE, maxRounds: 7, ticksPerRound: 45, seed: 'DUAL0001', observationProfile: PROFILE };
  let pristine: string; let m0: DualManifest;
  /** Rotates hold, troop, structure and transport picks per seat so feedback covers every admission and observation kind the menu offers. */
  const varied = (s: SeatSnapshot, k: number) => {
    const troop = pick(s), kind = (['hold', 'troop', 'build_unit', 'boat'] as const)[(k + (s.seat === 'red' ? 1 : 0)) % 4];
    if (kind === 'hold') return { choice: 'hold' as const, share: null };
    const c = kind === 'troop' ? null : s.candidates.find((x) => x.intent.type === kind);
    return !c ? troop : { choice: c.index, share: c.troopOptions ? 0.2 : null };
  };
  const variedReplies = (dir: string, m: DualManifest, tag: string) => {
    const out = {} as Record<Side, string>;
    for (const seat of SEATS) { const s = snapOf(dir, m, seat), p = varied(s, m.cursor!.round); out[seat] = path.join(tmp, `${tag}-${seat}.json`); fs.writeFileSync(out[seat], reply(s, p.choice, p.share, secret(seat, m.cursor!.round))); }
    return { blueResponse: out.blue, redResponse: out.red };
  };
  type Ctx = { profile: string; turnOrder: { decision: number; queue: Side[]; next: { decision: number; queue: Side[] }; rule: string }; advance: { fromTick: number; toTick: number; ticksPerDecision: number; rule: string }; ownOrders: { window: number; orders: any[]; note: string }; recentBoard: { window: number; rows: any[]; note: string } };
  const ctxOf = (s: SeatSnapshot) => s.observation.roundContext as Ctx;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-model-feedback-'));
    pristine = path.join(tmp, 'pristine');
    m0 = await initGame({ dir: pristine, config });
  }, 120_000);
  afterAll(cleanup);

  it('opts in only with --observation-profile feedback-v2, records the canonical value last and refuses anything else before creating a game', async () => {
    const short = parseDualArgs(['init', '--dir', 'g', '--observation-profile', 'feedback-v2']).config!;
    expect(short).toEqual({ maxRounds: 6, ticksPerRound: 270, seed: 'DUAL0001', observationProfile: PROFILE });
    expect(Object.keys(parseDualArgs(['init', '--dir', 'g', '--mode', 'full-game', '--scenario', 'taiwan-strait/1', '--observation-profile', 'feedback-v2']).config!)).toEqual(['mode', 'maxRounds', 'ticksPerRound', 'seed', 'scenario', 'observationProfile']);
    // Without the flag: exactly the original config keys.
    expect(Object.keys(parseDualArgs(['init', '--dir', 'g']).config!)).toEqual(['maxRounds', 'ticksPerRound', 'seed']);
    for (const bad of [['--observation-profile', 'round-feedback/2'], ['--observation-profile', 'feedback-v1'], ['--observation-profile', 'FEEDBACK-V2'], ['--observation-profile', ''], ['--observation-profile'], ['--observation-profile', 'feedback-v2', '--observation-profile', 'feedback-v2'], ['--observation-profile', 'constructor'], ['--observation-profile', 'feedback-v2', '--rounds', '7']]) expect(usage(['init', '--dir', 'g', ...bad])).toBe('usage');
    expect(usage(['step', '--dir', 'g', '--observation-profile', 'feedback-v2', '--blue-response', 'b.json', '--red-response', 'r.json'])).toBe('usage');
    expect(usage(['status', '--dir', 'g', '--observation-profile', 'feedback-v2'])).toBe('usage');
    expect(() => checkDualConfig(short)).not.toThrow();
    for (const bad of [{ ...short, observationProfile: 'round-feedback/1' }, { ...short, observationProfile: 'feedback-v2' }, { ...short, observationProfile: null }]) expect(() => checkDualConfig(bad)).toThrow(/observationProfile must be round-feedback\/2/);
    // Claims: unchanged object without the profile; the profile adds its id and statement last.
    expect(claimsFor({ maxRounds: 6, ticksPerRound: 270, seed: 'A' })).toBe(DUAL_CLAIMS);
    expect(claimsFor(short as DualConfig)).toEqual({ ...DUAL_CLAIMS, observationProfile: PROFILE, observation: ROUND_FEEDBACK_CLAIM });
    expect(ROUND_FEEDBACK_CLAIM).toMatch(/not evidence of stronger play/);
    const dir = path.join(os.tmpdir(), `dual-model-refused-profile-${process.pid}`);
    expect(await code(initGame({ dir, config: { ...short, observationProfile: 'round-feedback/3' } as unknown as DualConfig }))).toBe('usage');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('rebuilds a freshly generated no-flag game byte for byte: no round context, original prompts', async () => {
    // Public deterministic fixture generated in this test; no optional historical branch.
    const fresh = path.join(tmp, 'legacy'); let lm = await initGame({ dir: fresh, config: { maxRounds: 2, ticksPerRound: 45, seed: 'DUAL0001' } });
    lm = await stepGame({ dir: fresh, ...writeReplies(fresh, lm, 'legacy') });

    for (const dir of [fresh]) {
      const m = gameStatus(dir).manifest, last = m.cursor ? m.cursor.round : m.history.length - 1;
      expect(m.config).not.toHaveProperty('observationProfile');
      for (const k of [...new Set([0, 1, last])]) {
        const rebuilt = await rebuildSavedRound(dir, k);
        for (const seat of SEATS) {
          expect(rebuilt[seat].snapshot, `${dir} ${k} ${seat}`).toBe(read(dir, `rounds/${String(k).padStart(2, '0')}/${seat}/snapshot.json`));
          expect(rebuilt[seat].prompt, `${dir} ${k} ${seat}`).toBe(read(dir, `rounds/${String(k).padStart(2, '0')}/${seat}/prompt.md`));
          expect(rebuilt[seat].snapshot).not.toContain('roundContext');
        }
      }
    }
  }, 600_000);

  it('gives both seats the same public queue and advance rule, only their own released feedback and board rows, and no private opponent data', async () => {
    const dir = copy(pristine, 'play');
    let m = m0;
    const played: { k: number; snaps: Record<Side, SeatSnapshot> }[] = [];
    while (m.status === 'awaiting-responses') {
      const k = m.cursor!.round, snaps = { blue: snapOf(dir, m, 'blue'), red: snapOf(dir, m, 'red') };
      played.push({ k, snaps });
      m = await stepGame({ dir, ...variedReplies(dir, m, `fb-${k}`) });
    }
    expect(m.history).toHaveLength(7);
    expect(readJson<any>(dir, 'final/summary.json')).toMatchObject({ config, claims: claimsFor(config) });
    const outcome = (k: number) => readJson<{ feedback: Record<Side, { key: string; tick: number; status: string }[]> }>(dir, `results/0${k}/outcome.json`);
    const kinds = new Set<string>();

    for (const { k, snaps } of played) {
      const blue = ctxOf(snaps.blue), red = ctxOf(snaps.red);
      // Even/odd queue: Blue leads even rounds (odd decisions), Red leads odd rounds; identical public fields for both seats.
      const queue = k % 2 === 0 ? ['blue', 'red'] : ['red', 'blue'];
      expect(blue.turnOrder).toEqual(red.turnOrder);
      expect(blue.advance).toEqual(red.advance);
      expect([blue.profile, blue.turnOrder.decision, blue.turnOrder.queue, blue.turnOrder.next.queue]).toEqual([PROFILE, k + 1, queue, [...queue].reverse()]);
      expect(m.history[k]!.queue).toEqual(queue);
      // The advance rule is what the engine then did.
      expect([blue.advance.fromTick, blue.advance.toTick, blue.advance.ticksPerDecision]).toEqual([m.history[k]!.tick, m.history[k]!.endTick, 45]);
      for (const seat of SEATS) {
        const other = seat === 'blue' ? 'red' : 'blue', s = snaps[seat], ctx = ctxOf(s);
        const prompt = read(dir, `rounds/0${k}/${seat}/prompt.md`);
        expect(prompt).toBe(renderDualPrompt(s, null, PROFILE));
        expect(prompt).toContain(`## Round context (${PROFILE})`);
        expect(prompt).toContain(`This decision's queue: ${queue[0] === 'blue' ? 'Blue' : 'Red'}'s admitted order enters the engine turn first`);
        expect(Object.keys(s.observation).at(-1)).toBe('roundContext');
        // Only prior own orders, bounded to the window, each with its own released statuses.
        const own = m.history.slice(0, k).slice(-OWN_ORDER_WINDOW);
        expect(ctx.ownOrders.orders.map((o) => o.decision)).toEqual(own.map((h) => h.round + 1));
        const released = Array.from({ length: k }, (_, j) => outcome(j).feedback[seat]).flat();
        ctx.ownOrders.orders.forEach((o, i) => {
          const r = own[i]!.seats[seat];
          expect([o.choice, o.share, o.meaning, o.droppedReason]).toEqual([r.choice, r.share, r.meaning, r.droppedAtTick]);
          expect(o.admission).toBe(r.choice === 'hold' ? 'hold' : r.executedKey ? 'admitted' : 'dropped');
          expect(o.queuePlace).toBe(r.choice === 'hold' ? null : own[i]!.queue[0] === seat ? 'first' : 'second');
          const expectedKind = r.intent === null ? null : r.intent.type === 'boat' ? 'transport' : r.intent.type === 'build_unit' && ['City', 'Defense Post', 'Port'].includes(r.intent.unit as string) ? 'construction' : 'not-observed';
          expect(o.observed).toBe(expectedKind); kinds.add(`${o.admission}:${o.observed}`);
          if (o.observed === 'not-observed') expect([o.statuses, o.latestStatus]).toEqual([null, null]);
          else {
            // Never fabricated: exactly the released statuses for this seat's own key, and no latest status without one.
            const mine = released.filter((f) => f.key === r.executedKey).map(({ status, tick }) => ({ status, tick }));
            expect(o.statuses).toEqual(mine);
            expect(o.latestStatus).toBe(mine.at(-1)?.status ?? null);
          }
          expect(Object.keys(o)).not.toContain('executedKey');
        });
        // Board rows: this seat's own saved observations (up to 3 earlier) then now.
        const earlier = played.filter((p) => p.k < k).slice(-BOARD_WINDOW).map((p) => p.snaps[seat].observation as any);
        const row = (o: any) => ({ decision: o.decision, tick: o.tick, scores: o.objectiveBoard.scores, own: { tiles: o.ownResources.tiles, troops: o.ownResources.troops, gold: o.ownResources.gold, structures: o.ownResources.structures }, opponentPublic: o.opponentPublic && { tiles: o.opponentPublic.tiles, troops: o.opponentPublic.troops, structures: o.opponentPublic.structures, alive: o.opponentPublic.alive } });
        expect(ctx.recentBoard.rows).toEqual([...earlier, s.observation].map(row));
        expect(ctx.recentBoard.note).toMatch(/not the effect of any single order and are not attributed to one/);
        expect(ctx.ownOrders.note).toMatch(/not evidence it had any effect/);
        // No opponent private data: no rationale (either seat), no opponent snapshot id, order key, choice meaning or queued intent.
        const text = read(dir, `rounds/0${k}/${seat}/snapshot.json`) + prompt;
        for (let j = 0; j < k; j++) {
          for (const leak of [secret(other, j), secret(seat, j), m.history[j]!.seats[other].snapshotId]) expect(text).not.toContain(leak);
          const key = m.history[j]!.seats[other].executedKey; if (key) expect(text).not.toContain(key);
        }
        expect(JSON.stringify(ctx)).not.toContain(CLIENTS[other]);
        expect(JSON.stringify(ctx)).not.toContain('rationale');
      }
    }
    // The window bound held at the last round, and the fixture covered holds plus observed and unobserved admitted orders.
    expect(ctxOf(played.at(-1)!.snaps.blue).ownOrders.orders).toHaveLength(OWN_ORDER_WINDOW);
    expect(ctxOf(played.at(-1)!.snaps.red).recentBoard.rows).toHaveLength(BOARD_WINDOW + 1);
    expect(kinds.has('hold:null')).toBe(true);
    expect(kinds.has('admitted:not-observed')).toBe(true);
    // Profiled games rebuild byte for byte too.
    for (const k of [0, 6]) { const r = await rebuildSavedRound(dir, k); for (const seat of SEATS) expect(r[seat].snapshot).toBe(read(dir, `rounds/0${k}/${seat}/snapshot.json`)); }
  }, 300_000);

  it('binds every step to the recorded profile: removed context, relabelled configs and edited feedback are refused with nothing written', async () => {
    const dir0 = copy(pristine, 'bind-base');
    const m1 = await stepGame({ dir: dir0, ...variedReplies(dir0, m0, 'bind-0') });
    const p = m1.cursor!.seats.red.snapshot;
    // A consistent forgery: recomputed id, round.json and a prompt rendered from the edited snapshot, so only the rebuild can refuse it.
    const reSnap = (dir: string, edit: (obs: Record<string, unknown>) => void) => {
      let forged: SeatSnapshot | null = null;
      rewrite(dir, p, (s: SeatSnapshot) => { edit(s.observation); const { snapshotId: _, ...rest } = s; forged = { ...rest, snapshotId: seatSnapshotId(rest) }; return forged; });
      rewrite(dir, 'rounds/01/round.json', (r) => ({ ...r, snapshotIds: { ...r.snapshotIds, red: forged!.snapshotId } }));
      const f = path.join(dir, m1.cursor!.seats.red.prompt); fs.chmodSync(f, 0o644);
      fs.writeFileSync(f, 'roundContext' in forged!.observation ? renderDualPrompt(forged!, null, PROFILE) : renderSeatPrompt(forged!));
    };
    const { observationProfile: _drop, ...plain } = config;
    const tampers: { name: string; edit: (dir: string) => void; message: RegExp; statusToo: boolean }[] = [
      { name: 'context-removed', edit: (d) => reSnap(d, (o) => { delete o.roundContext; }), message: /round context does not match the recorded round-feedback\/2/, statusToo: false },
      { name: 'queue-edited', edit: (d) => reSnap(d, (o) => { (o.roundContext as Ctx).turnOrder.queue.reverse(); }), message: /rebuilt round 1 snapshots differ/, statusToo: false },
      { name: 'feedback-fabricated', edit: (d) => reSnap(d, (o) => { (o.roundContext as Ctx).ownOrders.orders.forEach((x) => { x.latestStatus = 'construction-completed'; }); }), message: /rebuilt round 1 snapshots differ/, statusToo: false },
      { name: 'profile-dropped-manifest', edit: (d) => rewrite(d, 'manifest.json', (v) => ({ ...v, config: plain })), message: /no longer matches/, statusToo: true },
      { name: 'profile-dropped-all', edit: (d) => { rewrite(d, 'manifest.json', (v) => ({ ...v, config: plain })); rewrite(d, 'initialization/game.json', (v) => ({ ...v, config: plain, claims: claimsFor(plain as DualConfig) })); }, message: /round context does not match the recorded original/, statusToo: false },
      { name: 'profile-unknown', edit: (d) => { const c = { ...config, observationProfile: 'round-feedback/3' }; rewrite(d, 'manifest.json', (v) => ({ ...v, config: c })); rewrite(d, 'initialization/game.json', (v) => ({ ...v, config: c })); }, message: /observationProfile must be round-feedback\/2/, statusToo: true },
    ];
    for (const t of tampers) {
      const dir = copy(dir0, `bind-${t.name}`);
      t.edit(dir);
      const before = tree(dir);
      await expect(stepGame({ dir, ...variedReplies(dir, m1, t.name) }), t.name).rejects.toMatchObject({ code: 'integrity', message: expect.stringMatching(t.message) });
      if (t.statusToo) expect(() => gameStatus(dir), t.name).toThrow(t.message); else expect(() => gameStatus(dir), t.name).not.toThrow();
      expect(tree(dir)).toEqual(before);
    }
  }, 300_000);
});
