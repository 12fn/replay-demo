/**
 * Reproducible pacing characterization of the legacy world option and the explicit larger
 * resolutions. Every run is accelerated deterministic simulation in simulated ticks (600 per
 * simulated minute); wall-clock figures describe this machine only. Results, including stalemates
 * and eliminations, are written to evidence/pacing/characterization.json without selection.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { ReplayEngine, type EngineMap, type EngineRecord } from '../src/engine/engine';
import { PACING_MAPS, SCENARIOS, SIXTY_SIMULATED_MINUTES, TICKS_PER_SIMULATED_MINUTE, characterize, evidenceHeader, measureTiming, runScenario, summarize, writeEvidence, type Scenario, type ScenarioResult, type TimingResult } from '../scripts/qualify-pacing';
console.debug = () => {};

const runs: ReturnType<typeof summarize>[] = []; const timings: TimingResult[] = []; const scriptedRecords = new Map<EngineMap, EngineRecord>();
afterAll(() => {
  if(process.env.REPLAY_WRITE_PACING_EVIDENCE!=='1')return;
  const file = writeEvidence('characterization', { ...evidenceHeader('Accelerated deterministic simulation of the pinned engine with the GameService spawn and baseline rules mirrored; no human input, no wall-clock pacing.'), maps: timings, runs });
  process.stderr.write(`wrote ${file}\n`);
});

const brief = (r: ScenarioResult) => `${r.map} ${r.scenario} ${r.simulationId}: ${r.outcome}${r.eliminated ? ` (${r.eliminated} at tick ${r.eliminationTick})` : ''} contact=${r.firstContactTick} route=${r.geography.landRoute} blueOnRed=${r.geography.blueTilesOnRedLandmass}/${r.geography.blueFootprintTiles} redReach=${r.geography.redReachableLandTiles} simMin=${r.simulatedMinutes} peak=${r.peakTiles.blue}/${r.peakTiles.red} changeMin=${r.minutesWithOwnershipChange} wall=${r.wallClock.runMs}ms`;

for (const map of PACING_MAPS) describe(map, () => {
  test('passive and scripted activity to elimination or 60 simulated minutes, two seeds each, plus a sea-separated deployment', async () => {
    for (const scenario of Object.keys(SCENARIOS) as Scenario[]) for (const simulationId of scenario === 'sea-separated-passive-blue' ? ['PACE0001'] : ['PACE0001', 'PACE0002']) {
      const r = await runScenario(map, scenario, { capTicks: SIXTY_SIMULATED_MINUTES, simulationId });
      process.stderr.write(brief(r) + '\n');
      runs.push(summarize(r)); if (scenario === 'scripted-blue' && simulationId === 'PACE0001') scriptedRecords.set(map, r.record);
      expect(r.ticksSimulated).toBeLessThanOrEqual(SIXTY_SIMULATED_MINUTES);
      expect(r.samples.length).toBeGreaterThan(0);
      // The result must say what happened; nothing is dropped as unflattering.
      expect(['eliminated', 'stalemate', 'contested-at-cap']).toContain(r.outcome);
      if (r.outcome === 'eliminated') expect(r.eliminationTick).toBe(r.ticksSimulated);
      // Geography is measured from the executed footprint; only the ocean-separated deployment must have no route.
      if (scenario === 'sea-separated-passive-blue') expect(r.geography.landRoute).toBe('none');
      else expect(r.geography.landRoute).not.toBe('none');
      if (map === 'world' && scenario !== 'sea-separated-passive-blue') expect(r.geography.landRoute).toBe('full');
      // The record the run produced replays identically at its first sampled fingerprint (turn path and admission are the engine's own).
      const first = r.samples.find(s => s.fingerprint !== null); if (first) { const { ReplayEngine } = await import('../src/engine/engine'); const restored = await ReplayEngine.restore(r.record, first.tick, 'checkpoints'); expect(restored.state().fingerprint).toBe(first.fingerprint); }
    }
  }, 30000);

  test('wall-clock cost of the server tick path, snapshots and seeks (this machine only)', async () => {
    const record = scriptedRecords.get(map); expect(record).toBeDefined();
    const t = await measureTiming(map, record!, [TICKS_PER_SIMULATED_MINUTE, 10 * TICKS_PER_SIMULATED_MINUTE, record!.turns.length]);
    timings.push(t); process.stderr.write(JSON.stringify(t) + '\n');
    expect(t.wallClock.seeks.every(s => s.matched)).toBe(true);
    expect(t.wallClock.fingerprintedStepMs).toBeGreaterThan(t.wallClock.rawTickMs);
  }, 30000);
});

test('the direct-run characterization entry point produces the same shape on the smallest map', async () => {
  const c = await characterize(['plains'], 2 * TICKS_PER_SIMULATED_MINUTE);
  expect(c.maps).toHaveLength(1); expect(c.runs).toHaveLength(7); expect(c.timeUnits.ticksPerSimulatedMinute).toBe(600);
}, 30000);


test('benchmark comparison requires an independently recorded source fingerprint',async()=>{
 const r=await runScenario('world','scripted-blue',{capTicks:600});
 expect(r.record.fingerprints[50]).toBeTruthy();expect(r.record.fingerprints[600]).toBeTruthy();
 const missing=structuredClone(r.record);delete missing.fingerprints[600];
 await expect(measureTiming('world',missing,[600])).rejects.toThrow(/No source fingerprint/);
 const tampered=structuredClone(r.record);tampered.fingerprints[600]='incorrect-source-reference';
 await expect(ReplayEngine.restore(tampered,600,'checkpoints')).rejects.toThrow(/fingerprint mismatch/);
});
