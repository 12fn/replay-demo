import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createNetworkLayout, networkView } from '../../src/campaign/network';
import { ReplayEngine, TRANSPORT_ADMISSION, type Side } from '../../src/engine/engine';
import { MODEL_SIDE, PLAYER_OUTPUT, SEAT_CONTEXT, SEAT_SNAPSHOT_SCHEMA, TROOP_SHARES, TrialRejection, buildSeatSnapshot, checkSeatSnapshot, choiceIntent, parseSeatChoice, playerOutputSchema, publicAccess, renderPrompt, renderSeatPrompt, seatSnapshotAtCheckpoint, seatSnapshotId, snapshotAtCheckpoint, type Checkpoint, type Manifest, type SeatPreviousDecision, type SeatSnapshot, type SeatSnapshotInput, type Snapshot, type TrialConfig } from '../../scripts/ai-player-trial';

// Read-only saved checkpoints (tick 1125); no new game is initialized in this file.
const EVIDENCE = path.resolve(__dirname, '../fixtures/player-context-legacy');
const load = (run: string) => {
  const f = (p: string) => fs.readFileSync(path.join(EVIDENCE, run, p), 'utf8');
  return { manifest: JSON.parse(f('manifest.json')) as Manifest, snap: JSON.parse(f('decisions/04/snapshot.json')) as Snapshot, prompt: f('decisions/04/prompt.md'), cp: JSON.parse(f('decisions/04/replay.json')) as Checkpoint };
};
const RUNS = ['equal-opus-20260915', 'equal-sol-20260915'] as const;
const cadence = { ownTicksPerDecision: 270, opponentTicksPerDecision: 270 };
const code = (f: () => unknown) => { try { f(); } catch (err) { return err instanceof TrialRejection ? err.code : `other: ${(err as Error).message}`; } return 'accepted'; };
const reply = (s: { snapshotId: string }, choice: number | 'hold', share: number | null, extra: Record<string, unknown> = {}) => JSON.stringify({ snapshotId: s.snapshotId, choice, share, rationale: 'fixture', ...extra });
const restore = (cp: Checkpoint) => ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints');
const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };

type Resources = { side: Side; troops: number; gold: number; tiles: number; maxTroops: number };
type Public = { side: Side; troops: number; tiles: number; alive: boolean };

describe('seat-context/1 (Red seat prerequisite; not an AI-vs-AI run)', () => {
  const { manifest, snap, prompt, cp } = load('equal-opus-20260915');
  const gameId = 'seat-fixture-opus';
  let e: ReplayEngine; let red: SeatSnapshot; let blue: SeatSnapshot;
  const input = (seat: Side, extra: Partial<SeatSnapshotInput> = {}): SeatSnapshotInput => ({ engine: e, network: cp.network, gameId, seat, decision: 4, cadence, ...extra });

  beforeAll(async () => {
    e = await restore(cp);
    red = buildSeatSnapshot(input('red')); blue = buildSeatSnapshot(input('blue'));
  }, 120_000);

  it('leaves saved Blue trial snapshot ids, prompt bytes and the enriched id formula unchanged', async () => {
    expect(MODEL_SIDE).toBe('blue');
    for (const run of RUNS) {
      const saved = load(run);
      const legacy = await snapshotAtCheckpoint(saved.cp, saved.manifest.trialId, 4, saved.manifest.config);
      expect(legacy.snapshotId).toBe(saved.snap.snapshotId);
      expect(legacy.candidates).toEqual(saved.snap.candidates);
      expect(renderPrompt(saved.snap)).toBe(saved.prompt);
    }
    const config: TrialConfig = { ...manifest.config, playerContext: 'enriched/1', playerOutput: PLAYER_OUTPUT };
    const trial = await snapshotAtCheckpoint(cp, manifest.trialId, 4, config);
    const formula = `snap-${crypto.createHash('sha256').update(JSON.stringify({ trialId: trial.trialId, decision: 4, tick: trial.tick, fingerprint: trial.fingerprint, playerContext: 'enriched/1', playerOutput: PLAYER_OUTPUT, access: trial.observation.access, candidates: trial.candidates })).digest('hex').slice(0, 20)}`;
    expect(trial.snapshotId).toBe(formula);
    expect(trial.observation.seat).toBe('blue');
    expect(Object.keys(trial.observation)).not.toContain('seatContext');
    const p = renderPrompt(trial);
    expect(p.startsWith('# REPLAY AI-player trial: decision 5\n')).toBe(true);
    expect(p).toContain('You are the Blue player');
    // The Blue seat reuses the same derivation: identical candidates, access and shares, but its own versioned id.
    expect(blue.candidates).toEqual(trial.candidates);
    expect(blue.observation.access).toEqual(trial.observation.access);
    expect(blue.observation.troopShares).toEqual(trial.observation.troopShares);
    expect(blue.observation.legalNote).toBe(trial.observation.legalNote);
    expect(blue.snapshotId).not.toBe(trial.snapshotId);
    expect(snap.snapshotId).not.toBe(blue.snapshotId);
    expect(prompt).not.toContain(SEAT_CONTEXT);
  });

  it('gives Red its own totals, reserve, shares and access, and Blue only as public opponent totals', () => {
    const bluePlayer = e.player('blue'), redPlayer = e.player('red');
    // Asymmetric fixture: any Blue value leaking into the Red seat would be caught.
    expect(Math.floor(redPlayer.troops())).not.toBe(Math.floor(bluePlayer.troops()));
    expect(redPlayer.numTilesOwned()).not.toBe(bluePlayer.numTilesOwned());
    const state = e.state(), stateOf = (s: Side) => state.players.find((p) => p.side === s)!;
    const own = red.observation.ownResources as Resources, opp = red.observation.opponentPublic as Public;
    expect(own).toMatchObject({ side: 'red', troops: stateOf('red').troops, gold: stateOf('red').gold, tiles: stateOf('red').tiles });
    expect(opp).toMatchObject({ side: 'blue', troops: stateOf('blue').troops, tiles: stateOf('blue').tiles, alive: true });
    expect(opp).not.toHaveProperty('gold');
    expect(blue.observation.opponentPublic).toMatchObject({ side: 'red', troops: own.troops, tiles: own.tiles });
    const view = networkView(e, createNetworkLayout(e), cp.network);
    expect((red.observation.objectiveBoard as { ownReserve: unknown }).ownReserve).toEqual(view.reserve.red);
    expect((blue.observation.objectiveBoard as { ownReserve: unknown }).ownReserve).toEqual(view.reserve.blue);
    expect(view.reserve.red.fraction).not.toBe(view.reserve.blue.fraction);
    const forces = Math.floor(redPlayer.troops());
    expect(red.observation.troopShares).toMatchObject({ forcesAtHome: forces, shares: [...TROOP_SHARES] });
    expect(red.observation.access).toEqual(publicAccess(e, view, 'red'));
    expect(red.observation.access).not.toEqual(blue.observation.access);
    expect(red.observation).toMatchObject({ seat: 'red', opponent: 'blue', seatContext: SEAT_CONTEXT, decision: 5, tick: 1125 });
  });

  it('lists only engine-legal Red candidates, sized from Red forces and aimed at Blue', () => {
    expect(red.candidates.length).toBeGreaterThan(0);
    expect(red.candidates).not.toEqual(blue.candidates);
    const redForces = Math.floor(e.player('red').troops()), g = e.game, redID = e.player('red').smallID();
    const legal = (side: Side, intent: Record<string, unknown>) => { try { e.validate(side, intent); return true; } catch { return false; } };
    for (const c of red.candidates) {
      expect(legal('red', c.intent)).toBe(true);
      if (c.intent.type === 'attack' && c.intent.targetID !== null) expect(c.intent.targetID).toBe(e.player('blue').id());
      if (c.intent.type === 'build_unit') expect(g.ownerID(c.intent.tile as number)).toBe(redID);
      if (c.intent.type === 'boat') expect(g.ownerID(c.intent.dst as number)).not.toBe(redID);
      if (!c.troopOptions) continue;
      expect(c.defaultShare).toBe(0.2);
      expect(c.troopOptions.map((o) => o.share).every((s) => (TROOP_SHARES as readonly number[]).includes(s))).toBe(true);
      for (const o of c.troopOptions) {
        expect(o.troops).toBe(Math.max(1, Math.floor(o.share * redForces)));
        expect(legal('red', { ...c.intent, troops: o.troops })).toBe(true);
      }
    }
    expect(red.candidates.some((c) => c.troopOptions)).toBe(true);
    // Gold is asymmetric here (Red 47,300, Blue 172,300): Blue can afford structure sites, Red cannot. A Blue resource leak would list builds for Red.
    const gold = (s: SeatSnapshot) => (s.observation.ownResources as Resources).gold;
    expect(gold(red)).toBeLessThan(gold(blue));
    expect(blue.candidates.some((c) => c.intent.type === 'build_unit')).toBe(true);
    expect(red.candidates.some((c) => c.intent.type === 'build_unit')).toBe(false);
    // Red's land frontier still has unclaimed land; Blue's (full at this tick) has none, so this is not a Blue list relabelled.
    expect(red.candidates.some((c) => c.intent.type === 'attack' && c.intent.targetID === null)).toBe(true);
    expect(blue.candidates.some((c) => c.intent.type === 'attack')).toBe(false);
    expect((red.observation.access as { borderTilesFacingUnclaimed: number }).borderTilesFacingUnclaimed).toBeGreaterThan(0);
    expect((blue.observation.access as { borderTilesFacingUnclaimed: number }).borderTilesFacingUnclaimed).toBe(0);
    // Adversary targeting: Red's opponent-held landings are Blue land, never Red's.
    const blueID = e.player('blue').smallID();
    const atBlue = red.candidates.filter((c) => /opponent-held shore/.test(c.meaning));
    expect(atBlue.length).toBeGreaterThan(0);
    for (const c of atBlue) expect(g.ownerID(e.transportLanding(e.player('red'), c.intent.dst as number)!)).toBe(blueID);
    // Wording is relative to the seat: a Red-controlled station reads "you control" for Red, "opponent controls" for Blue.
    const board = red.observation.objectiveBoard as { stations: { name: string; controller: Side | null }[] };
    const words = (s: SeatSnapshot, name: string) => s.candidates.map((c) => c.meaning).filter((m) => m.includes(`station ${name} `) || m.includes(`station ${name} centre`));
    for (const st of board.stations.filter((x) => x.controller !== null)) {
      const mine = st.controller === 'red' ? 'you control' : 'opponent controls', theirs = st.controller === 'red' ? 'opponent controls' : 'you control';
      for (const m of words(red, st.name)) expect(m).toContain(`(${mine})`);
      for (const m of words(blue, st.name)) expect(m).toContain(`(${theirs})`);
    }
    expect(board.stations.some((st) => st.controller !== null && words(red, st.name).length > 0)).toBe(true);
    // choiceIntent maps a Red reply to the listed amount exactly.
    const troop = red.candidates.find((c) => c.troopOptions)!;
    const parsed = parseSeatChoice(reply(red, troop.index, 0.35), red);
    expect(parsed).toMatchObject({ seat: 'red', choice: troop.index, share: 0.35 });
    expect(choiceIntent(red, parsed.choice, parsed.share)).toEqual({ ...troop.intent, troops: troop.troopOptions!.find((o) => o.share === 0.35)!.troops });
  });

  it('reads without mutating the engine, the board or the caller input, independent of seat order', async () => {
    const e2 = await restore(cp);
    const before = { record: JSON.stringify(e2.record()), fingerprint: e2.state().fingerprint, ticks: e2.game.ticks(), turns: e2.turns.length };
    const network = deepFreeze(structuredClone(cp.network)); const previousDecisions = deepFreeze([{ seat: 'red' as const, decision: 3, tick: 855, choice: 'hold' as const, meaning: null, observed: [] }]);
    const redAgain = buildSeatSnapshot({ engine: e2, network, gameId, seat: 'red', decision: 4, cadence, previousDecisions });
    const blueAfterRed = buildSeatSnapshot({ engine: e2, network, gameId, seat: 'blue', decision: 4, cadence });
    expect({ record: JSON.stringify(e2.record()), fingerprint: e2.state().fingerprint, ticks: e2.game.ticks(), turns: e2.turns.length }).toEqual(before);
    expect(network).toEqual(cp.network);
    expect(blueAfterRed).toEqual(blue);
    expect(redAgain.candidates).toEqual(red.candidates);
    // The checkpoint's queued Red controller order is never an input.
    expect(cp.pending.length).toBeGreaterThan(0);
    const withPending = await seatSnapshotAtCheckpoint(cp, { gameId, seat: 'red', decision: 4, cadence });
    const withoutPending = await seatSnapshotAtCheckpoint({ ...cp, pending: [] }, { gameId, seat: 'red', decision: 4, cadence });
    expect(withPending).toEqual(red);
    expect(withoutPending).toEqual(red);
  }, 120_000);

  it('binds side and version into the id and rejects cross-seat, legacy and tampered snapshots', async () => {
    expect(red.snapshotId).toMatch(/^seat-red-[0-9a-f]{20}$/);
    expect(blue.snapshotId).toMatch(/^seat-blue-[0-9a-f]{20}$/);
    expect(red.fingerprint).toBe(blue.fingerprint);
    expect(red).toMatchObject({ schema: SEAT_SNAPSHOT_SCHEMA, seatContext: SEAT_CONTEXT, seat: 'red', playerContext: 'enriched/1', playerOutput: PLAYER_OUTPUT });
    expect(seatSnapshotId(red)).toBe(red.snapshotId);
    // The id would differ under another version or seat even with identical contents.
    expect(seatSnapshotId({ ...red, seatContext: 'seat-context/0' as typeof SEAT_CONTEXT })).not.toBe(red.snapshotId);
    expect(seatSnapshotId({ ...red, seat: 'blue' }).slice(-20)).not.toBe(red.snapshotId.slice(-20));
    const troop = red.candidates.find((c) => c.troopOptions)!;
    expect(parseSeatChoice(reply(red, 'hold', null), red)).toEqual({ snapshotId: red.snapshotId, choice: 'hold', rationale: 'fixture', seat: 'red' });
    const crossSeat = (() => { try { parseSeatChoice(reply(blue, 'hold', null), red); } catch (err) { return err as TrialRejection; } })();
    expect(crossSeat).toMatchObject({ code: 'unknown-snapshot' });
    expect(crossSeat!.message).toContain('is a blue seat snapshot');
    const trial = await snapshotAtCheckpoint(cp, manifest.trialId, 4, { ...manifest.config, playerContext: 'enriched/1', playerOutput: PLAYER_OUTPUT });
    expect(code(() => parseSeatChoice(reply(trial, 'hold', null), blue))).toBe('unknown-snapshot');
    expect(code(() => parseSeatChoice(reply(snap, 'hold', null), red))).toBe('unknown-snapshot');
    // A same-seat earlier id is stale; another seat's id in that list is misuse.
    const earlierRed = buildSeatSnapshot(input('red', { decision: 3 }));
    expect(code(() => parseSeatChoice(reply(earlierRed, 'hold', null), red, [earlierRed.snapshotId]))).toBe('stale-snapshot');
    expect(code(() => parseSeatChoice(reply(red, 'hold', null), red, [blue.snapshotId]))).toBe('usage');
    // The contract is unchanged: share required, listed on troop candidates, null otherwise.
    expect(code(() => parseSeatChoice(reply(red, troop.index, null), red))).toBe('illegal-choice');
    expect(code(() => parseSeatChoice(JSON.stringify({ snapshotId: red.snapshotId, choice: 'hold', rationale: 'x' }), red))).toBe('malformed');
    expect(code(() => parseSeatChoice(reply(red, 'hold', null, { seat: 'red' }), red))).toBe('malformed');
    expect(playerOutputSchema().required).toEqual(['snapshotId', 'choice', 'share', 'rationale']);
    // Tampered or legacy inputs are refused before parsing or rendering.
    const relabelled = { ...red, seat: 'blue' as const, observation: { ...red.observation, seat: 'blue' } };
    expect(code(() => parseSeatChoice(reply(red, 'hold', null), relabelled))).toBe('integrity');
    expect(code(() => renderSeatPrompt({ ...red, candidates: blue.candidates }))).toBe('integrity');
    expect(code(() => renderSeatPrompt({ ...red, snapshotId: blue.snapshotId }))).toBe('integrity');
    expect(code(() => checkSeatSnapshot(trial))).toBe('integrity');
    expect(code(() => renderSeatPrompt(trial as unknown as SeatSnapshot))).toBe('integrity');
    // The admission version, when the engine records one, joins the Red id as it does for Blue.
    const versioned = await seatSnapshotAtCheckpoint({ ...cp, record: { ...cp.record, options: { ...cp.record.options, transportAdmission: TRANSPORT_ADMISSION } } }, { gameId, seat: 'red', decision: 4, cadence });
    expect(versioned.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(versioned.fingerprint).toBe(red.fingerprint);
    expect(versioned.snapshotId).not.toBe(red.snapshotId);
    expect(red).not.toHaveProperty('transportAdmission');
  }, 120_000);

  it('accepts only this seat\'s own previous decisions and prior snapshot, never a rationale', () => {
    const own: SeatPreviousDecision[] = [
      { seat: 'red', decision: 2, tick: 585, choice: 0, meaning: 'Expand into unclaimed land', observed: [], share: 0.35 },
      { seat: 'red', decision: 3, tick: 855, choice: 'hold', meaning: null, observed: ['completed@900'] },
    ];
    const s = buildSeatSnapshot(input('red', { previousDecisions: own }));
    expect(s.observation.previousDecisions).toEqual([
      { decision: 3, tick: 585, choice: 0, meaning: 'Expand into unclaimed land', observed: [], share: 0.35 },
      { decision: 4, tick: 855, choice: 'hold', meaning: null, observed: ['completed@900'] },
    ]);
    // The id covers everything shown, so different context is a different snapshot; candidates do not change.
    expect(s.snapshotId).not.toBe(red.snapshotId);
    expect(s.candidates).toEqual(red.candidates);
    const secret = 'Blue plans to feint at Aster';
    const withRationale = [{ ...own[0]!, rationale: secret }] as unknown as SeatPreviousDecision[];
    expect(code(() => buildSeatSnapshot(input('red', { previousDecisions: withRationale })))).toBe('usage');
    expect(code(() => buildSeatSnapshot(input('red', { previousDecisions: [{ ...own[0]!, seat: 'blue' }] })))).toBe('integrity');
    expect(code(() => buildSeatSnapshot(input('red', { previousDecisions: [{ ...own[1]!, decision: 4 }] })))).toBe('usage');
    expect(code(() => buildSeatSnapshot(input('red', { previousDecisions: [own[1]!, own[0]!] })))).toBe('usage');
    expect(code(() => buildSeatSnapshot(input('red', { previousDecisions: [{ ...own[1]!, tick: 1170 }] })))).toBe('usage');
    expect(code(() => buildSeatSnapshot(input('red', { previousDecisions: [{ ...own[0]!, share: 0.25 }] })))).toBe('usage');
    // Prior snapshot: own seat, same game, earlier decision only.
    const priorRed = buildSeatSnapshot(input('red', { decision: 3 })), priorBlue = buildSeatSnapshot(input('blue', { decision: 3 }));
    const delta = buildSeatSnapshot(input('red', { priorSnapshot: priorRed })).observation.sincePreviousObservation as { own: Record<string, number>; opponentPublic: Record<string, unknown> };
    expect(delta.own).toEqual({ tiles: 0, troops: 0, gold: 0, structures: 0 });
    expect(code(() => buildSeatSnapshot(input('red', { priorSnapshot: priorBlue })))).toBe('integrity');
    expect(code(() => buildSeatSnapshot(input('red', { priorSnapshot: buildSeatSnapshot(input('red', { decision: 3, gameId: 'another-game' })) })))).toBe('integrity');
    expect(code(() => buildSeatSnapshot(input('red', { priorSnapshot: red })))).toBe('integrity');
    expect(code(() => buildSeatSnapshot(input('red', { priorSnapshot: { ...priorRed, observation: { ...priorRed.observation, ownResources: blue.observation.ownResources } } })))).toBe('integrity'); // Blue totals pasted into a Red prior
    // Input bounds.
    expect(code(() => buildSeatSnapshot(input('green' as Side)))).toBe('usage');
    expect(code(() => buildSeatSnapshot(input('red', { cadence: { ownTicksPerDecision: 100, opponentTicksPerDecision: 270 } })))).toBe('usage');
    expect(code(() => buildSeatSnapshot(input('red', { network: { ...cp.network, tick: 1080 } })))).toBe('integrity');
  });

  it('prompts Red as Red with public facts only and no inferred opponent psychology', () => {
    const p = renderSeatPrompt(red);
    expect(p.startsWith(`# REPLAY Red seat (${SEAT_CONTEXT}): decision 5\n`)).toBe(true);
    expect(p).toContain('You are the Red player');
    expect(p).toContain('strongest legal continuation for Red.');
    expect(p).not.toMatch(/Blue player|continuation for Blue/);
    expect(p).toContain(`Response contract ${PLAYER_OUTPUT}`);
    expect(p).toContain(red.snapshotId);
    expect(p).not.toContain(blue.snapshotId);
    expect(p).toContain('Equal cadence: you and the opponent each get one order opportunity per 270 ticks.');
    expect(renderSeatPrompt(blue)).toContain('You are the Blue player');
    const observation = JSON.parse(p.split('```json\n')[2]!.split('\n```')[0]!) as Record<string, unknown>;
    expect(observation.snapshotId).toBe(red.snapshotId);
    const keys = new Set<string>(); const walk = (v: unknown) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    walk(observation);
    for (const hidden of ['pending', 'pulses', 'reason', 'rationale', 'intention', 'plan', 'posture', 'mood']) expect(keys.has(hidden)).toBe(false);
    expect(p).not.toMatch(/\b(intends?|intention|plans? to|aggressive|passive|morale|panic|fear|confiden|bluff|psycholog|personality|desperat|likely to|wants to)\b/i);
    expect(p).not.toContain('objectives/1');
  });
});
