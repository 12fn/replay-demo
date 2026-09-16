/**
 * Reproducible comparison of the legacy baseline and `maneuver/1` on identical map, seed, spawn and
 * elimination rules (world and world-500, 30 simulated minutes cap). Accelerated deterministic
 * simulation only; nothing here is human validation. Evidence is written to
 * evidence/pacing/maneuver-characterization.json only when REPLAY_WRITE_MANEUVER_EVIDENCE=1, and the
 * writer keeps earlier content of that file.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { ReplayEngine, type EngineMap } from '../src/engine/engine';
import { MANEUVER_CONTROLLER } from '../src/agents/scripted-controller';
import { MANEUVER_MAPS, MATCHUPS, THIRTY_SIMULATED_MINUTES, brief, characterizeManeuver, maneuverEvidenceHeader, runMatchup, summarizeRun, writeManeuverEvidence, type ManeuverRunResult, type Matchup } from '../scripts/qualify-maneuver';
import { TICKS_PER_SIMULATED_MINUTE } from '../scripts/qualify-pacing';
console.debug = () => {}; console.warn = () => {};

const runs: ReturnType<typeof summarizeRun>[] = [];
afterAll(() => {
  if (process.env.REPLAY_WRITE_MANEUVER_EVIDENCE !== '1') return;
  const file = writeManeuverEvidence({ ...maneuverEvidenceHeader(), maps: MANEUVER_MAPS, runs });
  process.stderr.write(`wrote ${file}\n`);
});

const byKey = new Map<string, ManeuverRunResult>();
for (const map of MANEUVER_MAPS as EngineMap[]) describe(map, () => {
  test('every matchup to elimination or 30 simulated minutes, with independent restore verification', async () => {
    for (const matchup of Object.keys(MATCHUPS) as Matchup[]) for (const simulationId of matchup === 'maneuver-vs-legacy' ? ['MANV0001', 'MANV0002'] : ['MANV0001']) {
      const r = await runMatchup(map, matchup, { capTicks: THIRTY_SIMULATED_MINUTES, simulationId });
      process.stderr.write(brief(r) + '\n'); runs.push(summarizeRun(r)); byKey.set(`${map}:${matchup}:${simulationId}`, r);
      expect(r.ticksSimulated).toBeLessThanOrEqual(THIRTY_SIMULATED_MINUTES);
      expect(['eliminated', 'stalemate', 'contested-at-cap']).toContain(r.outcome);
      if (r.outcome === 'eliminated') { expect(r.eliminationTick).toBe(r.ticksSimulated); expect(r.eliminated).not.toBeNull(); }
      // Fingerprints captured during original execution are reproduced by a fresh engine re-executing the record.
      expect(r.restore.length).toBeGreaterThan(0); expect(r.restore.every((x) => x.matched)).toBe(true);
      expect(r.geography.landRoute).toBe(matchup.startsWith('sea-separated') ? 'none' : map === 'world-1000' ? 'partial' : 'full');
      for (const side of ['blue', 'red'] as const) {
        const a = r.activity[side];
        // Every order a scripted side submitted passed the validator; tick-time drops are counted, never hidden.
        expect(a.rejectedAtSubmission).toBe(0);
        if (a.controller === MANEUVER_CONTROLLER) { expect(a.decisionMs.n).toBeGreaterThan(0); expect(a.decisionMs.p95).toBeLessThan(50); }
        else expect(a.transports).toHaveLength(0);
        for (const t of a.transports) if (t.ended === 'landed') { expect(t.moves).toBeGreaterThan(0); expect(t.endTick).toBeGreaterThan(t.launchTick); }
      }
    }
  }, 240000);

  test('maneuver/1 fixes the measured legacy deficiencies on this map', () => {
    const mm = byKey.get(`${map}:maneuver-vs-maneuver:MANV0001`)!, ll = byKey.get(`${map}:legacy-vs-legacy:MANV0001`)!;
    const sea = byKey.get(`${map}:sea-separated-maneuver-vs-maneuver:MANV0001`)!, seaLegacy = byKey.get(`${map}:sea-separated-legacy-vs-legacy:MANV0001`)!;
    for (const side of ['blue', 'red'] as const) {
      // Neutral expansion continues after contact and gold is invested; the legacy rule never builds.
      const a = mm.activity[side]; const contactMinute = Math.floor((mm.firstContactTick ?? 0) / TICKS_PER_SIMULATED_MINUTE);
      const neutralAfterContact = mm.samples.filter((s) => s.simulatedMinute > contactMinute + 1).reduce((n, s) => n + s[side].gainedFromNeutral, 0);
      expect(neutralAfterContact).toBeGreaterThan(0);
      expect(a.constructionCompletions.length).toBeGreaterThan(0); expect(ll.activity[side].constructionCompletions).toHaveLength(0);
      expect(a.decisions.reserve + a.decisions.construction + a.decisions.upgrade + a.decisions.transport).toBeGreaterThan(0);
      // Across the barrier: transports launch, move and land on a landmass the side did not hold; the legacy pair never crosses.
      const s = sea.activity[side];
      expect(s.transports.length).toBeGreaterThan(0); expect(s.transports.some((t) => t.ended === 'landed' && t.newLandmass)).toBe(true);
      expect(s.transports.every((t) => t.targetLandmass !== -1)).toBe(true);
      expect(seaLegacy.activity[side].transports).toHaveLength(0);
    }
    expect(seaLegacy.firstContactTick).toBeNull(); expect(sea.firstContactTick).not.toBeNull();
  });
});

test('maneuver constructs from either starting position against a legacy opponent', () => {
  for (const map of MANEUVER_MAPS) {
    const a = byKey.get(`${map}:maneuver-vs-legacy:MANV0001`)!, b = byKey.get(`${map}:legacy-vs-maneuver:MANV0001`)!;
    // Different positions, so the numbers differ; on both sides the maneuver rule orders construction and transports and
    // out-expands its legacy opponent, and the legacy side never builds or sails.
    for (const [r, m] of [[a, 'blue'], [b, 'red']] as const) {
      const mine = r.activity[m], theirs = r.activity[m === 'blue' ? 'red' : 'blue'];
      expect(mine.decisions.construction).toBeGreaterThan(0); expect(mine.transports.length).toBeGreaterThan(0); expect(mine.peakTiles).toBeGreaterThan(theirs.peakTiles);
      expect(theirs.constructionCompletions).toHaveLength(0); expect(theirs.transports).toHaveLength(0);
    }
  }
});

test('the direct-run entry point produces the evidence shape on the small fixture and the writer preserves earlier content', async () => {
  const c = await characterizeManeuver(['plains'], 2 * TICKS_PER_SIMULATED_MINUTE);
  expect(c.runs).toHaveLength(Object.keys(MATCHUPS).length + 1); expect(c.controller).toBe('maneuver/1'); expect(c.timeUnits.ticksPerSimulatedMinute).toBe(600);
  const os = await import('node:os');
  const tmp = `${os.tmpdir()}/replay-maneuver-writer-test-${process.pid}.json`;
  const fs = await import('node:fs');
  try {
    writeManeuverEvidence({ at: 'first', runs: [1] }, tmp); writeManeuverEvidence({ at: 'second', runs: [2] }, tmp);
    const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(back.at).toBe('second'); expect(back.previous).toHaveLength(1); expect(back.previous[0].at).toBe('first'); expect(back.previous[0].previous).toBeUndefined();
  } finally { fs.rmSync(tmp, { force: true }); }
  // A tampered fingerprint in a run record is detected by the same restore path the harness uses.
  const r = await runMatchup('plains', 'maneuver-vs-maneuver', { capTicks: 300, verifyRestore: false });
  const tampered = structuredClone(r.record); tampered.fingerprints[300] = 'incorrect-source-reference';
  await expect(ReplayEngine.restore(tampered, 300, 'checkpoints')).rejects.toThrow(/fingerprint mismatch/);
}, 60000);
