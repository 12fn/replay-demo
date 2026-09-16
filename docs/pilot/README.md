# REPLAY pilot package — index and status

> Current release: start with [REPLAY 0.26 expert session](start-here-026.md). It supersedes older build/map/video descriptions below; retain the forms and teaching protocol as reference.

**Refreshed:** September 15, 2026. **Package revision:** 0.1.0 content revision 2 (the curriculum `version` string is a code contract and stays 0.1.0; see `exercise-curriculum.json`). **Status:** draft for instructor use in a small, transparent pilot. Nothing here is validated pedagogy, an approved curriculum, or an endorsement by NPS, MCU, or any agency.

REPLAY is a fictional, abstract Blue-versus-Red continuous strategy exercise built on the pinned OpenFront engine. The learning target is **decision reasoning**: evidence currency and provenance, handling uncertainty, resource commitment, explaining and revising decisions, and counterfactual practice. It is not a model of any real force, adversary, doctrine, or lethal targeting process, and it is not validated operational training. Territory outcome is recorded as fact and is never equated with reasoning quality.

## Start with the current expert session

Use [the native0.22expert protocol](../demo/expert-pilot-session-022.md) and [the feedback form](expert-feedback-022.md) for the first facilitated30-minute session. The current [5:10walkthrough](../../evidence/video/replay-integrated-0220.mp4) and immutable0.22pilot archive demonstrate the automated workflow. The longer instructor session plans below remain untested. Later dated sections preserve earlier checkpoints; they are not current readiness claims.

## What is in this package

| File | Purpose |
| --- | --- |
| `learner-quick-start.md` | One-page learner orientation: sign-in, seat, controls, what gets recorded |
| `instructor-guide.md` | Setup for local and native modes, 60/90/120-minute facilitation, after-action review, faults |
| `rubric-provisional.md` | Observable-anchor rubric with source-backed limitations; outcome, decision value, and learning evidence kept separate |
| `pre-post-probes.md` | Equivalent Form A / Form B written probes, distinct from post-review branch practice |
| `assessment-data-export.md` | Exact procedure to export the dossier, debriefs, engine record, task traces and the full event log |
| `consent-and-learning-records.md` | Minimal record set, external model data flows, consent text, retention, limits on use |
| `dataset-source-review-template.md` | Template for reviewing any dataset or source before ingestion or citation |
| `acceptance-and-pilot-forms.md` | SME acceptance form and small-pilot run form |
| `handoff-acceptance-checklist.md` | Acceptance items with cited receipts, plus performance and educational gates |
| `sme-review-and-research-plan.md` | Required human SME review gate and the pilot research question |
| `demo-educational-story.md` | Five- to ten-minute educational walkthrough aligned to `../replay-demo-runbook.md`, with implemented/pending labels |
| `exercise-curriculum.json` | Machine-readable curriculum: objectives, rubric, misconceptions, practice variants, capture and status |

## Implemented versus pending

Derived from `src/server/service.ts`, `src/server/native-http.ts`, `src/server/native-session.ts`, `src/server/learning-routes.ts`, `src/server/agent-routes.ts`, `src/learning/*`, `src/agents/*`, the client views, `docs/stages/status.json` and the receipts under `evidence/`. The September15reviewed increment has1,566passing tests across107files and a clean typecheck. Native deployment is0.22.1with verified timing labels and corrected objective-opponent wording. The preserved5:10video records0.21.1/0.22.0; consult the current pilot receipt for its package version. Older0.3video and archives remain preserved. Instructors should re-check this table against the running build before a session.

| Capability | Status | Notes |
| --- | --- | --- |
| Continuous simulation, 10 ticks per second, shared visible map | Implemented | No fog of war. Both sides see the whole map. Reports and staff records are side-scoped. |
| Human orders: expand, attack adjacent opponent, boat, build (City, Defense Post, Port, Warship), cancel attack | Implemented | Same validator as the AI. Illegal orders are rejected with a reason and recorded as `command_rejected`. |
| Optional decision note with report citations at order time | Implemented | Collapsible "Decision note (optional)" in the Orders panel. Not mandatory; the clock does not pause. Citations must be side reports already released at the observed tick or the order is refused with 422. Stored on the command event as contemporaneous. |
| Post-hoc decision statement for an order without a note | Implemented | Learning panel offers "Add a post-hoc statement" for the learner's own orders. Always labeled post-hoc; never merged with contemporaneous evidence. |
| Intelligence assessment log with citations | Implemented | Intelligence or instructor seat. Contemporaneous only while the exercise runs and the live tick is displayed; otherwise labeled post-hoc. |
| Identity: local demo personas | Implemented | Persona selector. Not authenticated. Suitable only for internal dry runs. |
| Identity: native Kamiwaza workroom sign-in | Implemented; qualified once live | Seat mapped from workroom role; optional operator profile tailors seat/name/organization only. Writes require fresh `can_edit`; enabling paid agents requires `can_run_agents`. Receipt: `evidence/platform/native-session-qualification.json`. |
| Shared native commander/intelligence exercise | Implemented; separate native sessions qualified | Team dialog supports same-workroom enrollment. Native instructor with sharing rights issues a 24-hour code; editor participants retain their actual role. Separate dossiers count their own actions. Private past games and new branches remain excluded. Team dialog visual checks await an unlocked Mac. |
| Synthetic side-scoped reports with supersession chain | Implemented | Auto-released at about ticks 1, 300, 600 (three per side), then only by instructor "Release report". Content is an engine observation of the opposing player's tiles and uncommitted forces. |
| Durable staff watch | Implemented | Deterministic provenance watch, default and free; evaluated every 100 ticks and at each release; emits only on a material event and names its source reports. Survives restart. Prior accepted model analysis remains available with its original tick and citations after a free update. |
| Paid staff analysis per watch | Implemented, opt-in, paid | Bounded pulse (≤2 requests, ≤4 read-only tool steps); citations validated; paused on restart. Marks the attempt staff-assisted. |
| Staff question answering | Implemented, paid | Native agent authority rechecked before inference and delivery. One request per question; may cite only the last four side reports shown; invalid citation discards the answer. |
| Autonomous opponent | Two modes | Deterministic baseline is default (18 percent of forces every 4.5 seconds). Model-driven controller is a bounded tool loop enabled by commander or instructor, at most one pulse per 15 seconds, recorded as external action summary plus tool calls and receipts. |
| Rewind to any recorded tick with fingerprint verification | Implemented; qualified by automation | 72,000-tick accelerated record, six seek points matched, final seek 565 ms (`evidence/soak/long-replay.json`). Not a human session. |
| Branch from a tick, take either side, original preserved | Implemented; browser-verified by automation | Branch attributed to the identity that opens it; inherits reports and events up to the fork as history; assistance starts `unknown`. Opposing-side branch only after the exercise ends or for the instructor. Receipt: `evidence/poc/browser-red-branch.json`. |
| Personal dossier (same subject, same scenario, same curriculum major) | Implemented | Descriptive counts, gaps, questions, targeted practice, next-session plan; branches listed as informed practice; other subjects and unattributed sessions excluded. Markdown download. No score. |
| Generated debrief of one order | Implemented, paid, validated | After the exercise ends (instructor any time). Source and time validated: unknown citations, hindsight labeled as available-then, opponent motive attribution, doctrine or mastery claims, and real-world framing are rejected and never shown. Cached per evidence hash; fresh native agent permission is checked before inference, caching and delivery. |
| Finish exercise, mark as recorded | Implemented | Commander or instructor. The engine also ends the exercise automatically if a side is eliminated after tick 50. |
| Findings panel ("Decisions" in Review) | Heuristic only | Last twelve human orders; flags commitments above 65 percent as "Review tradeoff". A threshold, not a judgment. |
| Learning record export | Implemented; native export qualified | Review → Download evidence bundle / Readable review. Includes authorized full events, replay inputs, reports, task traces, receipts, debrief versions and instructor judgment history. See `assessment-data-export.md`. |
| Pre/post probes in-app | Not implemented | Paper or plain-text forms in this package. |
| Instructor corrections and released findings | Implemented; automated tests pass | Append-only judgments with separate exercise-wide and participant targets, independent versions, authored-event checks and learner-private personal findings. No actual SME judgment has been supplied. |
| Native Graphiti ontology and CPU embeddings | Deployed; ingest/search qualified | Native knowledge publish succeeded; 7 nodes / 13 edges and scoped search results were read back. Agents used actual scoped facts under fresh native permission checks. See `evidence/platform/native-domain-qualification.json` and `evidence/poc/native-agent-context.json`. |
| 60/90/120-minute human playtest, two-hour wall-clock run, victory pacing | Not done | Session plans are untested. The passive two-reader load ended after41seconds; scripted Blue sustained120seconds. These automated results do not qualify a long human exercise. |
| SME review, NPS endorsement | Not done | Required before any operational or graded use. |

## Non-negotiables carried through every document

- Every assessment claim traces to a recorded event, report, task result, or a learner's own written statement. Absence of evidence is not evidence of a failure.
- Nobody, human or model, infers a learner's hidden reasons from a click. Only what the learner wrote or said is rationale, and the app labels when it was written.
- An AI "explanation" in this system is an **external action summary** produced alongside tool calls. It is not chain of thought and must not be presented or graded as the model's actual reasoning.
- Branch practice after review is **informed practice**. It is evidence of engagement and reasoning, not of independent improvement.
- Territory outcome is separate from reasoning quality and from learning evidence. No outcome ever scores a criterion.
- Human subject-matter-expert review is required before any operational or graded deployment.
- Whether this exercise produces learning is the **pilot research question**, not a premise.


## September13 native0.5.0 checkpoint

The current deployment adds transport admission checks and sampled legal naval options. Pinned fixture qualification covers launch, movement, landing, recall and isolated replay/branches (`evidence/naval/qualification.json`). Admission checks describe the current state; an accepted order does not guarantee eventual arrival or that resources stay unchanged before execution. All18 prior native histories matched61228 canonical turns, but none contained boat orders (`evidence/poc/native-history-compatibility.json`).

The source archive is versioned with simulation profile naval-isolation/1; legacy records retain their original profile absence. The7:51 demonstration and pilot ZIP are preserved0.3.0 artifacts, not a recording of these later changes. Native checkpoint evidence is `evidence/platform/native-050-checkpoint.json`. Human playtesting and SME review remain outstanding.


## September13 development checkpoint —0.6.0

Instructor review now selects the whole exercise or a recorded participant. Personal confirmed/contested findings need a new act recorded under that subject; a report or another person's order alone is insufficient. For staff-answer records, the learner authored the question, while the answer is model assistance. Inherited branch events may provide context but cannot alone satisfy the new-act requirement. Withheld findings can remain unscored and uncited. Learners see their own personal findings plus exercise-wide findings; instructors can review all recorded participants, including removed participants' retained history.

Staff views retain prior accepted model analysis independently from later free watch calculations. Replay views and the task endpoint show only results available at the selected tick. The new model adapter selects an explicit final_answer rather than combining it with commentary. Missing/ambiguous answers fail with usage receipts retained. The older malformed-output cause remains unproven.

Larger world resolutions are engine qualification options only; the application still starts the existing scenario. Characterization found quick attrition or sea-barrier stalemates, not a useful hour-long contest. No new long-session human qualification is claimed. Native release and packaging results are recorded in the build journal and deployment evidence.


## September 13 objectives and execution increment — 0.8.0

Four selectable situations now include stations and reserves, with explicit timed game points and earlier elimination. New records persist measured construction/transport effects independently from input admission; historical and branch views preserve timing and source attribution. The 456-test suite and all21 pre-release native histories passed. Consult the build journal for subsequent native deployment/load evidence. This remains a short-match objective prototype; hour-long human play and SME validation are open.

For hackathon expert feedback, use [the20–30minute first-session protocol](expert-first-session.md) and [independent first-use source review](expert-first-use-source-review.md). The protocol remains unrun; current deployment and qualifications are in `../stages/status.json`.
