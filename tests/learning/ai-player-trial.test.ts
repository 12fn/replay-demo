import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NETWORK_RULES } from '../../src/campaign/network';
import { TRANSPORT_ADMISSION } from '../../src/engine/engine';
import { DEFAULT_TROOP_SHARE, FULL_GAME_BOUNDS, FULL_GAME_CLAIMS, FULL_GAME_MODE, MAX_CAP_TICKS, MAX_DECISIONS, MAX_SITES_PER_STRUCTURE, NOT_EQUALIZED, PLAYER_OUTPUT, PLAYER_OUTPUT_SCHEMA_FILE, RUN_MANIFEST, TRIAL_CLAIMS, TRIAL_SCHEMA, TROOP_SHARES, TrialRejection, cadence, checkBounds, choiceIntent, harnessMeaning, initTrial, observationDelta, opponentDue, opponentTicksOf, opportunityCounts, parseChoice, parseTrialArgs, playerContextOf, playerOutputOf, playerOutputSchema, renderPrompt, snapshotAtCheckpoint, stepTrial, validInterval, type Checkpoint, type Manifest, type Snapshot } from '../../scripts/ai-player-trial';

// Fictional abstract-game snapshot: two engine-listed candidates for the Blue seat.
const snapshot: Snapshot = {
  schema: `${TRIAL_SCHEMA}#snapshot`, trialId: 'trial-fixture', snapshotId: 'snap-current', decision: 1, tick: 585, fingerprint: 'f'.repeat(64),
  observation: { seat: 'blue', tick: 585, objectiveBoard: { scores: { blue: 2, red: 5 } } },
  candidates: [
    { index: 0, intent: { type: 'attack', targetID: null, troops: 900 }, meaning: 'Expand into unclaimed adjoining territory' },
    { index: 1, intent: { type: 'build_unit', unit: 'Port', tile: 4211 }, meaning: 'Build Port', costGold: 125000 },
  ],
};
const respond = (v: Record<string, unknown>) => JSON.stringify({ snapshotId: 'snap-current', rationale: 'Hold the coast before the priority shifts.', ...v });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as TrialRejection).code; } return 'accepted'; };

describe('parseChoice and candidate mapping', () => {
  it('maps an exact index to the listed intent, unchanged and copied', () => {
    const c = parseChoice(respond({ choice: 1 }), snapshot);
    const intent = choiceIntent(snapshot, c.choice);
    expect(intent).toEqual({ type: 'build_unit', unit: 'Port', tile: 4211 });
    intent!.tile = 1;
    expect(snapshot.candidates[1]!.intent.tile).toBe(4211);
    expect(choiceIntent(snapshot, parseChoice(respond({ choice: 'hold' }), snapshot).choice)).toBeNull();
  });

  it('separates stale and unknown snapshots from the current one', () => {
    expect(code(() => parseChoice(respond({ snapshotId: 'snap-earlier', choice: 0 }), snapshot, ['snap-earlier']))).toBe('stale-snapshot');
    expect(code(() => parseChoice(respond({ snapshotId: 'snap-other-trial', choice: 0 }), snapshot, ['snap-earlier']))).toBe('unknown-snapshot');
  });

  it('rejects malformed and out-of-range choices instead of guessing', () => {
    expect(code(() => parseChoice('```json\n{}\n```', snapshot))).toBe('malformed');
    expect(code(() => parseChoice(respond({ choice: '1' }), snapshot))).toBe('malformed');
    expect(code(() => parseChoice(respond({ choice: 0.5 }), snapshot))).toBe('malformed');
    expect(code(() => parseChoice(respond({ choice: 0, intent: { type: 'attack', troops: 99999 } }), snapshot))).toBe('malformed');
    expect(code(() => parseChoice(respond({ choice: 0, rationale: ' ' }), snapshot))).toBe('malformed');
    expect(code(() => parseChoice(respond({ choice: 2 }), snapshot))).toBe('illegal-choice');
    expect(code(() => parseChoice(respond({ choice: -1 }), snapshot))).toBe('illegal-choice');
  });

  it('prompts with the snapshot id and candidates but no opponent plan', () => {
    const prompt = renderPrompt(snapshot);
    expect(prompt).toContain('"snapshotId": "snap-current"');
    expect(prompt).toContain('Build Port');
    expect(prompt).not.toMatch(/pending|opponentPulses|ordersAtTick/);
  });
});

describe('parseTrialArgs bounds', () => {
  it('defaults to the declared bounds and rejects anything outside them', () => {
    expect(parseTrialArgs(['init', '--dir', '/tmp/t'])).toMatchObject({ seed: 'AIPT0001', ticksPerDecision: 270, opponentTicksPerCheck: 45, maxDecisions: MAX_DECISIONS, capTicks: MAX_CAP_TICKS });
    expect(parseTrialArgs(['init', '--dir', '/tmp/t', '--opponent-ticks-per-check', '270'])).toMatchObject({ ticksPerDecision: 270, opponentTicksPerCheck: 270, maxDecisions: 6, capTicks: 1800 });
    for (const bad of ['0', '30', '300', '945', 'x']) expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--opponent-ticks-per-check', bad]))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--opponent-tick-per-check', '270']))).toBe('usage'); // a typo must not silently mean 45
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--opponent-ticks-per-check']))).toBe('usage');
    expect(code(() => opponentTicksOf({ opponentTicksPerCheck: 100 }))).toBe('integrity');
    expect(opponentTicksOf({})).toBe(45); // manifests written before the option
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--decisions', '7']))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--cap-ticks', '1801']))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--ticks-per-decision', '300']))).toBe('usage');
    expect(code(() => parseTrialArgs(['step', '--dir', '/tmp/t', '--response', 'r.json']))).toBe('usage');
    expect(code(() => parseTrialArgs(['run', '--dir', '/tmp/t']))).toBe('usage');
  });
});

// Frozen fictional observations are included in corresponding source; tests do not depend on operator evidence directories.
const fixtures = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/actual-player-observations.json'), 'utf8')) as { entries: { run: string; decisionDirectory: string; snapshot: Snapshot }[] };
const saved = (run: string, n: string) => fixtures.entries.find((entry) => entry.run === run && entry.decisionDirectory === n)!.snapshot;
const savedRuns = fixtures.entries.map((entry) => entry.snapshot);

describe('troop wording and cadence', () => {
  it('never tells the responder a troop amount is adjustable, across every saved actual prompt', () => {
    expect(savedRuns.some((s) => s.candidates.some((c) => /adjustable/.test(c.meaning)))).toBe(true); // the generic engine labels do say it
    for (const s of savedRuns) {
      const prompt = renderPrompt(s);
      expect(prompt).not.toMatch(/adjustable/);
      expect(prompt).toContain('accepts only a candidate index or "hold"');
    }
    expect(harnessMeaning('Commit forces against the adjacent opposing player (troops adjustable)')).toBe('Commit forces against the adjacent opposing player (amount fixed by this harness)');
    const s = saved('paired-sol-20260914', '03'); const intents = JSON.stringify(s.candidates.map((c) => c.intent));
    renderPrompt(s); expect(JSON.stringify(s.candidates.map((c) => c.intent))).toBe(intents); // wording only; intents and snapshot untouched
  });

  it('states the Red 45 vs Blue 270 cadence and equal cadence at 45', () => {
    expect(cadence(270)).toMatchObject({ blueTicksPerDecision: 270, redTicksPerCheck: 45, redChecksPerBlueDecision: 6 });
    expect(cadence(270).note).toMatch(/^Asymmetric cadence/);
    expect(cadence(45).note).toMatch(/^Equal cadence/);
    expect(renderPrompt({ ...snapshot, observation: { ...snapshot.observation, cadence: cadence(270) } })).toContain('Cadence: Asymmetric cadence: Red may order every 45 ticks; Blue orders once per 270 ticks');
    // The output before the opponent option existed; the default must reproduce it exactly.
    const recorded = { blueTicksPerDecision: 270, redTicksPerCheck: 45, redChecksPerBlueDecision: 6, note: 'Asymmetric cadence: Red may order every 45 ticks; Blue orders once per 270 ticks (6 Red opportunities per Blue decision).' };
    expect(cadence(270)).toEqual(recorded);
    expect(cadence(270, 45)).toEqual(recorded);
    expect(cadence(270, 270)).toMatchObject({ blueTicksPerDecision: 270, redTicksPerCheck: 270, redChecksPerBlueDecision: 1 });
    expect(cadence(270, 270).note).toMatch(/^Equal cadence: Blue and Red each get one order opportunity per 270 ticks\. Red's checks are counted from Blue's first decision tick/);
  });
});

describe('opponent schedule', () => {
  const ticks = (due: (t: number) => boolean, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).filter(due);

  it('keeps every 45-tick boundary at the default, including deployment boundaries before Blue decides', () => {
    expect(ticks(opponentDue(45, 90), 1, 300)).toEqual([45, 90, 135, 180, 225, 270]);
  });

  it('aligns an explicit Red interval to Blue decision ticks', () => {
    // Blue270/Red270 from the recorded first decision at 45: identical opportunity ticks, none before Blue's first.
    const blue = [45, 315, 585, 855, 1125, 1395];
    expect(ticks(opponentDue(270, 45), 1, 1664)).toEqual(blue);
    expect(ticks(opponentDue(270, 45), 1665, 1665)).toEqual([1665]); // terminal check: its order cannot execute
    expect(ticks(opponentDue(90, 45), 1, 400)).toEqual([45, 135, 225, 315]);
  });
});

describe('opportunity counts', () => {
  const config = { scenarioId: 'crosscurrent-objectives/1', seed: 'X', seat: 'blue' as const, opponent: 'objectives/1', ticksPerDecision: 270, opponentTicksPerCheck: 270, maxDecisions: 6, capTicks: 1800 };
  const pulse = (tick: number, intentType: string | null = 'attack') => ({ tick, intentType, admittedAtSubmission: intentType !== null });
  const history = [{ choice: 0, key: '46:0:blue' }, { choice: 'hold' as const, key: null }, { choice: 2, key: null }];

  it('states parity only when counts match and Red had no check before Blue could decide', () => {
    const o = opportunityCounts({ config, firstDecisionTick: 45, finalTick: 855, history, initializationPulses: [pulse(45)], stepPulses: [pulse(315, null), pulse(585), pulse(855)], opponentOrdersAtTick: [{ executedKey: 'a' }, { executedKey: null }], opponentPendingAtEnd: 1 });
    expect(o).toMatchObject({ equalCadence: true, equalOpportunityCount: true, blue: { decisionOpportunities: 3, holds: 1, ordersSubmitted: 2, executedAtTick: 1, droppedAtTick: 1 }, red: { checksBeforeFirstDecision: 0, checksWithEffect: 3, checksAtFinalTick: 1, noOrder: 1, ordersQueued: 3, executedAtTick: 1, droppedAtTick: 1, pendingAtEnd: 1 } });
    expect(o.notEqualized).toBe(NOT_EQUALIZED);
    expect(NOT_EQUALIZED.join(' ')).toMatch(/landmass.*amounts fixed.*pauses.*precedes.*fun/s);
  });

  it('refuses to claim parity for an extra deployment check or unrecorded initialization', () => {
    const base = { config, firstDecisionTick: 90, finalTick: 900, history, stepPulses: [pulse(360), pulse(630)], opponentOrdersAtTick: [], opponentPendingAtEnd: 0 };
    const extra = opportunityCounts({ ...base, initializationPulses: [pulse(45), pulse(90)] });
    expect(extra).toMatchObject({ equalOpportunityCount: false, red: { checksBeforeFirstDecision: 1, checksWithEffect: 3 } });
    expect(extra.note).toMatch(/^Unequal/);
    const old = opportunityCounts({ ...base, config: { ...config, opponentTicksPerCheck: undefined }, initializationPulses: null });
    expect(old).toMatchObject({ opponentTicksPerCheck: 45, equalCadence: false, equalOpportunityCount: null, red: { checksWithEffect: null, executedAtTick: 0 } });
  });
});

describe('public change since the previous observation', () => {
  const before = saved('paired-sol-20260914', '03'), after = saved('paired-sol-20260914', '04');
  const delta = observationDelta(before.observation, after.observation);

  it('reproduces the recorded 855→1125 collapse from public totals', () => {
    expect(delta).toMatchObject({ fromTick: 855, toTick: 1125, own: { tiles: 545 - 3470, troops: 52196 - 327699 }, opponentPublic: { tiles: 27775 - 21278, alive: true }, points: { blue: 5, red: 6 } });
    expect(delta.stations.find((s) => s.id === 'aster')).toMatchObject({ controller: { before: 'blue', now: 'red' } });
    expect(delta.stations.find((s) => s.id === 'aster')!.heldTilesChange.blue).toBeLessThan(0);
  });

  it('carries no opponent orders, pulses or controller reasoning', () => {
    const text = JSON.stringify(delta);
    expect(text).not.toMatch(/pending|pulse|ordersAtTick|reason|intent|category|executedKey/);
    const prompt = renderPrompt({ ...after, observation: { ...after.observation, sincePreviousObservation: delta } });
    expect(prompt).toContain('"sincePreviousObservation"');
    expect(prompt).not.toMatch(/opponentPulses|ordersAtTick|"reason"|redai001/);
  });
});

describe('stepTrial rejection', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('refuses an outdated response before touching the engine or any file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-'));
    const manifest: Manifest = { schema: TRIAL_SCHEMA, trialId: 'trial-fixture', createdAt: 'x', updatedAt: 'x', config: { scenarioId: 'crosscurrent-objectives/1', seed: 'AIPT0001', seat: 'blue', opponent: 'objectives/1', ticksPerDecision: 270, maxDecisions: 6, capTicks: 1800 }, status: 'awaiting-choice', cursor: { decision: 1, tick: 585, snapshotId: 'snap-current', prompt: 'decisions/01/prompt.md' }, history: [{ decision: 0, tick: 315, snapshotId: 'snap-earlier', choice: 'hold', meaning: null, intent: null, key: null, responder: 'fixture', outcome: 'outcomes/00' }], claims: TRIAL_CLAIMS };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.mkdirSync(path.join(dir, 'decisions/01'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'decisions/01/snapshot.json'), JSON.stringify(snapshot)); // no replay.json: restoring would throw a different error
    const response = path.join(dir, 'response.json'); fs.writeFileSync(response, respond({ snapshotId: 'snap-earlier', choice: 0 }));
    const listing = () => fs.readdirSync(dir, { recursive: true }).map(String).sort();
    const before = { files: listing(), manifest: fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8') };
    await expect(stepTrial({ dir, response, responder: 'fixture' })).rejects.toMatchObject({ code: 'stale-snapshot' });
    expect({ files: listing(), manifest: fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8') }).toEqual(before);
  });

  it('prompts station coordinates and public change, and keeps Red reasoning in the receipt only', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial'); // init refuses an existing directory
    const m0 = await initTrial({ dir: trial, seed: 'AIPT0001', ticksPerDecision: 90, maxDecisions: 2, capTicks: 600 });
    const s0 = JSON.parse(fs.readFileSync(path.join(trial, 'decisions/00/snapshot.json'), 'utf8')) as Snapshot;
    const stations0 = (s0.observation.objectiveBoard as { stations: { x: unknown; y: unknown }[] }).stations;
    expect(stations0.every((st) => Number.isInteger(st.x) && Number.isInteger(st.y))).toBe(true);
    expect(s0.observation).not.toHaveProperty('sincePreviousObservation');
    const response = path.join(dir, 'r.json'); fs.writeFileSync(response, JSON.stringify({ snapshotId: m0.cursor!.snapshotId, choice: 'hold', rationale: 'Fixture hold.' }));
    await stepTrial({ dir: trial, response, responder: 'fixture' });
    const receipts = JSON.parse(fs.readFileSync(path.join(trial, 'outcomes/00/receipts.json'), 'utf8'));
    const reasons = (receipts.opponent.pulses as { reason: unknown }[]).map((p) => p.reason);
    expect(reasons.length).toBe(2);
    expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    const s1 = JSON.parse(fs.readFileSync(path.join(trial, 'decisions/01/snapshot.json'), 'utf8')) as Snapshot;
    expect(s1.observation.sincePreviousObservation).toMatchObject({ fromTick: s0.tick, toTick: s0.tick + 90 });
    const prompt = fs.readFileSync(path.join(trial, 'decisions/01/prompt.md'), 'utf8'); const replay = fs.readFileSync(path.join(trial, 'decisions/01/replay.json'), 'utf8');
    for (const r of reasons as string[]) { expect(prompt).not.toContain(r); expect(JSON.stringify(s1)).not.toContain(r); expect(replay).not.toContain(r); }
    expect(prompt).toContain('Red may order every 45 ticks; Blue orders once per 90 ticks');
    expect(m0.config.opponentTicksPerCheck).toBe(45);
  }, 60_000);

  it('treats a manifest without opponentTicksPerCheck as the original 45-tick schedule', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial');
    const m0 = await initTrial({ dir: trial, seed: 'AIPT0001', ticksPerDecision: 90, maxDecisions: 1, capTicks: 600 });
    const { opponentTicksPerCheck: _dropped, ...legacyConfig } = m0.config;
    fs.writeFileSync(path.join(trial, 'manifest.json'), JSON.stringify({ ...m0, config: legacyConfig })); // temp copy shaped like a pre-option manifest
    const response = path.join(dir, 'r.json'); fs.writeFileSync(response, JSON.stringify({ snapshotId: m0.cursor!.snapshotId, choice: 'hold', rationale: 'Fixture hold.' }));
    const m1 = await stepTrial({ dir: trial, response, responder: 'fixture' });
    expect(m1.config).not.toHaveProperty('opponentTicksPerCheck');
    const receipts = JSON.parse(fs.readFileSync(path.join(trial, 'outcomes/00/receipts.json'), 'utf8'));
    expect(receipts.opponent.pulses.map((p: { tick: number }) => p.tick)).toEqual([90, 135]);
    const summary = JSON.parse(fs.readFileSync(path.join(trial, 'final/summary.json'), 'utf8'));
    expect(summary).toMatchObject({ outcome: null, stopReason: 'decision-limit', scoresStatus: 'provisional' });
    expect(summary.outcomeNote).toMatch(/1-decision limit was reached before the 600-tick cap.*provisional and are not a win/);
    expect(summary.cadence.note).toMatch(/^Asymmetric cadence: Red may order every 45 ticks; Blue orders once per 90 ticks \(2 Red/);
    expect(summary.opportunities).toMatchObject({ opponentTicksPerCheck: 45, equalOpportunityCount: false, blue: { decisionOpportunities: 1 }, red: { checksBeforeFirstDecision: 0, checksWithEffect: 2, checksAtFinalTick: 1 } });
  }, 60_000);

  it('runs equal Blue/Red cadence with matching opportunity ticks and counts, keeping reasons out of prompts and the summary', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial');
    let m = await initTrial({ dir: trial, seed: 'AIPT0001', ticksPerDecision: 90, opponentTicksPerCheck: 90, maxDecisions: 3, capTicks: 600 });
    expect(m.config).toMatchObject({ ticksPerDecision: 90, opponentTicksPerCheck: 90 });
    const read = (f: string) => fs.readFileSync(path.join(trial, f), 'utf8');
    const init = JSON.parse(read('initialization/receipts.json'));
    const first = m.cursor!.tick;
    expect(init.opponent.pulses.map((p: { tick: number }) => p.tick)).toEqual([first]); // Red's first check shares Blue's first decision tick
    const blueTicks: number[] = [], redTicks: number[][] = [], reasons: string[] = [...init.opponent.pulses.map((p: { reason: string }) => p.reason)], prompts: string[] = [];
    while (m.status === 'awaiting-choice') {
      const k = m.cursor!.decision; blueTicks.push(m.cursor!.tick); prompts.push(read(m.cursor!.prompt), read(`decisions/${String(k).padStart(2, '0')}/replay.json`));
      const response = path.join(dir, `r${k}.json`); fs.writeFileSync(response, JSON.stringify({ snapshotId: m.cursor!.snapshotId, choice: 'hold', rationale: 'Fixture hold.' }));
      m = await stepTrial({ dir: trial, response, responder: 'fixture' });
      const pulses = JSON.parse(read(`outcomes/0${k}/receipts.json`)).opponent.pulses as { tick: number; reason: string }[];
      redTicks.push(pulses.map((p) => p.tick)); reasons.push(...pulses.map((p) => p.reason));
    }
    expect(blueTicks).toEqual([first, first + 90, first + 180]);
    expect(redTicks).toEqual([[first + 90], [first + 180], [first + 270]]);
    const summaryText = read('final/summary.json'); const summary = JSON.parse(summaryText);
    expect(summary.ticksSimulated).toBe(first + 270);
    expect(summary.opportunities).toMatchObject({ window: { firstDecisionTick: first, finalTick: first + 270 }, equalCadence: true, equalOpportunityCount: true, blue: { decisionOpportunities: 3, holds: 3 }, red: { checksBeforeFirstDecision: 0, checksWithEffect: 3, checksAtFinalTick: 1 } });
    expect(summary.opportunities.notEqualized).toEqual([...NOT_EQUALIZED]);
    expect(prompts[0]).toContain('Equal cadence: Blue and Red each get one order opportunity per 90 ticks.');
    expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    for (const r of new Set(reasons)) { for (const p of prompts) expect(p).not.toContain(r); expect(summaryText).not.toContain(r); }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// enriched/1 player context (opt-in) and legacy compatibility
// ---------------------------------------------------------------------------------------------
const options = (basis: number) => TROOP_SHARES.map((share) => ({ share, troops: Math.max(1, Math.floor(share * basis)) }));
const enrichedFixture: Snapshot = {
  ...snapshot, playerContext: 'enriched/1', observation: { seat: 'blue', tick: 585 },
  candidates: [
    { index: 0, intent: { type: 'attack', targetID: null, troops: 200 }, meaning: 'Expand into unclaimed land', defaultShare: DEFAULT_TROOP_SHARE, troopOptions: options(1000) },
    { index: 1, intent: { type: 'build_unit', unit: 'Port', tile: 4211 }, meaning: 'Build Port', costGold: 125000 },
  ],
};
const promptCandidates = (prompt: string) => (JSON.parse(prompt.split('```json\n')[2]!.split('\n```')[0]!) as { candidates: Snapshot['candidates'] }).candidates;

describe('enriched/1 choice parsing', () => {
  it('accepts only a declared share on a troop-bearing candidate and maps it to the listed amount', () => {
    const c = parseChoice(respond({ choice: 0, share: 0.35 }), enrichedFixture);
    expect(c.share).toBe(0.35);
    expect(choiceIntent(enrichedFixture, c.choice, c.share)).toEqual({ type: 'attack', targetID: null, troops: 350 });
    expect(choiceIntent(enrichedFixture, parseChoice(respond({ choice: 0 }), enrichedFixture).choice)).toEqual({ type: 'attack', targetID: null, troops: 200 }); // default share
    expect(enrichedFixture.candidates[0]!.intent.troops).toBe(200); // snapshot untouched
    expect(code(() => parseChoice(respond({ choice: 0, share: 0.3 }), enrichedFixture))).toBe('illegal-choice');
    expect(code(() => parseChoice(respond({ choice: 0, share: 1 }), enrichedFixture))).toBe('illegal-choice');
    expect(code(() => parseChoice(respond({ choice: 0, share: '0.35' }), enrichedFixture))).toBe('malformed');
    expect(code(() => parseChoice(respond({ choice: 1, share: 0.2 }), enrichedFixture))).toBe('illegal-choice');
    expect(code(() => parseChoice(respond({ choice: 'hold', share: 0.2 }), enrichedFixture))).toBe('illegal-choice');
    expect(code(() => parseChoice(respond({ choice: 0, troops: 999 }), enrichedFixture))).toBe('malformed');
    expect(code(() => choiceIntent(enrichedFixture, 1, 0.2))).toBe('illegal-choice');
  });

  it('keeps legacy snapshots on the three-field response', () => {
    expect(code(() => parseChoice(respond({ choice: 0, share: 0.2 }), snapshot))).toBe('malformed');
    expect(playerContextOf(snapshot)).toBe('legacy');
    expect(playerContextOf({})).toBe('legacy');
    expect(code(() => playerContextOf({ playerContext: 'enriched/2' }))).toBe('integrity');
  });

  it('opts in only by flag and keeps the existing hard bounds', () => {
    expect(parseTrialArgs(['init', '--dir', '/tmp/t'])).toMatchObject({ playerContext: 'legacy', maxDecisions: 6, capTicks: 1800 });
    expect(parseTrialArgs(['init', '--dir', '/tmp/t', '--player-context', 'enriched'])).toMatchObject({ playerContext: 'enriched/1', maxDecisions: 6, capTicks: 1800 });
    for (const bad of ['enriched/1', 'v2', '']) expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--player-context', bad]))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--player-context', 'enriched', '--cap-ticks', '12000']))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--player-context', 'enriched', '--decisions', '45']))).toBe('usage');
  });

  it('prints meanings verbatim and never shows the run bound', () => {
    const prompt = renderPrompt(enrichedFixture);
    expect(promptCandidates(prompt).map((c) => c.meaning)).toEqual(enrichedFixture.candidates.map((c) => c.meaning));
    expect(prompt).toContain('20 simulated minutes');
    const responseExample = JSON.parse(prompt.split('```json\n')[1]!.split('\n```')[0]!);
    expect(typeof responseExample.share).toBe('number');
    expect(prompt).toContain('never a quoted string or percentage');
    expect(prompt).not.toMatch(/run stops|maxDecisions|capTicks|amount fixed/);
  });
});

// ---------------------------------------------------------------------------------------------
// player-output/1 response contract (opt-in) and the preserved enriched/1 failure
// ---------------------------------------------------------------------------------------------
// Shaped like fullgame-opus-guarded-20260915 decisions/28: candidates 0-8 carry troops, 9 is a Defense Post build.
const decision28: Snapshot = {
  ...enrichedFixture, snapshotId: 'snap-7aa96def804e77464f41', transportAdmission: TRANSPORT_ADMISSION,
  candidates: [
    ...Array.from({ length: 9 }, (_, index) => ({ index, intent: { type: 'attack', targetID: null, troops: 200 }, meaning: 'Expand into unclaimed land', defaultShare: DEFAULT_TROOP_SHARE, troopOptions: options(1000) })),
    { index: 9, intent: { type: 'build_unit', unit: 'Defense Post', tile: 41601 }, meaning: 'Build Defense Post at {"x":101,"y":83}, 22 tiles from station Aster centre (you control)', costGold: 50000 },
  ],
};
// Copied from evidence/ai-player-trial/fullgame-opus-guarded-20260915/response-28.json (the evidence directory is not read here).
const response28 = '{"snapshotId": "snap-7aa96def804e77464f41", "choice": 9, "share": null, "rationale": "Blue must keep Aster and its reserve bonus, and priority likely rotates to Aster at 9001, so defending it matters more than a risky station raid. Land attacks cost 138k troops last interval while Red took 2,040 tiles, 18 of them inside Aster. A Defense Post near the station slows Red\'s push and keeps the reserve above 30%."}\n';
const contracted = { ...decision28, playerOutput: PLAYER_OUTPUT } as Snapshot;
const reply28 = (v: Record<string, unknown>) => JSON.stringify({ snapshotId: decision28.snapshotId, rationale: 'Fixture.', ...v });
const without = (v: Record<string, unknown>, k: string) => { const { [k]: _k, ...rest } = v; return JSON.stringify(rest); };

describe('player-output/1 response contract', () => {
  it('keeps the recorded enriched/1 rejection of the actual decision-28 reply', () => {
    expect(playerOutputOf(decision28)).toBeUndefined();
    expect(() => parseChoice(response28, decision28)).toThrow('malformed: share must be a number when given');
    expect(code(() => parseChoice(reply28({ choice: 9 }), decision28))).toBe('accepted'); // omitted share stays the enriched/1 way to say none
    expect(parseChoice(reply28({ choice: 0 }), decision28).share).toBeUndefined(); // and still means defaultShare on a troop candidate
  });

  it('accepts the same actual reply under the contract as a troopless build with no share', () => {
    const c = parseChoice(response28, contracted);
    expect(c.choice).toBe(9);
    expect(c).not.toHaveProperty('share');
    expect(choiceIntent(contracted, c.choice, c.share)).toEqual({ type: 'build_unit', unit: 'Defense Post', tile: 41601 });
    expect(parseChoice(reply28({ choice: 'hold', share: null }), contracted)).toEqual({ snapshotId: decision28.snapshotId, choice: 'hold', rationale: 'Fixture.' });
  });

  it('requires an explicit listed number on troop actions and never guesses or coerces', () => {
    expect(choiceIntent(contracted, 3, parseChoice(reply28({ choice: 3, share: 0.35 }), contracted).share)).toEqual({ type: 'attack', targetID: null, troops: 350 });
    expect(() => parseChoice(reply28({ choice: 3, share: null }), contracted)).toThrow(/illegal-choice: candidate 3 carries troops: share must be one of 0.1, 0.2, 0.35, 0.5; null is only for/);
    for (const share of ['0.2', 'null', '20%', true, [0.2], { share: 0.2 }]) expect(code(() => parseChoice(reply28({ choice: 3, share }), contracted))).toBe('malformed');
    expect(code(() => parseChoice(reply28({ choice: 3, share: 0.3 }), contracted))).toBe('illegal-choice');
    // Omitted share is not a default under the contract, for any choice.
    for (const choice of [3, 9, 'hold']) expect(() => parseChoice(without({ snapshotId: decision28.snapshotId, choice, share: null, rationale: 'Fixture.' }, 'share'), contracted)).toThrow(`malformed: share is required under ${PLAYER_OUTPUT}`);
    expect(code(() => parseChoice(reply28({ choice: 9, share: 0.2 }), contracted))).toBe('illegal-choice');
    expect(code(() => parseChoice(reply28({ choice: 'hold', share: 0.2 }), contracted))).toBe('illegal-choice');
    expect(code(() => parseChoice(reply28({ choice: 'hold', share: '0.2' }), contracted))).toBe('malformed');
  });

  it('still rejects malformed output under the contract', () => {
    for (const raw of ['', 'null', '[]', '```json\n{}\n```', `${response28.trim()} trailing`, reply28({ choice: '9', share: null }), reply28({ choice: 9.5, share: null }), reply28({ choice: 9, share: null, troops: 1 }), reply28({ choice: 9, share: null, rationale: '' })]) {
      expect(code(() => parseChoice(raw, contracted))).toBe('malformed');
    }
    expect(code(() => parseChoice(reply28({ choice: 15, share: null }), contracted))).toBe('illegal-choice');
    expect(code(() => parseChoice(reply28({ snapshotId: 'snap-other', choice: 9, share: null }), contracted))).toBe('unknown-snapshot');
    expect(code(() => playerOutputOf({ playerOutput: 'player-output/2' }))).toBe('integrity');
  });

  it('publishes a schema that matches the parser and prompts the contract only when recorded', () => {
    const schema = playerOutputSchema();
    expect(schema.required).toEqual(['snapshotId', 'choice', 'share', 'rationale']);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(schema).toMatchObject({ additionalProperties: false, properties: { share: { anyOf: [{ type: 'number', enum: [...TROOP_SHARES] }, { type: 'null' }] } } });
    const before = renderPrompt(decision28), after = renderPrompt(contracted);
    expect(before).not.toContain(PLAYER_OUTPUT); expect(before).toContain('Omit `share` unless selecting a listed troop option.');
    expect(after).toContain(`Response contract ${PLAYER_OUTPUT}`); expect(after).toContain('`share` MUST be null'); expect(after).not.toContain('defaultShare` (the amount');
    expect(promptCandidates(after)).toEqual(promptCandidates(before));
  });

  it('opts in only by flag on an enriched trial and refuses a recorded contract anywhere else', () => {
    expect(parseTrialArgs(['init', '--dir', '/tmp/t', '--mode', 'full-game'])).toMatchObject({ playerOutput: undefined });
    expect(parseTrialArgs(['init', '--dir', '/tmp/t', '--mode', 'full-game', '--player-output', 'v1'])).toMatchObject({ trialMode: FULL_GAME_MODE, playerOutput: PLAYER_OUTPUT });
    expect(parseTrialArgs(['init', '--dir', '/tmp/t', '--player-context', 'enriched', '--player-output', 'v1'])).toMatchObject({ playerOutput: PLAYER_OUTPUT });
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--player-output', 'v1']))).toBe('usage'); // legacy context
    for (const bad of ['player-output/1', 'v2', '']) expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--mode', 'full-game', '--player-output', bad]))).toBe('usage');
    const full = { ...FULL_GAME_BOUNDS, trialMode: FULL_GAME_MODE };
    expect(checkBounds({ ...full, playerOutput: PLAYER_OUTPUT })).toBe(FULL_GAME_MODE);
    for (const bad of [{ ...full, playerOutput: 'player-output/2' }, { ...full, playerOutput: null }, { ticksPerDecision: 270, maxDecisions: 6, capTicks: 1800, playerOutput: PLAYER_OUTPUT }]) expect(code(() => checkBounds(bad as never))).toBe('integrity');
  });
});

describe('player-output/1 trial against the engine', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('records the contract and schema, versions the snapshot id, and applies a null share only where it is irrelevant', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial');
    let m = await initTrial({ dir: trial, seed: 'AIPT0001', ticksPerDecision: 90, opponentTicksPerCheck: 90, maxDecisions: 2, capTicks: 600, playerContext: 'enriched/1', playerOutput: PLAYER_OUTPUT });
    const read = (f: string) => fs.readFileSync(path.join(trial, f), 'utf8');
    expect(m.config.playerOutput).toBe(PLAYER_OUTPUT);
    expect(JSON.parse(read(PLAYER_OUTPUT_SCHEMA_FILE))).toEqual(playerOutputSchema());
    expect(fs.statSync(path.join(trial, PLAYER_OUTPUT_SCHEMA_FILE)).mode & 0o222).toBe(0);
    const s0 = JSON.parse(read('decisions/00/snapshot.json')) as Snapshot, cp0 = JSON.parse(read('decisions/00/replay.json')) as Checkpoint;
    expect(s0.playerOutput).toBe(PLAYER_OUTPUT);
    expect(read('decisions/00/prompt.md')).toContain(`Response contract ${PLAYER_OUTPUT}`);
    const { playerOutput: _p, ...plainConfig } = m.config;
    const plain = await snapshotAtCheckpoint(cp0, m.trialId, 0, plainConfig);
    expect(plain.snapshotId).not.toBe(s0.snapshotId); expect(plain.candidates).toEqual(s0.candidates); expect(plain).not.toHaveProperty('playerOutput');
    const troop = s0.candidates.find((c) => c.troopOptions)!;

    // Refused before any artifact: null on a troop action, an omitted share, and a trial whose schema was removed.
    const listing = () => fs.readdirSync(trial, { recursive: true }).map(String).sort(); const before = listing();
    const reply = (name: string, v: Record<string, unknown>) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify({ snapshotId: s0.snapshotId, rationale: 'Fixture.', ...v })); return f; };
    await expect(stepTrial({ dir: trial, response: reply('null.json', { choice: troop.index, share: null }), responder: 'fixture' })).rejects.toMatchObject({ code: 'illegal-choice' });
    await expect(stepTrial({ dir: trial, response: reply('omitted.json', { choice: 'hold' }), responder: 'fixture' })).rejects.toMatchObject({ code: 'malformed' });
    expect(listing()).toEqual(before);
    const schemaFile = path.join(trial, PLAYER_OUTPUT_SCHEMA_FILE), schemaText = read(PLAYER_OUTPUT_SCHEMA_FILE);
    fs.chmodSync(schemaFile, 0o644); fs.rmSync(schemaFile); // explicit tampering of this disposable fixture only
    await expect(stepTrial({ dir: trial, response: reply('hold.json', { choice: 'hold', share: null }), responder: 'fixture' })).rejects.toMatchObject({ code: 'integrity' });
    fs.writeFileSync(schemaFile, schemaText, { mode: 0o444 });
    expect(listing()).toEqual(before);

    m = await stepTrial({ dir: trial, response: reply('sized.json', { choice: troop.index, share: 0.35 }), responder: 'fixture' });
    expect(JSON.parse(read('outcomes/00/decision.json'))).toMatchObject({ share: 0.35, troops: troop.troopOptions!.find((o) => o.share === 0.35)!.troops });
    const s1 = JSON.parse(read('decisions/01/snapshot.json')) as Snapshot;
    m = await stepTrial({ dir: trial, response: reply('h1.json', { snapshotId: s1.snapshotId, choice: 'hold', share: null }), responder: 'fixture' });
    expect(m.status).toBe('complete');
    const d1 = JSON.parse(read('outcomes/01/decision.json'));
    expect(d1).toMatchObject({ choice: 'hold', intent: null }); expect(d1).not.toHaveProperty('share');
    expect(read('outcomes/01/response.raw.json')).toContain('"share":null'); // the raw reply is kept as sent
  }, 120_000);
});

describe('enriched/1 trial against the engine', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists public access, sized and capped candidates, validates shares and audits the exact prompt text', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial');
    let m = await initTrial({ dir: trial, seed: 'AIPT0001', ticksPerDecision: 90, opponentTicksPerCheck: 90, maxDecisions: 3, capTicks: 600, playerContext: 'enriched/1' });
    expect(m.config.playerContext).toBe('enriched/1');
    const read = (f: string) => fs.readFileSync(path.join(trial, f), 'utf8');
    const s0 = JSON.parse(read('decisions/00/snapshot.json')) as Snapshot; const p0 = read('decisions/00/prompt.md');
    const obs = s0.observation as { access: { borderTilesFacingUnclaimed: number; stations: { id: string; access: string }[] }; troopShares: { forcesAtHome: number } };
    expect(s0.playerContext).toBe('enriched/1');
    expect(s0.observation).not.toHaveProperty('maxDecisions');
    expect(p0).not.toMatch(/run stops|maxDecisions|capTicks|tick 600\b|adjustable|amount fixed/);
    expect(obs.access.stations.map((s) => s.id)).toEqual(['aster', 'beacon', 'cedar', 'delta', 'ember']);
    expect(obs.access.stations.every((s) => s.access === 'own-landmass' || s.access === 'transport-only')).toBe(true);
    expect(obs.access.stations.some((s) => s.access === 'own-landmass')).toBe(true);
    // Sizing: every troop-bearing candidate offers exactly the declared shares at floor(share x forces at home); the intent carries the default.
    const troopBearing = s0.candidates.filter((c) => c.troopOptions);
    expect(troopBearing.length).toBeGreaterThan(0);
    for (const c of troopBearing) {
      expect(c.troopOptions).toEqual(options(obs.troopShares.forcesAtHome));
      expect(c.intent.troops).toBe(c.troopOptions!.find((o) => o.share === c.defaultShare)!.troops);
    }
    expect(s0.candidates.filter((c) => !c.troopOptions).every((c) => c.defaultShare === undefined)).toBe(true);
    if (obs.access.borderTilesFacingUnclaimed > 0) expect(troopBearing.some((c) => c.intent.type === 'attack' && c.intent.targetID === null)).toBe(true);
    else expect(s0.candidates.some((c) => c.intent.type === 'attack' && c.intent.targetID === null)).toBe(false);
    const builds = s0.candidates.filter((c) => c.intent.type === 'build_unit');
    for (const unit of new Set(builds.map((c) => c.intent.unit))) expect(builds.filter((c) => c.intent.unit === unit).length).toBeLessThanOrEqual(MAX_SITES_PER_STRUCTURE);
    expect(builds.every((c) => /tiles from station \w+ centre/.test(c.meaning))).toBe(true);
    expect(s0.candidates.filter((c) => c.intent.type === 'boat').every((c) => /toward station \w+ .*tiles from the station centre|nearest station \w+ .*sampled shore/.test(c.meaning))).toBe(true);

    // No future or private inputs: the saved snapshot is exactly what the tick's checkpoint yields, with or without Red's queued orders.
    const cp0 = JSON.parse(read('decisions/00/replay.json')) as Checkpoint;
    expect(cp0.pending.some((o) => o.side === 'red')).toBe(true); // Red checked on this same tick; its order is queued, unexecuted
    const rebuilt = await snapshotAtCheckpoint(cp0, m.trialId, 0, m.config);
    expect({ id: rebuilt.snapshotId, candidates: rebuilt.candidates, access: rebuilt.observation.access }).toEqual({ id: s0.snapshotId, candidates: s0.candidates, access: obs.access });
    expect((await snapshotAtCheckpoint({ ...cp0, pending: [] }, m.trialId, 0, m.config)).snapshotId).toBe(s0.snapshotId);
    for (const o of cp0.pending) { expect(p0).not.toContain(JSON.stringify(o.intent)); expect(JSON.stringify(s0)).not.toContain(JSON.stringify(o.intent)); }
    const reasons: string[] = JSON.parse(read('initialization/receipts.json')).opponent.pulses.map((p: { reason: string }) => p.reason);
    for (const r of reasons) expect(p0).not.toContain(r);
    expect(p0).not.toMatch(/pending|opponentPulses|ordersAtTick|"reason"|redai001/);

    // Submission: a share outside the set is refused before any artifact exists.
    const pick = troopBearing[0]!; const listing = () => fs.readdirSync(trial, { recursive: true }).map(String).sort(); const before = listing();
    const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ snapshotId: s0.snapshotId, choice: pick.index, share: 0.3, rationale: 'Fixture.' }));
    await expect(stepTrial({ dir: trial, response: bad, responder: 'fixture' })).rejects.toMatchObject({ code: 'illegal-choice' });
    expect(listing()).toEqual(before);

    // A saved id is not proof that the saved candidate body is unchanged.
    const changedSnapshot = structuredClone(s0); changedSnapshot.candidates[pick.index]!.intent.troops = 1;
    fs.chmodSync(path.join(trial, 'decisions/00/snapshot.json'), 0o644); // explicit tampering of this disposable test fixture only
    fs.writeFileSync(path.join(trial, 'decisions/00/snapshot.json'), JSON.stringify(changedSnapshot));
    const tamperedChoice = path.join(dir, 'tampered.json'); fs.writeFileSync(tamperedChoice, JSON.stringify({ snapshotId:s0.snapshotId,choice:pick.index,rationale:'Fixture tampered candidate.' }));
    await expect(stepTrial({dir:trial,response:tamperedChoice,responder:'fixture'})).rejects.toMatchObject({code:'integrity'});
    expect(listing()).toEqual(before);
    fs.writeFileSync(path.join(trial, 'decisions/00/snapshot.json'), JSON.stringify(s0));
    fs.chmodSync(path.join(trial, 'decisions/00/snapshot.json'), 0o444);
    const r0 = path.join(dir, 'r0.json'); fs.writeFileSync(r0, JSON.stringify({ snapshotId: s0.snapshotId, choice: pick.index, share: 0.35, rationale: 'Fixture sized order.' }));
    m = await stepTrial({ dir: trial, response: r0, responder: 'fixture' });
    const want = pick.troopOptions!.find((o) => o.share === 0.35)!.troops;
    const receipts = JSON.parse(read('outcomes/00/receipts.json')); const decision = JSON.parse(read('outcomes/00/decision.json'));
    expect(receipts.modelOrder).toMatchObject({ intent: { ...pick.intent, troops: want }, admittedAtSubmission: true });
    expect(typeof receipts.modelOrder.executedKey).toBe('string'); // passed tick-time validation too
    expect(decision).toMatchObject({ share: 0.35, troops: want, meaning: pick.meaning, promptMeaning: pick.meaning });
    expect(decision.meaning).toBe(promptCandidates(p0)[pick.index]!.meaning);
    expect(m.history[0]).toMatchObject({ share: 0.35, intent: { troops: want } });
    const s1 = JSON.parse(read('decisions/01/snapshot.json')) as Snapshot;
    expect((s1.observation.previousDecisions as { share?: number }[])[0]!.share).toBe(0.35);

    while (m.status === 'awaiting-choice') {
      const r = path.join(dir, `h${m.cursor!.decision}.json`); fs.writeFileSync(r, JSON.stringify({ snapshotId: m.cursor!.snapshotId, choice: 'hold', rationale: 'Fixture hold.' }));
      m = await stepTrial({ dir: trial, response: r, responder: 'fixture' });
      expect(JSON.parse(read(`outcomes/0${m.history.length - 1}/decision.json`))).not.toHaveProperty('share');
    }
    const summary = JSON.parse(read('final/summary.json'));
    expect(summary).toMatchObject({ outcome: null, stopReason: 'decision-limit', scoresStatus: 'provisional', config: { playerContext: 'enriched/1' } });
    expect(summary.opportunities.notEqualized[1]).toContain('listed troop shares');
    expect(summary.opportunities.notEqualized[1]).not.toContain('amounts fixed');
  }, 120_000);

  it('leaves a trial without the field on the legacy format and reports a tick-cap stop', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial');
    let m = await initTrial({ dir: trial, seed: 'AIPT0001', ticksPerDecision: 270, maxDecisions: 6, capTicks: 600 });
    expect(m.config).not.toHaveProperty('playerContext'); expect(m.config).not.toHaveProperty('trialMode'); expect(m.config).not.toHaveProperty('transportAdmission');
    expect(fs.existsSync(path.join(trial, RUN_MANIFEST))).toBe(false);
    const s0 = JSON.parse(fs.readFileSync(path.join(trial, 'decisions/00/snapshot.json'), 'utf8')) as Snapshot;
    expect(s0).not.toHaveProperty('playerContext');
    expect(s0.observation).not.toHaveProperty('access');
    expect(s0.candidates.every((c) => c.troopOptions === undefined)).toBe(true);
    const p0 = fs.readFileSync(path.join(trial, 'decisions/00/prompt.md'), 'utf8');
    expect(p0).toContain('The run stops at tick 600.'); expect(p0).toContain('"maxDecisions": 6');
    const shared = path.join(dir, 's.json'); fs.writeFileSync(shared, JSON.stringify({ snapshotId: s0.snapshotId, choice: 'hold', share: 0.2, rationale: 'Fixture.' }));
    await expect(stepTrial({ dir: trial, response: shared, responder: 'fixture' })).rejects.toMatchObject({ code: 'malformed' });
    while (m.status === 'awaiting-choice') {
      const r = path.join(dir, `h${m.cursor!.decision}.json`); fs.writeFileSync(r, JSON.stringify({ snapshotId: m.cursor!.snapshotId, choice: 'hold', rationale: 'Fixture hold.' }));
      m = await stepTrial({ dir: trial, response: r, responder: 'fixture' });
    }
    const summary = JSON.parse(fs.readFileSync(path.join(trial, 'final/summary.json'), 'utf8'));
    expect(summary).toMatchObject({ ticksSimulated: 600, outcome: null, stopReason: 'tick-cap', scoresStatus: 'provisional' });
    expect(summary.outcomeNote).toMatch(/600-tick cap was reached with \d of 6 decisions taken/);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// full-game/1 horizon (opt-in) and short-trial compatibility
// ---------------------------------------------------------------------------------------------
describe('full-game/1 bounds', () => {
  const init = (...extra: string[]) => parseTrialArgs(['init', '--dir', '/tmp/t', '--mode', 'full-game', ...extra]);

  it('opts in only by explicit mode, restates but never changes its bounds, and leaves the interval bound at 900', () => {
    expect(FULL_GAME_BOUNDS).toEqual({ playerContext: 'enriched/1', ticksPerDecision: 270, opponentTicksPerCheck: 270, maxDecisions: 45, capTicks: NETWORK_RULES.limitTicks });
    expect(init()).toMatchObject({ trialMode: FULL_GAME_MODE, playerContext: 'enriched/1', ticksPerDecision: 270, opponentTicksPerCheck: 270, maxDecisions: 45, capTicks: NETWORK_RULES.limitTicks });
    expect(init('--player-context', 'enriched', '--opponent-ticks-per-check', '270', '--decisions', '45', '--cap-ticks', String(NETWORK_RULES.limitTicks))).toMatchObject({ trialMode: FULL_GAME_MODE });
    expect(parseTrialArgs(['init', '--dir', '/tmp/t'])).toMatchObject({ trialMode: 'short', playerContext: 'legacy', maxDecisions: 6, capTicks: 1800, opponentTicksPerCheck: 45 });
    for (const bad of [['--player-context', 'legacy'], ['--opponent-ticks-per-check', '45'], ['--ticks-per-decision', '900'], ['--decisions', '44'], ['--decisions', '46'], ['--cap-ticks', String(NETWORK_RULES.limitTicks - 1)], ['--cap-ticks', String(NETWORK_RULES.limitTicks + 1)]]) expect(code(() => init(...bad))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--mode', 'long']))).toBe('usage');
    expect(code(() => parseTrialArgs(['init', '--dir', '/tmp/t', '--player-context', 'enriched', '--opponent-ticks-per-check', '270', '--decisions', '45']))).toBe('usage'); // no mode, short bounds
    expect([validInterval(900), validInterval(945), validInterval(1800)]).toEqual([true, false, false]);
    expect(code(() => init('--opponent-ticks-per-check', '945'))).toBe('usage');
    expect(parseTrialArgs(['bounds'])).toEqual({ command: 'bounds' });
  });

  it('refuses malformed saved bounds as integrity and programmatic misuse before writing anything', async () => {
    const short = { ticksPerDecision: 270, maxDecisions: 6, capTicks: 1800 };
    expect(checkBounds(short)).toBe('short'); // pre-option manifest: no opponent interval, context or mode
    const full = { ...short, ...FULL_GAME_BOUNDS, trialMode: FULL_GAME_MODE };
    expect(checkBounds(full)).toBe(FULL_GAME_MODE);
    expect(checkBounds({ ...full, transportAdmission: TRANSPORT_ADMISSION })).toBe(FULL_GAME_MODE); // full-game trials initialized before the rule omit it
    for (const bad of [{ ...short, capTicks: NETWORK_RULES.limitTicks }, { ...short, maxDecisions: 45 }, { ...full, maxDecisions: 46 }, { ...full, maxDecisions: '45' }, { ...full, capTicks: 1800 }, { ...full, playerContext: undefined }, { ...full, opponentTicksPerCheck: undefined }, { ...full, trialMode: 'full-game/2' }, { ...full, ticksPerDecision: 225 },
      { ...short, transportAdmission: TRANSPORT_ADMISSION }, { ...full, transportAdmission: 'launch-water-route/2' }, { ...full, transportAdmission: null }]) {
      expect(code(() => checkBounds(bad as never))).toBe('integrity');
    }
    const dir = path.join(os.tmpdir(), `ai-player-trial-refused-${process.pid}`);
    await expect(initTrial({ dir, seed: 'AIPT0001', ...FULL_GAME_BOUNDS, playerContext: 'legacy', trialMode: FULL_GAME_MODE })).rejects.toMatchObject({ code: 'usage' });
    await expect(initTrial({ dir, seed: 'AIPT0001', ...FULL_GAME_BOUNDS, trialMode: 'short' })).rejects.toMatchObject({ code: 'usage' });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('full-game/1 deterministic fixture run (not intelligent play)', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('reaches the objective time-limit ending on the 45th decision through the standard step loop, refusing tampered bounds first', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-trial-')); const trial = path.join(dir, 'trial');
    let m = await initTrial({ dir: trial, seed: 'AIPT0001', ...FULL_GAME_BOUNDS, trialMode: FULL_GAME_MODE });
    const read = (f: string) => fs.readFileSync(path.join(trial, f), 'utf8');
    const run = JSON.parse(read(RUN_MANIFEST));
    expect(run).toMatchObject({ trialId: m.trialId, trialMode: FULL_GAME_MODE, config: m.config, objective: { limitTicks: NETWORK_RULES.limitTicks }, maxIntervalTicks: 900, claims: { fullGame: FULL_GAME_CLAIMS } });
    expect(fs.statSync(path.join(trial, RUN_MANIFEST)).mode & 0o222).toBe(0);
    expect(read('decisions/00/prompt.md')).not.toMatch(/run stops|maxDecisions|capTicks|\b45 decisions/);
    // New full-game trials record the versioned transport admission in the config, the engine record and the snapshot id input.
    const s0 = JSON.parse(read('decisions/00/snapshot.json')) as Snapshot, cp0 = JSON.parse(read('decisions/00/replay.json')) as Checkpoint;
    expect([m.config.transportAdmission, run.config.transportAdmission, cp0.record.options.transportAdmission, s0.transportAdmission]).toEqual(Array(4).fill(TRANSPORT_ADMISSION));
    expect(s0.observation.legalNote).toContain(`Transport admission ${TRANSPORT_ADMISSION}`);
    expect(s0.observation.legalNote).toContain('It does not predict arrival');
    expect(s0.candidates.filter((c) => c.intent.type === 'boat').every((c) => /engine target .*arrival not predicted$/.test(c.meaning) && !/lands at/.test(c.meaning))).toBe(true);

    // A replaced manifest that widens, narrows or drifts from the run manifest stops before any engine work or file.
    const manifestFile = path.join(trial, 'manifest.json'), original = read('manifest.json');
    const listing = () => fs.readdirSync(trial, { recursive: true }).map(String).sort(); const before = listing();
    const hold = (k: number, snapshotId: string) => { const r = path.join(dir, `r${k}.json`); fs.writeFileSync(r, JSON.stringify({ snapshotId, choice: 'hold', rationale: 'Fixture hold.' })); return r; };
    const { transportAdmission: _rule, ...withoutRule } = m.config;
    for (const config of [{ ...m.config, maxDecisions: 46 }, { ...m.config, capTicks: MAX_CAP_TICKS }, { ...m.config, seed: 'AIPT0002' }, withoutRule]) {
      fs.writeFileSync(manifestFile, JSON.stringify({ ...m, config }));
      await expect(stepTrial({ dir: trial, response: hold(0, m.cursor!.snapshotId), responder: 'fixture' })).rejects.toMatchObject({ code: 'integrity' });
      expect(listing()).toEqual(before);
    }
    fs.writeFileSync(manifestFile, original);

    // A fixed "hold" every decision: no play at all, only the standard step loop carrying the game to the scenario's own ending.
    while (m.status === 'awaiting-choice') m = await stepTrial({ dir: trial, response: hold(m.cursor!.decision, m.cursor!.snapshotId), responder: 'deterministic-hold-fixture' });
    const summary = JSON.parse(read('final/summary.json'));
    expect(m.history.map((h) => h.tick)).toEqual(Array.from({ length: FULL_GAME_BOUNDS.maxDecisions }, (_, i) => 45 + i * 270));
    expect(summary).toMatchObject({ ticksSimulated: NETWORK_RULES.limitTicks, outcome: { reason: 'time-limit' }, stopReason: 'game-outcome', scoresStatus: 'final', config: { trialMode: FULL_GAME_MODE }, runManifest: RUN_MANIFEST, fullGameClaims: FULL_GAME_CLAIMS });
    expect(summary.outcome.scores).toEqual(summary.scores);
    expect(summary.opportunities).toMatchObject({ equalCadence: true, blue: { decisionOpportunities: 45, holds: 45 } });
  }, 120_000);
});

// Hash-provenanced copies of the saved equal-cadence checkpoint/prompt; also available in standalone source archives.
const EVIDENCE = path.resolve(__dirname, '../fixtures/player-context-legacy');
const equalRuns = ['equal-opus-20260915', 'equal-sol-20260915'];
describe('saved equal-cadence trials (read-only)', () => {
  const load = (run: string) => {
    const f = (p: string) => fs.readFileSync(path.join(EVIDENCE, run, p), 'utf8');
    return { manifest: JSON.parse(f('manifest.json')) as Manifest, snap: JSON.parse(f('decisions/04/snapshot.json')) as Snapshot, prompt: f('decisions/04/prompt.md'), cp: JSON.parse(f('decisions/04/replay.json')) as Checkpoint };
  };

  it('restores the legacy candidate hash and prompt bytes, then derives enriched access from the same checkpoint', async () => {
    type Enriched = { access: { borderTilesFacingUnclaimed: number; stations: { id: string; access: string }[] }; candidates: Snapshot['candidates'] };
    const out: Record<string, Enriched> = {};
    for (const run of equalRuns) {
      const { manifest, snap, prompt, cp } = load(run);
      expect(manifest.config).not.toHaveProperty('playerContext');
      const legacy = await snapshotAtCheckpoint(cp, manifest.trialId, 4, manifest.config);
      expect(legacy.snapshotId).toBe(snap.snapshotId);
      expect(renderPrompt(snap)).toBe(prompt);
      const enriched = await snapshotAtCheckpoint(cp, manifest.trialId, 4, { ...manifest.config, playerContext: 'enriched/1' });
      expect(enriched.snapshotId).not.toBe(snap.snapshotId);
      out[run] = { access: enriched.observation.access as Enriched['access'], candidates: enriched.candidates };
    }
    const opus = out['equal-opus-20260915']!, sol = out['equal-sol-20260915']!;
    // Checkpoints without the admission option keep the enriched/1 id formula and wording that saved enriched trials used.
    const { manifest, cp } = load('equal-opus-20260915'); const enrichedConfig = { ...manifest.config, playerContext: 'enriched/1' as const };
    const before = await snapshotAtCheckpoint(cp, manifest.trialId, 4, enrichedConfig);
    const formula = (s: Snapshot) => `snap-${crypto.createHash('sha256').update(JSON.stringify({ trialId: s.trialId, decision: s.decision, tick: s.tick, fingerprint: s.fingerprint, playerContext: 'enriched/1', access: s.observation.access, candidates: s.candidates })).digest('hex').slice(0, 20)}`;
    expect(before.snapshotId).toBe(formula(before));
    expect(before).not.toHaveProperty('transportAdmission');
    const stationBoats = (s: Snapshot) => s.candidates.filter((c) => /toward station/.test(c.meaning));
    expect(stationBoats(before).length).toBeGreaterThan(0);
    expect(stationBoats(before).every((c) => /; lands at /.test(c.meaning) && !/arrival not predicted/.test(c.meaning))).toBe(true);
    expect(before.observation.legalNote).not.toContain('Transport admission');
    // The same state under launch-water-route/1: a different, versioned id and wording that names the target shore without predicting arrival.
    const versioned = await snapshotAtCheckpoint({ ...cp, record: { ...cp.record, options: { ...cp.record.options, transportAdmission: TRANSPORT_ADMISSION } } }, manifest.trialId, 4, enrichedConfig);
    expect(versioned.fingerprint).toBe(before.fingerprint);
    expect(versioned.transportAdmission).toBe(TRANSPORT_ADMISSION);
    expect(versioned.snapshotId).not.toBe(before.snapshotId);
    expect(stationBoats(versioned).every((c) => /; engine target shore .*; arrival not predicted$/.test(c.meaning))).toBe(true);
    expect(versioned.observation.legalNote).toContain(`Transport admission ${TRANSPORT_ADMISSION}`);
    // Admission can only remove transports; every non-transport candidate is unchanged.
    const nonBoat = (s: Snapshot) => s.candidates.filter((c) => c.intent.type !== 'boat').map(({ index: _i, ...c }) => c);
    expect(nonBoat(versioned)).toEqual(nonBoat(before));
    expect(versioned.candidates.filter((c) => c.intent.type === 'boat').length).toBeLessThanOrEqual(before.candidates.filter((c) => c.intent.type === 'boat').length);
    // Opus at tick 1125: Blue's land was full (review section 6, O/decisions/04), and only Aster shares its landmass.
    expect(opus.access.borderTilesFacingUnclaimed).toBe(0);
    expect(opus.candidates.some((c) => c.intent.type === 'attack' && c.intent.targetID === null)).toBe(false);
    expect(opus.access.stations.filter((s) => s.access === 'own-landmass').map((s) => s.id)).toEqual(['aster']);
    expect(opus.candidates.some((c) => /toward station/.test(c.meaning))).toBe(true);
    expect(opus.candidates.filter((c) => c.intent.type === 'build_unit').length).toBeLessThanOrEqual(4 * MAX_SITES_PER_STRUCTURE);
    // Sol at tick 1125 still had unclaimed frontier and an expansion order.
    expect(sol.access.borderTilesFacingUnclaimed).toBeGreaterThan(0);
    expect(sol.candidates.some((c) => c.intent.type === 'attack' && c.intent.targetID === null)).toBe(true);
  }, 180_000);
});
