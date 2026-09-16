/**
 * Transport-return diagnosis: why an admitted AI-player transport came straight back.
 *
 * Contract (read-only, offline by default):
 *  - Reads a finished trial's immutable `decisions/NN/{replay,snapshot}.json`, `outcomes/NN/{decision,receipts}.json`
 *    and, when present, the next checkpoint `decisions/NN+1/replay.json` (for the recorded turns and fingerprints).
 *  - Rebuilds two disposable in-memory engines from the checkpoint: one replays the recorded interval untouched and
 *    checks it reproduces the receipts and the next checkpoint's fingerprint; the other is a probe that answers
 *    terrain-only pathfinding questions. Neither is saved, served or attached to any exercise.
 *  - No network, provider, credential, native-platform or database access. Evidence files are hashed before and after
 *    and the run fails if any changed. Output goes to stdout; `--out` writes one new file outside `evidence/` and
 *    never overwrites.
 *  - Fictional game mechanics only.
 *
 *   pnpm exec tsx scripts/diagnose-transport-return.ts [--trial DIR] [--decision 2] [--scan 300] [--out /tmp/diag.json]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CLIENTS, ReplayEngine, type EngineRecord, type ExecutionFeedbackEvent, type Side } from '../src/engine/engine';
import { UnitType, type Game, type Player } from '../vendor/openfront/src/core/game/Game';
import type { GameMap } from '../vendor/openfront/src/core/game/GameMap';
import { canBuildTransportShip, targetTransportTile } from '../vendor/openfront/src/core/game/TransportShipUtils';
import { PathFinding, WaterPathFinder } from '../vendor/openfront/src/core/pathfinding/PathFinder';
import { AStarWater } from '../vendor/openfront/src/core/pathfinding/algorithms/AStar.Water';
import { PathStatus } from '../vendor/openfront/src/core/pathfinding/types';

console.debug = () => {}; console.warn = () => {};
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
const trialDir = path.resolve(ROOT, arg('trial') ?? 'evidence/ai-player-trial/enriched-sol-20260915');
const decision = Number(arg('decision') ?? 2);
const scanCap = Math.max(0, Math.min(2000, Number(arg('scan') ?? 0)));
const outPath = arg('out');
if (outPath !== undefined) {
  const abs = path.resolve(outPath);
  if (abs.startsWith(path.join(ROOT, 'evidence') + path.sep)) throw new Error('--out must not point inside evidence/');
  if (fs.existsSync(abs)) throw new Error('--out already exists; refusing to overwrite');
}

interface Checkpoint { tick: number; record: EngineRecord; pending: { side: Side; intent: Record<string, unknown> }[] }
const rel = (k: number) => String(k).padStart(2, '0');
const read = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
const files = [`decisions/${rel(decision)}/replay.json`, `decisions/${rel(decision)}/snapshot.json`, `outcomes/${rel(decision)}/decision.json`, `outcomes/${rel(decision)}/receipts.json`, `decisions/${rel(decision + 1)}/replay.json`]
  .map((f) => path.join(trialDir, f)).filter((f) => fs.existsSync(f));
const hashAll = () => Object.fromEntries(files.map((f) => [path.relative(ROOT, f), createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
const hashesBefore = hashAll();

const cp = read<Checkpoint>(path.join(trialDir, `decisions/${rel(decision)}/replay.json`));
const snap = read<{ fingerprint: string; tick: number }>(path.join(trialDir, `decisions/${rel(decision)}/snapshot.json`));
const chosen = read<{ intent: { type: string; dst: number; troops: number }; meaning: string; share?: number }>(path.join(trialDir, `outcomes/${rel(decision)}/decision.json`));
const receipts = read<{ fromTick: number; toTick: number; modelOrder: { executedKey: string }; modelFeedback: { key: string; tick: number; status: string }[] }>(path.join(trialDir, `outcomes/${rel(decision)}/receipts.json`));
const nextPath = path.join(trialDir, `decisions/${rel(decision + 1)}/replay.json`);
const next = fs.existsSync(nextPath) ? read<Checkpoint>(nextPath) : null;
assert.equal(chosen.intent.type, 'boat', 'the chosen response is not a transport');
const sideOf = (clientID: string): Side => (Object.entries(CLIENTS).find(([, c]) => c === clientID)![0] as Side);
const strip = ({ clientID: _c, ...intent }: Record<string, unknown>) => intent;

// ---------------------------------------------------------------- 1. Reproduction on a disposable engine.
const feedback: ExecutionFeedbackEvent[] = [];
const repro = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints', { feedback: { listener: (ev) => feedback.push(ev) } });
feedback.length = 0;
const restoredFingerprintMatches = repro.state().fingerprint === snap.fingerprint;
const recordedTurn = next?.record.turns[cp.tick];
const turnOrders = recordedTurn
  ? recordedTurn.intents.map((i) => ({ side: sideOf(i.clientID), intent: strip(i as unknown as Record<string, unknown>) }))
  : [{ side: 'blue' as Side, intent: chosen.intent }, ...cp.pending.map((p) => ({ side: p.side, intent: p.intent }))];
assert.ok(isDeepStrictEqual(turnOrders[0], { side: 'blue', intent: chosen.intent }), 'first order at the decision tick is not the chosen transport');
repro.step(turnOrders);
const endTick = next ? Math.min(receipts.toTick, next.record.turns.length) : cp.tick + 2;
while (repro.game.ticks() < endTick) {
  const t = next?.record.turns[repro.turns.length];
  repro.step(t ? t.intents.map((i) => ({ side: sideOf(i.clientID), intent: strip(i as unknown as Record<string, unknown>) })) : []);
}
const blueEvents = feedback.filter((ev) => ev.keyString === receipts.modelOrder.executedKey);
const reproduction = {
  restoredAtTick: cp.tick, restoredFingerprintMatchesSnapshot: restoredFingerprintMatches,
  turnSource: recordedTurn ? `decisions/${rel(decision + 1)}/replay.json turns[${cp.tick}]` : 'chosen intent + checkpoint pending (no next checkpoint)',
  feedbackMatchesReceipts: isDeepStrictEqual(blueEvents.map((ev) => ({ key: ev.keyString, tick: ev.tick, status: ev.status })), receipts.modelFeedback),
  replayedToTick: repro.game.ticks(),
  fingerprintAtEndMatchesNextCheckpoint: next ? repro.state().fingerprint === next.record.fingerprints[repro.game.ticks()] : null,
  events: blueEvents.map((ev) => ({ tick: ev.tick, status: ev.status, observed: ev.observed })),
};

// ---------------------------------------------------------------- 2. Probe engine: legality vs route vs arrival.
const probe = await ReplayEngine.restore(cp.record, cp.record.turns.length, 'checkpoints', { observeExecution: false });
const g: Game = probe.game; const blue: Player = probe.player('blue'); const map = g.map(); const mini: GameMap = g.miniMap();
const xy = (m: GameMap, t: number) => ({ x: m.x(t), y: m.y(t) });
const n4 = (m: GameMap, t: number) => { const buf = [0, 0, 0, 0]; return buf.slice(0, m.neighbors4(t, buf)); };
/** ShoreCoercingTransformer.bestWaterNeighbor, reproduced read-only on the given map. */
const bestWaterNeighbor = (m: GameMap, t: number) => { let best = -1, score = -1; for (const n of n4(m, t)) { if (!m.isWater(n)) continue; const s = n4(m, n).filter((k) => m.isWater(k)).length; if (s > score) { score = s; best = n; } } return best; };
/** What the water chain (disableNavMesh: simple AStarWater on the minimap) sees for one full-resolution endpoint. */
const endpoint = (t: number) => {
  const m = mini.ref(Math.floor(map.x(t) / 2), Math.floor(map.y(t) / 2));
  const coerced = mini.isWater(m) ? m : bestWaterNeighbor(mini, m);
  return { tile: t, ...xy(map, t), land: map.isLand(t), shore: map.isShore(t), waterComponent: g.getWaterComponent(t),
    owner: g.hasOwner(t) ? g.owner(t).id() : null,
    mini: { tile: m, ...xy(mini, m), water: mini.isWater(m), neighbours: n4(mini, m).map((k) => ({ ...xy(mini, k), water: mini.isWater(k) })), coercedWaterTile: coerced === -1 ? null : { tile: coerced, ...xy(mini, coerced) } } };
};
const intent = chosen.intent;
let validateError: string | null = null; try { probe.validate('blue', intent); } catch (e) { validateError = (e as Error).message; }
const landing = targetTransportTile(g, blue, intent.dst);
const launchAtCheckpoint = landing === null ? false : canBuildTransportShip(g, blue, landing);
const actualLaunch = (reproduction.events[0]?.observed as { launchTile?: number } | undefined)?.launchTile;
const src = actualLaunch ?? (launchAtCheckpoint === false ? null : launchAtCheckpoint);
assert.ok(landing !== null && src !== null, 'probe could not resolve the landing and launch tiles');
const shoreSources: number[] = []; const landingComponent = g.getWaterComponent(landing);
blue.borderTiles().forEach((t) => { if (map.isShore(t) && map.isLand(t) && g.getWaterComponent(t) === landingComponent) shoreSources.push(t); });
const graphVersionBefore = g.waterGraphVersion(), waterVersionBefore = map.waterVersion();
const singleFirst = PathFinding.Water(g).findPath(src, landing);
const multi = PathFinding.Water(g).findPath(shoreSources, landing);
const singleAgain = PathFinding.Water(g).findPath(src, landing);
const stepper = new WaterPathFinder(g, 0).next(src, landing);
const srcEnd = endpoint(src), dstEnd = endpoint(landing);
const rawMini = srcEnd.mini.coercedWaterTile && dstEnd.mini.coercedWaterTile ? new AStarWater(mini).findPath(srcEnd.mini.coercedWaterTile.tile, dstEnd.mini.coercedWaterTile.tile) : null;
const findings = {
  submission: { validateError, transportRefusal: probe.transportRefusal(blue, intent.dst), transportLanding: { tile: landing, ...xy(map, landing) }, landingIsOrderedTile: landing === intent.dst },
  launch: { atCheckpointTick: launchAtCheckpoint === false ? null : { tile: launchAtCheckpoint, ...xy(map, launchAtCheckpoint) }, observedAtInit: actualLaunch === undefined ? null : { tile: actualLaunch, ...xy(map, actualLaunch) }, sameTile: actualLaunch === launchAtCheckpoint },
  route: {
    note: 'The water chain reads terrain only; for one (from, to) pair and one water graph version its answer is fixed (PathFinder.ts WaterPathMemo comment).',
    sameWaterComponent: g.getWaterComponent(src) === landingComponent,
    multiSourceFromOwnedShoresFound: multi !== null, multiSourcePathStart: multi?.length ? { tile: multi[0], ...xy(map, multi[0]!) } : null, multiSourceLength: multi?.length ?? null, ownedShoreSources: shoreSources.length,
    singleSourceFromLaunchFound: singleFirst !== null, singleSourceRepeatSameAnswer: (singleFirst === null) === (singleAgain === null),
    stepperFirstStatus: PathStatus[stepper.status], rawMinimapAStarBetweenCoercedTiles: rawMini !== null,
    waterGraphVersion: graphVersionBefore, waterGraphVersionUnchangedByProbe: g.waterGraphVersion() === graphVersionBefore && map.waterVersion() === waterVersionBefore,
    launchEndpoint: srcEnd, landingEndpoint: dstEnd,
  },
};

// ---------------------------------------------------------------- 3. Human parity (same validator the server calls).
// service.ts submit and tick both call ReplayEngine.validate(side, intent); the UI "Boat to tile" button sends
// {type:'boat', dst:selectedTile, troops} for any selected unowned land tile, so the identical intent is reachable.
let humanAdmitted = true, humanReason: string | null = null;
try { probe.validate('blue', { type: 'boat', dst: intent.dst, troops: intent.troops }); } catch (e) { humanAdmitted = false; humanReason = (e as Error).message; }

// ---------------------------------------------------------------- 4. Optional bounded scan of other admitted landings.
let scan: unknown = null;
if (scanCap > 0) {
  const seen = new Set<number>(); let admitted = 0, singleNull = 0, examined = 0; const examples: unknown[] = [];
  for (let t = 0; t < map.width() * map.height() && examined < scanCap; t++) {
    if (!map.isLand(t) || !map.isShore(t) || g.owner(t) === blue || probe.transportRefusal(blue, t) !== null) continue;
    const l = targetTransportTile(g, blue, t); if (l === null || seen.has(l)) continue; seen.add(l); examined++;
    const s = canBuildTransportShip(g, blue, l); if (s === false) continue; admitted++;
    if (PathFinding.Water(g).findPath(s, l) === null) { singleNull++; if (examples.length < 10) examples.push({ landing: xy(map, l), launch: xy(map, s), launchMiniWater: endpoint(s).mini.water, launchMiniCoerced: endpoint(s).mini.coercedWaterTile !== null, landingMiniCoerced: endpoint(l).mini.coercedWaterTile !== null }); }
  }
  scan = { cap: scanCap, distinctLandingsExamined: examined, admitted, admittedButLaunchToLandingRouteMissing: singleNull, examples };
}

const hashesAfter = hashAll();
assert.ok(isDeepStrictEqual(hashesBefore, hashesAfter), 'evidence changed during a read-only diagnosis');
const result = {
  schema: 'replay.transport-return-diagnosis/1', trial: path.relative(ROOT, trialDir), decision, tick: cp.tick,
  chosen: { intent, share: chosen.share, meaning: chosen.meaning },
  reproduction, findings, humanParity: { sameValidator: 'ReplayEngine.validate (src/server/service.ts submit and tick)', admitted: humanAdmitted, reason: humanReason }, scan,
  evidenceHashes: hashesBefore, evidenceUnchanged: true,
  contract: 'read-only; offline; disposable in-memory engines; no provider, network, credential or native calls',
};
const text = JSON.stringify(result, null, 2) + '\n';
if (outPath !== undefined) fs.writeFileSync(path.resolve(outPath), text, { flag: 'wx' });
process.stdout.write(text);
