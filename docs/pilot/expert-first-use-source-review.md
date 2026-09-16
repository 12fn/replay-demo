# Expert first use — independent source review

Written 2026-09-14, the day before the hackathon, by Claude (Opus 5) working alongside main. **Method: reading source and documents only.** No browser was opened, no game was run, no credentials, network, inference or deployment were used. Every risk below is a **source-based inference** about what a first-time expert is likely to hit; none is an observed session, a measured usability result or a measure of fun. This is independent product critique before the planned paired AI gameplay (`../playtests/whole-experience-red-team.md`), not a substitute for it or for human/SME validation.

Build context: deployed native `localhost/replay:0.16.0`; the 0.16.1 later-outcomes review is uncommitted local integration; the 7:51 video is 0.3.0 (`../stages/status.json`, `delivery` and `development`). Companion protocol: `expert-first-session.md`.

**Short answer to "can experts start guiding development tomorrow?"** Yes, as a **facilitated** critique session on the deployed build with paid features off. Not as unaided self-serve use: the integrated route has never been run by a human, and several review surfaces are unverified visually.

## Risks (at most five, highest impact first)

### R1. The integrated route has never been run end to end, and access is operator-bound

- **Evidence.** `../stages/status.json` line 143: "Full native shared-team example precedes paired Codex/Claude surrogate-player critique; neither full example nor paired trial has run." Line 211: `paired_player_trial: "not started"`. `formative-session-protocol.md` line 3: the first human session "has not been run". `../demo/integrated-readiness-0.11.md` line 5 puts human validation after the small example and paired trial. Access is a private loopback tunnel with installation-specific SSH configuration and no qualified public ingress (`../operator-runbook.md` lines 7 and 13). A commander seat needs a writable native workroom role (`instructor-guide.md` lines 38–46). Pending visual/focus checks cover the scenario dialog, Team dialog, stations/receipt panels and Decision perspective (`../stages/status.json` lines 112, 114, 116, 122).
- **Inference.** The likeliest first-session failure is not a game defect but setup: the expert cannot reach the build, lands in a read-only or unexpected seat, or hits an unverified panel layout, and the session turns into troubleshooting.
- **Severity.** Blocks the session.

### R2. Review's selection path is easy to miss, and the column is dense

- **Evidence.** `src/client/views/ReviewView.tsx` line 285 renders `DecisionTracePanel` with `eventId={highlight}`; `src/client/components/DecisionTracePanel.tsx` shows "Select an order to follow its recorded observation, action and outcome." until something is highlighted. The "Recent orders" title link calls only `seek(f.tick)` (`ReviewView.tsx` line 312), which moves the map without setting `highlight`. Selection happens through a Timeline entry (`focus(t.id)`, line 369), evidence chips (lines 128 and 345) or Key moments (`src/client/components/KeyMomentsPanel.tsx`, via `openEvidence`). The right column stacks up to nine panels (lines 285–430: Decision perspective, network, Order outcomes, Key moments, Recent orders, Timeline, Reports, Learning dossier, Instructor judgment) above or below one another. Decision perspective layout/focus is unverified (`../stages/status.json` line 122).
- **Inference.** An expert who clicks the most prominent order title sees the map jump but an empty "Decision perspective" at the top of the column, and may conclude the feature is broken or absent. The one review step that matters most for a domain critique (what was available versus what was chosen) sits behind a non-obvious click.
- **Severity.** Distorts or stalls the review step.

### R3. Fixed heuristic text reads like system judgment and advice

- **Evidence.** `src/server/service.ts` line 485 labels any order committing more than 65 percent as "Review tradeoff" and attaches a fixed alternative: "Branch here and compare a smaller commitment under the same starting conditions." `ReviewView.tsx` lines 339–343 renders it under a "later analysis" tag and a bold "Try instead:". The facilitator documents call this list the "Decisions" panel (`instructor-guide.md` lines 166 and 171; `README.md` line 48; `rubric-provisional.md` lines 12 and 21), while the UI title is "Recent orders" (`ReviewView.tsx` line 295).
- **Inference.** A teaching expert is primed to evaluate the product's feedback. "Later analysis … Try instead: a smaller commitment" reads as the system's pedagogical judgment that less commitment is better, which is exactly the misconception the curriculum warns against (`exercise-curriculum.json`, M6). Expert time goes to critiquing canned text, or the expert leaves believing REPLAY evaluates decisions. The label drift also makes the facilitator's instructions point to a panel name that does not exist on screen.
- **Severity.** Misleading.

### R4. The clock and scenario limit invite real-time and duration assumptions

- **Evidence.** `src/client/lib.ts` line 17 (`tickClock`) derives minute:second from ticks; `src/client/components/Header.tsx` line 138 shows "tick N · m:ss" beside the fingerprint. The stations scenario description says "The 20-minute limit is a cap; elimination can end play sooner" (`src/scenarios/catalog.ts` line 33). Measured play so far: a passive Blue eliminated in 41 seconds and candidate mirror games resolving in 5.43 and 6.56 simulated minutes (`../stages/status.json` lines 111, 113, 117); native clock-progress checks are two-minute automated runs, not human sessions (line 61, 78).
- **Inference.** An expert can reasonably read m:ss as the scenario's operational tempo or plan around a 20-minute contest, then be surprised by an early end or draw conclusions about decision timing that the abstract game cannot support. This is framing, not a defect, but it is the kind of misreading that later appears as "realism" feedback.
- **Severity.** Misleading if unframed; cheap to mitigate.

### R5. Retry evidence is partly off-screen, and the newest review option is not deployed

- **Evidence.** The branch panel (`ReviewView.tsx` lines 249–281) offers side and "Branch at tick N" but no field for the assumption that `instructor-guide.md` §5.4 and curriculum OBJ-7 require in writing. The "Include later outcomes" checkbox and its hindsight labelling exist only in the uncommitted working tree (`git diff` on `src/client/components/DecisionTracePanel.tsx` and `ReviewView.tsx`; `../stages/status.json` lines 148–149, `not_deployed: true`). The curriculum lists no reviewed domain sources (`exercise-curriculum.json`, `SRC-000` "No reviewed sources").
- **Inference.** If an expert chooses counterfactual practice or evidence currency, the most relevant evidence (the stated assumption, a hindsight-separated comparison) is either on paper or absent from the deployed screen. A facilitator working from today's local screens could promise a comparison view that 0.16.0 does not show. With no reviewed sources, domain-content requests cannot be satisfied during the hackathon and should be logged, not improvised.
- **Severity.** Evidence gap for two of the six skills.

## Top three actions before tomorrow

1. **Run the exact expert path once on deployed 0.16.0 with real provisioned accounts** (owner: main, who owns deployment and runtime qualification). Expert-like commander account plus instructor account, paid features off, request counter recorded before and after. Path: sign in → New → stations and reserves → one order with Decision note → Release report → End for review → select that order via Timeline → Decision perspective → Branch → return to source. Fix or document any break; confirm how the expert reaches the build (own device versus facilitator machine). Addresses R1 and R2, and gives the first visual look at the pending Decision perspective layout.
2. **Hand the facilitator the verified click path and correct names** (owner: facilitator/docs; optional small UI change for main). Use `expert-first-session.md` §5 notes: "Recent orders", select via Timeline or evidence chip, assumption on paper, no later-outcomes toggle on 0.16.0. Separately, main may decide whether the "Recent orders" title link should also select the order, and whether "later analysis / Try instead" wording should say it is fixed threshold text; those are app-code decisions outside this review. Addresses R2, R3 and R5.
3. **Read the framing aloud at the start of every session** (owner: facilitator). Abstract fictional game, scripted uncalibrated opponent, simulated ticks rather than real-world time, scenario limit is a cap, outcome is not quality, threshold labels are not judgments, realism requests are logged as domain content requests. This is already the briefing in `expert-first-session.md` §3. Addresses R3 and R4 at zero engineering cost.

## Limits of this review

- Source and document reading only; no rendered layout, timing, clicks or human reactions were observed. Panel ordering, scroll position and discoverability claims are inferences from JSX order and handlers.
- Only the client views, `ReviewView`/`ExerciseView` panels, the scenario catalog, the named server line and the listed documents were inspected. Engine behaviour, opponent quality, pacing and runtime health were taken from `../stages/status.json` as recorded by main, not re-verified.
- Nothing here establishes fun, usability, learning, realism or opponent adequacy. Those remain for the paired AI trial, the human formative session and SME review.

## Main follow-up after independent review

Opus5 returned both documents through the authenticated subscription.0.16.1 deployed and native read-only later-outcomes qualification passed after one initial503login failure; that failure is retained. Browser testing at383px wide then found the stacked review grid compressed the evidence column to77px, with map content overlapping it.0.16.2 addresses that measured first-use defect, makes the prominent order title select its exact decision, and labels fixed review prompts while removing the implication that lower commitment is inherently better. These actions update R2/R3/R5; they do not constitute the full exercise or expert validation. The facilitator guide has also been edited to solicit fun, domain fidelity and instructional needs directly, allow bounded AI demonstration, and retain expert content requests as feasible hackathon work rather than automatically deferring them.
