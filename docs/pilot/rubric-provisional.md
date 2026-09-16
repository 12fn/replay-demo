# Provisional rubric (0.1.0, content revision 2)

**Status:** provisional, unvalidated, for pilot use only. Anchors describe observable behavior in the REPLAY record or in the learner's written statements. This rubric has not been reviewed by a subject-matter expert, has no inter-rater reliability data, and must not be used for grades of record.

## Three separate results

Every review produces three things and keeps them apart.

| Result | Definition | Source in this build | Rubric? |
| --- | --- | --- | --- |
| **Game outcome** | End state under the recorded rules: tiles and forces per side at the finish tick | Engine state at the end; `exercise_ended` or `exercise_completed` event | No. Recorded as fact. Never scores a criterion. |
| **Estimated decision value** | Comparison of an order with legal alternatives using a named evaluator | **Not available.** The Review "Decisions" panel labels commitments over 65 percent of available forces "Review tradeoff"; that is a threshold on a ratio. | No. Leave unscored, write "no evaluator". |
| **Learning evidence** | Observable decision-reasoning behaviors | Command events (with decision note), `decision_log`, `assessment_log`, `report`, `staff_update`, `task_created`, `staff_answer`, `branch_created`, paper logs, probes | Yes, below. |

A learner can lose the game and score well. A learner can win and have no recorded reasoning. Both are normal and both are reported as they are.

## Where the evidence lives

| Evidence | Record | How the app labels it |
| --- | --- | --- |
| Order | `command` event: `details.intent`, `details.observedTick` (tick displayed at submission), `details.before` and `details.after` (own side's forces, tiles, gold), `details.fingerprint` | Timeline; "Decisions" panel; Learning panel "Observed behaviour" with commitment ratio |
| Decision note written at order time | Same `command` event: `details.rationale`, `details.rationaleTiming = "contemporaneous"`, `details.sourceIds` | "reason recorded · contemporaneous"; each cited report tagged `current` or `superseded at order tick` |
| Statement written afterward | `decision_log` event: `details.text`, `details.sourceIds`, `details.timing = "post-hoc"`, `details.commandEventId`, `details.orderTick`, tick written at | "reason recorded · post-hoc" |
| Assessment entry | `assessment_log` event: `details.text`, `details.sourceIds`, `details.timing` (contemporaneous only if written while running at the live tick), `details.observedTick` | Learning panel "Assessment log" |
| Report release | `report` event and the report row: tick, side, `supersedes` | Reports list with "superseded" tag |
| Watch created / update | `task_created` (objective), `staff_update` (`details.sourceIds`, `details.method`, `details.reasons`) | Staff panel Watches; timeline |
| Staff question and answer | `staff_answer` event: `details.question`, `details.sourceIds`, receipt | Timeline |
| Opponent model action | `model_decision` (summary, `details.calls`, receipt) and `tool_result` | Timeline (Red perspective after end or as instructor) |
| Branch | `branch_created` (`forkTick`, fingerprints); branch commands after the fork | Lineage bar; dossier "Counterfactual practice" |

## Scoring rules

- Score per **moment** (a specific tick chosen in the review), then summarize per criterion.
- Each score cites: exercise ID, tick, and the event ID (expand a timeline entry to see it), report ID, task ID, or paper line number.
- **No citation, no score.** Write "not observed" and leave it. Not observed is not zero; it is missing.
- Reasons only come from the learner's written notes, statements, assessment entries or spoken review statements. A click is not a reason. Post-hoc statements are scored on a separate line marked "post hoc" and are not merged with contemporaneous evidence.
- Where a model staff answer influenced a decision, note it. Assistance is context, not a deduction. The app records the attempt as `staff-assisted` after any delivered model staff answer or analysis.
- Branch play is scored only on criterion 7.
- Territory, tiles, forces and who "won" never score any criterion.

## Criteria and anchors

Scale: **0 not observed at this moment · 1 partial · 2 present · 3 present and explicitly sourced**

### 1. Evidence currency

Uses the report that was current at the order tick; treats superseded reports as history.

| Score | Observable anchor |
| --- | --- |
| 0 | Note names no report, or cites a report the app tags `superseded at order tick` with no acknowledgement |
| 1 | Names a report but not why it is the current one; unclear whether currency was checked |
| 2 | Cites the current report at the observed tick |
| 3 | Cites the current report and explicitly notes that an earlier estimate is now stale, or explains why acting on a stale estimate was acceptable |

Evidence: `details.sourceIds` on the command versus the report's `supersedes` chain at `details.observedTick`; the note text.

### 2. Provenance

Statements about the opponent trace to a specific report, tick, or map observation.

| Score | Observable anchor |
| --- | --- |
| 0 | Assessment entry or note states opponent facts with no source (dossier gap `assessment-uncited` or `rationale-uncited`) |
| 1 | Refers to "the report" or "the map" without identifying which or when |
| 2 | Cites a report (ticked in the picker) or names a specific map observation with its tick |
| 3 | Cites the source and distinguishes what the source observed from what the learner inferred |

Evidence: `assessment_log` and command `sourceIds`; `staff_answer` records where the learner asked for sources.

### 3. Uncertainty handling

States what is unknown and adjusts action or monitoring accordingly.

| Score | Observable anchor |
| --- | --- |
| 0 | No unknown named; no watch, question or reserve recorded (dossier gap `no-recorded-uncertainty-action`) |
| 1 | Names an unknown but does nothing about it |
| 2 | Names an unknown and takes a recorded action that addresses it (creates a watch, holds a reserve, asks staff) |
| 3 | Names an unknown, addresses it, and states how they would recognize a change |

Evidence: note text; `task_created`; `staff_answer`.

### 4. Resource commitment reasoning

Chooses a commitment level and explains what is retained and why.

| Score | Observable anchor |
| --- | --- |
| 0 | Order recorded, nothing about the retained reserve |
| 1 | Commitment stated without a reason for the level |
| 2 | Commitment and retained reserve both stated with a reason |
| 3 | As 2, and the reason references the current opponent estimate or a specific risk |

Evidence: `details.intent.troops` over `details.before.troops` (the commitment ratio shown in the Learning panel); the note. A high ratio with a stated reason is not penalized.

### 5. Decision explanation (contemporaneous)

Writes a decision statement at the time of the order.

| Score | Observable anchor |
| --- | --- |
| 0 | No decision note on the command event and no paper line at the order clock time (dossier gap `rationale-unobserved`); a post-hoc statement alone scores here as 0 and is scored on its own "post hoc" line |
| 1 | Note exists but only restates the order |
| 2 | Note states expectation, reliance, and at least one of retained/unknown |
| 3 | Note complete: expectation, cited report, retained reserve, unknown |

Evidence: `details.rationaleTiming = "contemporaneous"` is set by the server only for text submitted with the order; nothing written later can acquire that label.

### 6. Revision on material change

At a report release or watch result, changes the plan or explicitly keeps it with a reason.

| Score | Observable anchor |
| --- | --- |
| 0 | No later order, note, statement, assessment or watch from the learner after the release (dossier gap `release-without-recorded-response`) |
| 1 | Order changed with no stated link to the new report, or note mentions the report with no decision |
| 2 | Note or assessment links the new report to a change or an explicit "keep, because" |
| 3 | As 2, and the assessment log (intelligence) and the commander's note agree on what changed |

Evidence: `report` event tick; subsequent `command`, `decision_log`, `assessment_log`, `task_created`; `staff_update`.

### 7. Counterfactual practice (branch only)

States an assumption, plays a different legal order from the same state, and compares honestly.

| Score | Observable anchor |
| --- | --- |
| 0 | Branch created with no written assumption |
| 1 | Assumption written; branch play not related to it |
| 2 | Assumption written; branch order differs from the original in the stated way; a comparison sentence exists |
| 3 | As 2, and the comparison acknowledges hindsight or a confound ("the baseline behaved differently because it saw a different border") |

Evidence: `branch_created` (fork tick, fingerprints), branch command events after the fork, written assumption and comparison.

## Summary sheet

```
Learner pseudonym | Exercise ID | Seat | Identity mode | Opponent mode | Assistance (from dossier) | Reviewer
Moment (tick) | Criterion | Score | Evidence citation (event/report/task ID or paper line) | Post hoc? | Note
...
Outcome (fact, not scored): Blue tiles/forces, Red tiles/forces at end tick; how it ended
Estimated decision value: no evaluator available
Unscored criteria and why
```

## Source-backed limitations of this rubric and of the app's signals

These follow from the code as built, not from a validated framework.

- **The dossier counts, it does not score.** `src/learning/dossier.ts` produces descriptive counts and gap lists and states "No decision-value evaluator exists." Treat its output as a rater aid.
- **Currency is judged only through explicit supersession.** A cited report is tagged `superseded` only when a later report on the same side names it in `supersedes` and was released at or before the observed tick. Two reports that conflict without a supersession link are both "current" to the app. The rater must read them.
- **Observed tick, not execution tick.** Currency uses `details.observedTick` (the tick displayed at submission). Orders execute one tick later or more; the debrief context lists the post-execution state as hindsight for that reason.
- **Revision detection is order-based, not time-boxed.** The app counts a release as "followed by a recorded response" if *any* later order, statement, assessment or watch by the learner exists in the record, however late. The two-minute window in the anchors is the rater's judgment, not the app's.
- **A post-hoc statement can only be added to an order with no note.** The Learning panel offers the form only for orders the dossier lists as `rationale-unobserved`. An order with a thin contemporaneous note cannot be supplemented in-app; use the review conversation and cite it as spoken.
- **Assessment timing is mechanical.** An entry is contemporaneous only if the exercise is running and the learner is viewing the live tick. Writing while scrubbed to a past tick is post-hoc even during play.
- **Commitment ratio requires both numbers.** It is computed only when `intent.troops` and `before.troops` are recorded; boats and builds have no ratio.
- **The "Review tradeoff" label is a 65 percent threshold** on that ratio over the last twelve human orders. It carries no judgment.
- **Staff assistance marks the whole attempt.** One delivered model answer sets assistance to `staff-assisted` for the exercise; the app does not attribute assistance to individual orders. Note which orders followed an answer.
- **Model opponent records are external.** `model_decision` holds a summary, tool calls and a receipt; the observation payload is stored but no reasoning is requested or stored. The debrief validator rejects opponent claims containing motive language.
- **The intelligence seat is observed through its assessment entries, watches and questions only.** Criteria 1, 4 and 5 apply to it only where it advised the commander in writing.
- **Comparison across attempts is narrow by design.** The dossier compares only the same subject, same scenario ID and same curriculum major version, and only independent (non-branch, earlier) attempts. In local-demo mode every user of a persona shares a subject.
- **Inter-rater agreement is unknown.** Two raters on a subset is required before any result is reported.
- **Candidate competency frameworks in the event catalog have not been reviewed or ingested.** No anchor cites a source (`SRC-000`, status none).
- **Nothing here measures transfer** to a different scenario or to reality.
