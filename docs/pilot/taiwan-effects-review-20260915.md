# Taiwan full-game effects review (2026-09-15)

Target: `evidence/dual-model-trial/taiwan-sol-blue-opus-red-full-20260915` (Sol Blue, Opus 5 Red, seed `DUAL0001`, 17 rounds, Blue elimination win 84–52 at tick 4392). This covers fictional game mechanics only; nothing here models or recommends a real force, doctrine or plan.

## Checks: static vs executed

- **Static:** manifest, outcome and decision records, R15–R16 prompts and snapshots. Source: `ConstructionExecution.ts`, `PlayerImpl.canBuild`, `engine.ts` validate, `execution-feedback.ts`, `dual-model-trial.ts`, `ai-player-trial.ts`.
- **Executed (zero provider, no network):** a temporary vitest wrapper (since deleted) restored the saved `rounds/15` and `rounds/16` checkpoints and re-ran the queued orders. The actual queues reproduced the saved fingerprints `0e603671…` (R15) and `45966dc3…` (final). The same wrapper ran counterfactuals against Blue's fixed recorded order. Blue can't adapt in these runs, so they probe mechanics only; they say nothing about strength.
- **Not run:** full suite, typecheck, Python tests.

## Only one construction failed

| Round | Red intent | Prestate legality | Execution admission | Engine effect | Model decision |
|---|---|---|---|---|---|
| 15 | Defense Post, tile 43334 (Western relay centre) | legal at 4095 | admitted `4095:0:redai001` (Red led) | `construction-started@4096`, `construction-completed@4147`; destroyed by conquest between 4370 and 4375 | Chosen over a City on the same tile |
| 16 | City, tile 38126 | legal at 4365 (`canBuild` returned 38126) | admitted `4365:1:redai001` (Blue led) | `construction-not-started@4366`; no gold charged; no state effect | Rationale: idle 446k gold; a City adds capacity without committing troops |

The saved records show one Defense Post completed and one City that never started, not two failed builds. The CLI silences `console.warn` (`scripts/dual-model-trial.ts:572`), so the warning came from a non-CLI reconstruction. Any restore that replays turn 4365 prints it again.

**Mechanism (executed trace):**
1. Both orders entered turn 4365. `ConstructionExecution.init` checks only that the unit is enabled and the tile is valid.
2. On the next engine tick, Blue's attack (intentIndex 0) ticked first and took 83 Red tiles (1594→1511), including 38126.
3. Red's construction then ticked. `canBuild` requires `owner(tile) === player` (`PlayerImpl.ts:1711`), so it returned false and printed `cannot build City` (`ConstructionExecution.ts:59–63`).
4. Gold before and after was 446,500. The final fingerprint equals the Blue-attack-only counterfactual, so the order left no trace.

**Counterfactuals:**
- **Red leading the queue:** the City starts at 4366 for 125,000 gold. Its tile falls that same tick. The City completes at 4387 owned by Blue (`human001`), and Red is still eliminated at 4392.
- **Every listed R16 option:** all 52 (hold, 44 troop options, 7 structures) end in elimination between ticks 4392 and 4453. The City choice was immaterial.
- **Site exposure:** all three listed City sites were 1 tile from Blue.

## Actionable issues

### 1. "Executed" hides the missing effect and its reason

- **Where:** R16 Red. `summary.json` gives Red `executedAtTick: 17` (`dual-model-trial.ts:541`). `results/16/outcome.json` stores only `{key, tick, status}` (`:499`). `ConstructionTracker` (`execution-feedback.ts:269–287`) records that no structure appeared, but not why. The journal's "cannot build City" came from console output, not from any recorded field.
- **Fix (versioned opt-in, new games only):**
  - In `beforeTick`, capture `tileOwnerAtAttempt`. This is observation only and stays outside the fingerprint.
  - Derive a `reason`, e.g. `ordered-tile-lost-before-first-tick` or `unaffordable`.
  - Persist it under e.g. `game.json` `feedbackDetail: "execution-feedback-reasons/1"`, and add a summary count `admittedWithoutObservedEffect`.
  - Legacy outcome and summary shapes stay unchanged, and so do the `status@tick` strings in `previousDecisionsFor` (`:316`). Saved prompt and snapshot hashes therefore still rebuild.
- **Tests:**
  - (a) `tests/execution-feedback.test.ts`: the opponent conquers the tile in the same turn → `construction-not-started`, owner is the opponent, `goldDelta` is 0.
  - (b) Evidence regression: restore `rounds/16/replay.json`, apply the recorded queue, assert `45966dc3…` plus status and reason.
  - (c) The legacy rebuild tests (`tests/learning/dual-model-trial.test.ts`, `tests/fixtures/player-context-legacy`) stay byte-identical without the flag.

### 2. Structure sites ignore exposure to the opponent

- **Where:** `scripts/ai-player-trial.ts:471–491` ranks sites only by distance to the station centre, capped at 3 per type, and the meaning text doesn't mention the opponent. At R16, City sites 38126, 36921 and 17332 were each 1 tile from Blue.
- **Fix:** opt-in `structure-sites/2`, recorded in the snapshot so seat-context/1 ids and prompts don't change. Add `nearestOpponentTiles` to each site and reserve one slot per type for the owned site farthest from the opponent. It must not predict survival.
- **Tests:** a fixture where the sites nearest the station border the opponent must list an interior site under v2. v1 must still regenerate `rounds/16/red/snapshot.json` exactly; the existing `stepGame` rebuild check covers this.

### 3. Same-turn ordering changes structure outcomes, and seats can't see it

- **Where:** `dual-model-trial.ts:295–302` applies both orders in one turn, led by `leadingSeat(round)`. The order is recorded in `round.json` and `outcome.json` but is not in the observation. At R16, Blue leading turned the City into a free no-op; Red leading would have handed the City to Blue.
- **Fix:** an opt-in observation version with a public `turnOrder` note: the leading seat's order applies first, so a build on a tile the other order can take may not start, or may be captured. No private information is revealed.
- **Tests:**
  - Correct leading seat in even and odd rounds.
  - An R16 checkpoint regression asserting both queue-order outcomes.
  - Legacy snapshots unchanged.

## Is the Red loss confounded?

**Neither the failed build nor the late menu caused it.** Rounds 11–14 (ticks 3015–4095) decided the game:
- Red went from 15,570 tiles and 679,883 troops to 4,755 tiles and 315,100 troops.
- Blue went from 11,383 tiles to 22,198.
- Blue repeated land attacks at share 0.5 (R11, R12, R14–R16).
- Red sent transports at shares 0.35–0.5 toward Western relay (R11, R13, R14), then built structures.
- Earlier, Red led 26–24 after R6 and held more tiles at 8 of 9 round starts from R3 to R11.

**Confounds present:**
- **Model and seat are bound together:** Opus always played Red, in one seed with no seat swap.
- **Geography:** at R0, Blue could reach 3 of 5 stations by land, Red only 1. Penghu was transport-only for both. Red's early lead does not rule out a decisive geographic advantage. The start makes Red more dependent on transports; its causal contribution is unmeasured.
- **Red-only brief:** `strait-red-cell/1` stresses reserve and overextension. Both seats cite reserve in most rationales, so any effect is unmeasured.
- **The R15 menu offered alternatives (fixed Blue):**
  - A City at the station centre left Red with 373,174 troops vs 237,121 for the Defense Post.
  - A 0.5 border attack left 3,256 tiles vs 1,594.
  - Transports to Penghu or Southern at share ≥0.2 led to elimination by tick 4134.

**Equal harness rules, not proof of equal opportunity:**
- **Candidates:** both seats get the same `enrichedCandidates` menu. Sizes were similar (Red 4–19, Blue 4–18), both share caps are 0.5, and neither seat can aim a land attack.
- **Cadence and feedback:** cadence is equal (270/270), and attack feedback is unobserved for both seats.

**Assessment:** this is one legal, reproducible game. It is not evidence of model strength, Red Cell quality or scenario balance; judging those needs seat-swapped runs across multiple seeds.


## Main review and retained reproduction

Main independently reran the actual R16 queue, Blue alone, and reversed queue with the fixed recorded Blue action. `evidence/platform/taiwan-construction-race-20260915.json` preserves hashes, full construction observations and fingerprints. Actual and Blue-only final fingerprints match; reversed queue starts/completes a City but Red is still eliminated at4392. Other temporary-worker sweeps above remain worker-reported, not independently retained reproduction. Equal candidate code does not ensure equal practical options across geography. Neither an early lead nor one result resolves scenario balance.
