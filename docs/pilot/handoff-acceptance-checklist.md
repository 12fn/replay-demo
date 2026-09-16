# Pilot handoff acceptance checklist and gates (content revision 2)

Statuses are as of September 13, 2026. Allowed statuses: **pending** (not yet checked), **verified-by-automation** (a receipt or named test exists, cited), **blocked** (depends on unbuilt capability), **manual-substitute** (acceptable for pilot via a documented workaround), **unknown** (deployed, no evidence either way). No item is marked passed without a cited receipt. Update this file, do not overwrite history; add a dated line under an item when its status changes. Main reports the full suite (239 tests) and typecheck passing on this build; individual tests are named where they are the evidence.

## A. Exercise integrity

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| A1 | Human and software controller act in the same continuous world | verified-by-automation | `evidence/poc/qualification.json` (two scripted input sources, 450 ticks); `evidence/poc/live-inference-and-browser.json` (browser-issued Blue order and 22 real model decisions in one live exercise, automated browser). |
| A2 | Illegal orders are rejected with a reason and recorded | verified-by-automation | `tests/server/recovery.test.ts` "blocks host actions, unowned units, impossible commitments and undelegated intelligence orders"; `command_rejected` events written by `tick()`. |
| A3 | Rewind reproduces original fingerprints at independently selected ticks over a full-length record | verified-by-automation (accelerated) | `evidence/soak/long-replay.json`: 72,000 ticks, six seeks matched, final seek 565 ms, full-verification quarter and 50 continuation ticks matched. Not a human session, not wall-clock. |
| A4 | Branch diverges legally; original unchanged | verified-by-automation | `evidence/poc/browser-red-branch.json` (Red branch at tick 2403, parent fingerprint unchanged); recovery test "forks exact state and pre-fork information". |
| A5 | Branch receives only reports and events available at the fork; inherited events are not attributed as new decisions | verified-by-automation | `branch()` copies reports with `tick <= fork` and stores prior events as `inherited_event`; recovery test above. Manual check with a late instructor release still pending. |
| A6 | Orders and watches survive API restart with no duplicate effect | verified-by-automation | `tests/server/recovery.test.ts` "persists an order before execution; restart and exact retry apply it once" and "resumes a durable provenance watch without duplicate updates". |
| A7 | Service fault stops order acceptance and records the event | pending | `service_fault` path exists in `tick()`; not exercised. |
| A8 | Elimination ends the exercise and labels outcome as separate from reasoning | verified-by-automation | `exercise_completed` event observed in `evidence/poc/live-inference-and-browser.json` run. Pacing for 60–120 minutes with a human: pending (C2, C3). |

## B. Recording completeness for assessment

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| B1 | Every human order records observed tick, troops, pre/post state, actor, side | verified-by-automation | `tests/server/learning-routes.test.ts` "persists a contemporaneous rationale with the order". Verify on one real session's event log. |
| B2 | Every report release records tick, side, supersession | verified-by-automation | `injectReport()`; recovery watch test. |
| B3 | Watch updates record source report IDs and method | verified-by-automation | recovery watch test; `staff_update.details.sourceIds`. |
| B4 | Staff questions and answers recorded with report IDs used; invalid citations discarded | verified-by-automation (deterministic stub) | learning-routes test "a model staff answer marks staff-assisted". Live paid check not repeated. |
| B5 | Model opponent decisions recorded as action summary plus tool calls, never as reasoning | verified-by-automation | `tests/agents/loop.test.ts`; live run receipts in `evidence/poc/live-inference-and-browser.json` show `summary` and `calls`. |
| B6 | Learner rationale capture in-app (optional, contemporaneous, source-validated) | verified-by-automation | learning-routes test "persists a contemporaneous rationale ... rejects citations not available to that side at submission". Human use pending. |
| B7 | Post-hoc statements recorded separately and own-subject only | verified-by-automation | learning-routes test "records post-hoc decision statements separately". |
| B8 | Assessment log limited to intelligence/instructor; timing labeled | verified-by-automation | learning-routes test "assessment entries belong to the intelligence seat and are post-hoc when not viewing live play". |
| B9 | Dossier compares only the subject's own attributed attempts; branches labeled informed practice | verified-by-automation | learning-routes test "compares only the subject's own attributed attempts"; `tests/learning/dossier.test.ts`. |
| B10 | Generated debrief validated; rejected output logged and never shown; no paid retry | verified-by-automation | learning-routes tests "rejects a debrief with a hallucinated citation" and "fails safely without a credential"; `tests/learning/debrief.test.ts`. Live paid debrief not yet run. |
| B11 | Instructor corrections and released findings | verified-by-automation; SME use pending | Append-only judgment versions, optimistic conflicts and evidence-required scoring: `tests/review/assessment.test.ts`. |
| B12 | Learning record export | verified-by-automation and native API | Authorized JSON/Markdown bundle includes complete released evidence and curriculum/record integrity references; native proof `evidence/poc/native-learning-bundle.json`. |

## C. Session feasibility

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| C1 | 20-minute formative playtest without presenter coaching | pending | |
| C2 | 60-minute human session completed on the clock; idle stretches and confusing controls logged | pending | |
| C3 | 120-minute wall-clock run with two participant surfaces | pending | Accelerated simulation only (A3). |
| C4 | Deterministic opponent creates non-trivial commitment decisions without eliminating an active human early | pending | Instructor judgment plus order-rate count. |
| C5 | Instructor can release reports reliably after tick 600 | pending | Control exists (`POST /api/reports/inject`, instructor only). |
| C6 | Dry-run script in instructor guide section 2.7 completes | pending | |

## D. Assessment materials

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| D1 | Rubric reviewed by assessment SME | pending | `acceptance-and-pilot-forms.md` form 1. |
| D2 | Domain SME confirms no real-tactics or targeting content | pending | |
| D3 | Probe Forms A and B judged equivalent by a reviewer | pending | Equivalence assumed. |
| D4 | Two-rater agreement measured on a scored subset | pending | |
| D5 | Misconceptions list reviewed | pending | |

## E. Records, consent, privacy

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| E1 | Consent text reviewed by privacy/compliance | pending | |
| E2 | External model data flows disclosed and accepted, or PV-4 chosen | pending | Flows listed in `consent-and-learning-records.md` section 3. |
| E3 | Pseudonym mapping kept separately and destroyed per policy | pending | |
| E4 | No credentials in logs, screenshots, or package | pending | Error handlers redact `sk-` patterns; platform errors redact tokens; verify on artifacts. |
| E5 | Native session store excluded from every export | pending | Procedure in `assessment-data-export.md`. |

## F. Sources

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| F1 | At least one source reviewed with the template before any citation | pending | No source reviewed; approved dataset contents remain deferred; only metadata exists. |
| F2 | Synthetic status of reports labeled in UI and dossier | verified-by-automation (code) | Reports carry `synthetic: true`; Staff and Review views render a "synthetic" tag; dossier limitations state no reviewed source is loaded. Browser check with a human pending. |

## G. Platform (required before claiming native features)

| # | Item | Status | Evidence / note |
| --- | --- | --- | --- |
| G1 | Authenticated identity resolves seat from workroom role; writes need fresh `can_edit` | verified-by-automation and one live login | `evidence/platform/native-session-qualification.json` (owner → instructor, ReBAC allow); `tests/server/native-session.test.ts`, `tests/server/native-http.test.ts`. |
| G2 | Operator profile tailors seat presentation without granting permission | verified-by-automation | `readProfile` in `native-session.ts`; tests in `native-session.test.ts`. Live profile not yet applied (`profileApplied: false` in the receipt). |
| G3 | REPLAY extension Running with retained volume | verified-by-automation | `evidence/platform/replay-upgrade.json` (phase Running, image 0.2.0-native). Private service access only. |
| G4 | Workroom Graphiti ontology instance exists | verified-by-automation | `evidence/platform/ontology-created.json` (status pending, ingestion status none at creation). |
| G5 | CPU embedding service answers with 384-dimensional vectors | verified-by-automation | `evidence/platform/graphiti-embedding-qualification.json`. |
| G6 | Ontology ingest and search cycle traced (spec A11) | **unknown** | Publish route exists (`POST /api/ontology/publish`); no ingest or search receipt. Do not claim. |
| G7 | Tomo conversational surface | blocked | REPLAY staff panel only. |
| G8 | Placement on the Spark pair, public ingress | blocked / not shown | Not part of the pilot. |

## H. Performance gates (proposed targets from the specification; none measured with humans)

| Gate | Target | Current evidence | Status |
| --- | --- | --- | --- |
| P1 Human order admission | p95 ≤ 250 ms on the local network | None measured | pending |
| P2 Material watch update latency (deterministic) | ≤ 10 s from release to visible update | Evaluated every 100 ticks (10 s) and immediately at release by design | pending measurement |
| P3 Cold seek | ≤ 30 s to an arbitrary tick on the selected scenario | 565 ms to tick 72,000 in accelerated replay | verified-by-automation (accelerated) |
| P4 Continuous play under model latency | No pause while a completion is in flight | Design: pulse runs detached; recovery test "lets live ticks progress while a separate reconstruction yields" | verified-by-automation (partial) |
| P5 Two-hour wall-clock run | One 120-minute run with two participant surfaces, opponent and two watches | None | pending |
| P6 Restart recovery | Orders and watches resume once; paid features paused | recovery tests | verified-by-automation |

## I. Educational gates (must pass before results are reported outside the team)

| Gate | Requirement | Status |
| --- | --- | --- |
| L1 | Learners produce contemporaneous decision notes at a usable rate (report notes per order, per learner) | pending |
| L2 | Two raters agree on rubric scores on at least one third of sheets (report the statistic) | pending |
| L3 | Probe forms judged equivalent by a reviewer; results reported by form order | pending |
| L4 | SME acceptance form (form 1) signed with each criterion marked keep/revise/drop | pending |
| L5 | Domain SME statement that no real-world tactics, targeting or doctrine is modeled | pending |
| L6 | Every reported claim traces to an event, report, task, statement or probe; no outcome-based scoring found on audit | pending |
| L7 | Pilot report states confounds and sample size; makes no efficacy claim | pending |

## Sign-off

Pilot may run when: all A items are verified or have a documented manual substitute; B1–B3 checked on one real session; C1, C2, C6 done; E1–E5 done; D2 done. D1, D3, D4, D5 and L1–L7 may complete during the pilot but must be complete before any result is reported outside the team. G6 stays unknown until an ingest/search receipt exists and must not be claimed in the interim.

| Gate | Signer | Date | Note |
| --- | --- | --- | --- |
| Pilot may run | | | |
| Results may be reported internally | | | |
| Operational deployment | | | Requires all of `sme-review-and-research-plan.md` Part 1 |


## September13 native0.5.0 evidence update

The opening239-test count is historical; current native0.5.0 integration passed361 tests across31files and typecheck. `evidence/platform/native-050-checkpoint.json` verifies the served source hash, all19exercises ended and all paid controllers disabled. `tests/server/debrief-authority.test.ts` and the HTTP route tests cover debrief permission loss before or during inference, receipt retention and independently revoked concurrent callers. The legacy native cache was stale and was preserved, so this checkpoint did not request a new paid debrief.

A3/A4 gain transport-specific launch/movement/landing/recall and interleaved branch coverage in `evidence/naval/qualification.json`. All18 prior native records matched their checkpoint/final fingerprints in `evidence/poc/native-history-compatibility.json`; zero historic boat intents limits that compatibility claim.

C1–C4 remain pending. The two-minute scripted Blue load test passed, while the separate passive run ended after41seconds. Both are automated API activity, not human playtesting, and neither satisfies the120-minute gate. Team dialog visual/focus/clipboard verification remains pending while the Mac is locked.


## September13 native0.6.0 evidence update

Current integration:408tests across37files and typecheck clean. All19native histories matched61,313canonical turns. Native participant review now qualifies independent version histories and own-subject personal exports through real Commander/Intelligence sign-ins; every generated qualification entry is withheld and unscored, with no human assessment claim. Evidence:evidence/poc/native-participant-review.json. The original staff record now passes model-result retention and historical task cutoff checks (evidence/poc/native-staff-retention.json).

The served0.6.0 source hash and stopped-controller state are verified in evidence/platform/native-060-checkpoint.json. Larger maps remain engine qualification options. C1–C4 and human/SME gates remain pending;28simulated characterization runs found short attrition or stalemates. Team/review/staff visual checks remain pending while the Mac is locked. The updated0.6.0handoff identifies its newer source separately from the preserved0.3.0video.
