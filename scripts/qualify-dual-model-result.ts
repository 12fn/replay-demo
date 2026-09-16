/** Independent receipt/hash/final-engine verification of a completed actual dual-provider run. No inference. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ReplayEngine } from '../src/engine/engine';
import { checkSeatSnapshot, parseSeatChoice, playerOutputSchema } from './ai-player-trial';
import { checkDualConfig, dualScenario, hasScenario, renderDualPrompt, rebuildSavedRound } from './dual-model-trial';

const name = process.argv[2];
assert(name && /^[A-Za-z0-9][A-Za-z0-9-]{0,70}$/.test(name), 'Expected trial name');
const suffix = process.argv[3];
assert(process.argv.length <= 4 && (!suffix || /^[A-Za-z0-9-]{1,30}$/.test(suffix)), 'Optional fresh receipt suffix');
const root = process.cwd(), dir = path.join(root, 'evidence/dual-model-trial', name);
const json = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const digest = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const within = (base: string, relative: string) => {
  const target = fs.realpathSync(path.resolve(base, relative));
  assert(target.startsWith(fs.realpathSync(base) + path.sep), 'Artifact escaped evidence directory');
  return target;
};
const proof = json(path.join(dir, 'provider-proof.json'));
const manifest = json(path.join(dir, 'manifest.json'));
const summary = json(path.join(dir, 'final/summary.json'));
checkDualConfig(manifest.config);
const scenario = hasScenario(manifest.config) ? dualScenario(manifest.config) : null;
const observationProfile = manifest.config.observationProfile ?? null;
assert.equal(proof.observationProfile ?? null, observationProfile);
assert.equal(summary.claims?.observationProfile ?? null, observationProfile);
const initialization = json(path.join(dir, 'initialization/game.json'));
assert.deepEqual(initialization.config, manifest.config);
assert.equal(proof.status, 'completed'); assert.equal(manifest.status, 'complete');
assert.equal(proof.modelCallsAttempted, proof.rounds.length * 2);
assert.equal(proof.retries, 0); assert.equal(proof.appInferenceCalls, 0);
assert(proof.callSlotsReserved <= proof.maxCalls);
const models = proof.assignment?.models ?? { blue: 'gpt-5.6-sol', red: 'claude-opus-5' };
assert.deepEqual(Object.keys(models).sort(), ['blue', 'red']);
assert.deepEqual(Object.values(models).sort(), ['claude-opus-5', 'gpt-5.6-sol']);
if (proof.assignment) {
  const swapped = models.blue === 'claude-opus-5';
  assert.equal(proof.assignment.swapProviders, swapped);
  assert.equal(proof.assignment.id, swapped ? 'opus-blue-sol-red' : 'sol-blue-opus-red');
  assert.deepEqual(proof.assignment.providers, swapped ? {blue:'opus',red:'sol'} : {blue:'sol',red:'opus'});
  assert.equal(proof.seed, manifest.config.seed);
}
assert.equal(manifest.history.length, proof.rounds.length);
assert.deepEqual(proof.summary, summary);
let promptsVerified = 0, artifactsVerified = 0, acceptedNullShareConstruction = 0;
const previousIds: Record<string, string[]> = { blue: [], red: [] };
const choices: unknown[] = [];
for (const round of proof.rounds) {
  assert.equal(round.applicationStatus, 'applied'); assert.equal(round.applied, true);
  const n = String(round.round).padStart(2, '0');
  const snapshots = ['blue', 'red'].map(seat => json(path.join(dir, `rounds/${n}/${seat}/snapshot.json`)));
  const rebuilt = observationProfile ? await rebuildSavedRound(dir, round.round) : null;
  assert.equal(snapshots[0].fingerprint, snapshots[1].fingerprint);
  for (const [index, seat] of ['blue', 'red'].entries()) {
    const row = round.seats[seat], snapshot = snapshots[index];
    const prefix = path.join(dir, `rounds/${n}/${seat}`);
    checkSeatSnapshot(snapshot);
    assert.equal(snapshot.seat, seat); assert.equal(snapshot.tick, round.tick);
    assert.equal(digest(path.join(prefix, 'prompt.md')), row.promptSha256);
    assert.equal(fs.readFileSync(path.join(prefix, 'prompt.md'), 'utf8'), renderDualPrompt(snapshot, scenario, observationProfile));
    if (rebuilt) {
      const saved = rebuilt[seat as 'blue' | 'red'];
      assert.equal(fs.readFileSync(path.join(prefix, 'snapshot.json'), 'utf8'), saved.snapshot);
      assert.equal(fs.readFileSync(path.join(prefix, 'prompt.md'), 'utf8'), saved.prompt);
    }
    assert.deepEqual(json(path.join(prefix, 'schema.json')), playerOutputSchema());
    const responsePath = within(dir, row.response), response = json(responsePath);
    const parsed = parseSeatChoice(JSON.stringify(response), snapshot, previousIds[seat]!);
    previousIds[seat]!.push(snapshot.snapshotId);
    const decision = json(path.join(dir, `results/${n}/${seat}/decision.json`));
    assert.equal(decision.responseSha256, digest(responsePath));
    assert.equal(decision.choice, parsed.choice); assert.equal(decision.share, parsed.share ?? null);
    const artifact = within(path.join(root, 'evidence/dual-model-trial'), path.relative(path.join(root, 'evidence/dual-model-trial'), path.resolve(root, row.providerArtifact)));
    assert.equal(digest(artifact), row.providerArtifactSha256);
    assert.equal(row.model, models[seat], 'Returned model must match its recorded seat assignment');
    if (row.model === 'gpt-5.6-sol') {
      assert.equal(row.model, 'gpt-5.6-sol'); assert.equal(row.personalAuthUnchanged, true);
      const events = fs.readFileSync(artifact, 'utf8').trim().split('\n').map(s => JSON.parse(s));
      const items = events.filter(e => e.item).map(e => e.item);
      assert(items.every(i => ['agent_message', 'reasoning'].includes(i.type)));
      assert(events.some(e => e.type === 'turn.completed'));
      assert.deepEqual(JSON.parse(items.filter(i => i.type === 'agent_message').at(-1).text), response);
      assert.equal(digest(within(path.join(root, 'evidence/codex'), path.relative(path.join(root, 'evidence/codex'), path.resolve(root, row.sourceProviderArtifact)))), row.providerArtifactSha256);
    } else {
      const raw = json(artifact);
      assert.equal(row.model, 'claude-opus-5'); assert.equal(row.toolsDisabled, true);
      assert(!raw.is_error && raw.modelUsage['claude-opus-5']);
      assert.deepEqual(raw.structured_output, response);
      if (response.share === null && decision.intent?.type === 'build_unit') acceptedNullShareConstruction++;
    }
    choices.push({ round: round.round, seat, choice: parsed.choice, share: parsed.share ?? null, intentType: decision.intent?.type ?? 'hold' });
    promptsVerified++; artifactsVerified++;
  }
}
for (const source of summary.sources) assert.equal(digest(within(dir, source.path)), source.sha256);
const final = json(path.join(dir, 'final/replay.json'));
const engine = await ReplayEngine.restore(final.record, final.record.turns.length, 'checkpoints');
assert.equal(engine.state().fingerprint, summary.reconstruction.finalFingerprint);
assert.equal(final.record.options.map, initialization.map);
if (scenario) {
 assert.equal(initialization.scenarioId, scenario.id); assert.equal(initialization.map, scenario.map);
 assert.equal(initialization.scenario.redCell.profile, scenario.redCellProfile);
}
assert.equal(engine.game.ticks(), summary.ticksSimulated);
const nonSpawn = final.record.turns.flatMap((t: any) => t.intents).filter((i: any) => i.type !== 'spawn');
assert.equal(nonSpawn.length, summary.reconstruction.listedSeatOrders);
assert.equal(summary.reconstruction.unlistedOrders, 0);
const result = { at: new Date().toISOString(), status: 'passed', trial: name, actualProviderCalls: proof.modelCallsAttempted,
  observationProfile, profiledRoundsRebuilt: observationProfile ? proof.rounds.length : 0,
  promptsVerified, artifactsVerified, sourceHashesVerified: summary.sources.length, acceptedNullShareConstruction,
  finalFingerprint: engine.state().fingerprint, ticks: engine.game.ticks(), scores: summary.scores,
  stopReason: summary.stopReason, outcome: summary.outcome, choices,
  claim: 'Saved provider replies, seat prompt projection, source hashes and final engine reconstruction verified. Scores, fun and training quality are not independently validated.' };
const out = path.join(root, 'evidence/platform', `${name}-main-review${suffix ? '-'+suffix : ''}.json`);
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
