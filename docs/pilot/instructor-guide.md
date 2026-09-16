# REPLAY instructor guide (provisional, content revision 2)

This guide runs a fictional Blue-versus-Red abstract strategy exercise for decision-reasoning practice. It describes the build as implemented; where a step depends on something not yet verified with humans, it says so. No session plan here has been run with learners.

## 1. What learners practice

| Practice target | What it looks like in this game |
| --- | --- |
| Evidence currency | Using the latest report for a decision while retaining the older report as history, not as a current fact |
| Provenance | Citing which report, tick, or map observation supports a statement |
| Uncertainty | Saying what is unknown (for example, the opponent's intent) rather than filling the gap |
| Resource commitment | Choosing how much to commit and how much to hold, and saying why |
| Explaining decisions | Writing a one-line decision note before the consequence is known |
| Revising decisions | Changing or explicitly keeping a plan when a material report change arrives |
| Counterfactual practice | Branching from a recorded tick and comparing a different legal order under a named assumption |

Out of scope: real-world tactics, targeting, unit realism, any specific organization's doctrine. Do not import those into the debrief. Territory outcome is recorded, never scored.

## 2. Setup (about 30 minutes before the first session)

### 2.1 Local mode (internal dry runs only)

```
pnpm install
pnpm run typecheck
pnpm run dev:api          # API on 127.0.0.1:5181
pnpm run dev              # UI on 127.0.0.1:5180
```

`GET /health` returns `authMode: "local-demo"` and `nativeConnected: null`. Health never claims platform connectivity; only a resolved native session does. Identity is a persona selector in the header. Exercises are attributed to the persona subject string, so two people using the same persona on different browsers share an attribution. Do not use local mode for a pilot with real learners.

### 2.2 Native mode (pilot)

The API refuses to start with a partial native configuration. Required environment: `REPLAY_AUTH_MODE=kamiwaza`, `REPLAY_KAMIWAZA_API` (absolute URL ending in `/api`), `REPLAY_WORKROOM_ID`, `REPLAY_FORWARDED_HOST`; optional `REPLAY_FORWARDED_PROTO`, `REPLAY_COOKIE_SECURE`, `REPLAY_ALLOWED_ORIGINS`, `REPLAY_ALLOW_LEGACY_RECORDINGS`, `REPLAY_ONTOLOGY_ID`, `REPLAY_GRAPHITI_SUBJECT`. The deployed extension's actual values are recorded in `evidence/platform/replay-upgrade.json` (no secrets).

What learners see: a Kamiwaza sign-in card. Credentials go once to the REPLAY server, which validates them with the platform; the browser holds only an opaque HttpOnly cookie. Sign-in is rate-limited to ten attempts per minute per client.

Seat assignment comes from the workroom role on every request:

| Workroom role | Seat |
| --- | --- |
| owner | instructor |
| editor, operator | commander |
| viewer, anything else | intelligence |

An operator may tailor the presented seat, display name and organization per subject by setting the workroom attribute `replay_profiles[<subject>] = {role, name, organization}`. A profile changes presentation only: a "commander" profile never grants write or agent permission. Writes (orders, watches, staff, branches, finish, releases, statements) need a fresh platform `can_edit`; enabling the model opponent or paid watch analysis needs `can_run_agents`. A read-only or blocked seat fails closed with a typed denial. The persona selector is rejected in native mode.

Exercise visibility: an exercise is visible only inside its workroom, to its owner or to an instructor. Legacy local recordings without a workroom are visible to instructors only when `REPLAY_ALLOW_LEGACY_RECORDINGS=true` and are labeled "unattributed local recording".

Before learners arrive: sign in as each seat once, confirm the header shows "Kamiwaza identity", the workroom name, the mapped seat and an access badge, and confirm the instructor seat can press "Release report".

### 2.3 Paid model calls

Paid calls require a server credential and an explicit human action: enabling the model opponent, enabling paid analysis on a watch, asking the staff a question, or generating a debrief. The project cap is USD 5 and 100 requests; the Learning panel and Platform view show usage. For a first pilot, **leave the opponent on the deterministic baseline** and decide in advance whether staff questions are allowed (see `consent-and-learning-records.md` section 3). Record the choice in the session log.

### 2.4 Seats

- **Commander (Blue):** issues orders with an optional decision note; can create watches and ask staff; can enable or stop the model opponent; can end the exercise.
- **Intelligence (Blue):** cannot issue orders (the app says so). Reads reports, creates watches, asks staff, and writes the in-app assessment log.
- **Instructor:** sees both sides, releases reports, can end the exercise, can act on either side (avoid this during play), can generate debriefs during play.

Current development version 0.4.1 supports paired commander/intelligence subjects in one exercise. This was qualified through separate real native sign-ins and app API sessions; it is not a human paired playtest. The preserved 0.3.0 video/ZIP predates this feature.

The commander creates an exercise. A native instructor with sharing permission selects that exercise and uses **Team → Create join code**. The intelligence participant signs into the same Kamiwaza workroom and uses **Team → Join**. Codes last 24 hours, may be rotated, and do not confer a native role. The Team interface is built, but its visual/focus/clipboard pass is pending because the qualification Mac was locked.

Both participants need a writable native workroom membership. An operator sets the intelligence scenario profile for the intelligence participant; a native viewer remains read-only. Profiles tailor the seat and organization but cannot grant native edit or agent permissions. In the local 1.2 installation, ordinary editors lack native sharing permission, so the instructor issues the code even for a commander-owned game. A learner cannot switch seats in native mode.

Dossiers count each participant's own orders, assessments and prior eligible exercises. Joining does not reveal a teammate's private prior games. Branches start private, and a report released before enrollment is not counted as a missed release. Instructor judgments may target the whole exercise or a recorded participant; personal findings require evidence that participant authored and never constitute automatic mastery scores. Removing a participant preserves their evidence but revokes active access and existing join codes. A native role change can terminate the current workroom runtime session; sign in again to resolve the current role.

### 2.5 Materials

- Learner quick start (`learner-quick-start.md`).
- Paper decision log sheet (section 4.2) as backup for the in-app decision note, and for learners who prefer to write.
- Pre-probe Form A or Form B (`pre-post-probes.md`), counterbalanced across learners.
- Consent text (`consent-and-learning-records.md`).
- Rubric summary sheet (`rubric-provisional.md`).

### 2.6 Report schedule

The build auto-releases three synthetic reports per side at about ticks 1, 300 and 600 (the first minute). After that, **only the instructor releases reports** with "Release report" in the Staff panel. Each release gives both sides a fresh engine observation of the opposing player's tiles and uncommitted forces, marked as superseding that side's prior report. Every release is a recorded `report` event with a tick. Reports are true at their tick and stale afterward; that is the designed currency problem.

Deterministic watches evaluate every 100 ticks and at each release, and post an update only when something material happened (a new report, a supersession, or the opposing public totals moving at least 10 percent in tiles or 25 percent in forces since the watch's baseline).

### 2.7 Dry run (required before any learner session)

As commander: issue an expand order with a decision note citing the initial report; confirm the Learning panel shows "reason recorded · contemporaneous". Create a watch. As instructor in a second session: release a report; confirm the watch posts a supersession update naming both reports. Open Review, scrub to the release tick, confirm the map reconstructs (fingerprint shown) and the released report appears. Create a branch as Blue and issue one order; return to the source and confirm its tick and record are unchanged. End the exercise and confirm the Learning panel offers "Generate debrief" (do not press it unless a paid debrief is part of the plan). If anything fails, do not run learners until it is fixed.

## 3. Session plans

Ticks run at ten per second; a 60-minute session is about 36,000 ticks. Victory pacing has not been tuned or playtested: **if a side is eliminated after tick 50 the engine ends the exercise automatically** (`exercise_completed`). In the one recorded automated run with the model opponent, an unattended Blue was eliminated in about five minutes. With the baseline opponent and an active human, pacing is unknown. Keep the plan clock-driven: end with "End for review" at the planned time. If elimination ends it early, treat the record as complete, run the review on it, and note the tick.

No coaching interruptions during play. The instructor speaks only to release reports, answer control questions, or handle a fault. Learners can ask the staff panel what they like; answers are recorded.

### 3.1 60-minute plan

| Time | Activity | Instructor actions |
| --- | --- | --- |
| 0:00–0:08 | Consent, quick start, pre-probe form | Collect forms before play starts |
| 0:08–0:12 | Sign-in, seats confirmed, exercise created, first orders | Confirm each learner sees the Live label, tick clock and assigned side; record exercise ID |
| 0:12–0:40 | Continuous play | Release reports at about 0:18, 0:26, 0:34. Note idle stretches over three minutes. |
| 0:40–0:42 | End for review | Commander or instructor presses "End for review" (confirm step) |
| 0:42–0:55 | After-action review (section 5) | Review view plus Learning panel |
| 0:55–1:00 | Post-probe form | Alternate form from the pre-probe |

Branch practice is omitted at 60 minutes unless time remains; if included, it is informed practice.

### 3.2 90-minute plan

| Time | Activity | Instructor actions |
| --- | --- | --- |
| 0:00–0:10 | Consent, quick start, pre-probe | |
| 0:10–0:15 | Sign-in, seats, exercise created | |
| 0:15–0:55 | Continuous play | Release at about 0:22, 0:32, 0:42, 0:50. For one release, choose a moment when Blue has a large commitment in progress (Orders panel "Active orders") so the currency question is live. |
| 0:55–0:57 | End for review | |
| 0:57–1:15 | After-action review | Optionally one paid debrief of a chosen order (section 5.5) |
| 1:15–1:25 | Branch practice: one branch per pair from a reviewed tick, opposite side if the learner chooses | Record branch ID, fork tick, side and the written assumption |
| 1:25–1:30 | Post-probe | |

### 3.3 120-minute plan

| Time | Activity | Instructor actions |
| --- | --- | --- |
| 0:00–0:10 | Consent, quick start, pre-probe | |
| 0:10–0:15 | Sign-in, seats, exercise created | |
| 0:15–1:15 | Continuous play | Release at about 0:25, 0:37, 0:48, 0:58, 1:08. Optionally enable the model opponent at 0:45 (`controller_changed` event records the tick); tell learners only afterward. Expect a harder opponent and possible early elimination. |
| 1:15–1:17 | End for review | |
| 1:17–1:40 | After-action review | |
| 1:40–1:55 | Branch practice with a written comparison (section 5.4) | |
| 1:55–2:00 | Post-probe | |

No two-hour wall-clock run with humans has been done. Keep a backup exercise ready. On a durability fault the app stops accepting orders for that exercise and records `service_fault` rather than silently dropping records.

## 4. Facilitation rules and logs

### 4.1 Rules for the instructor

1. Do not tell learners what to do with a report. Release it and go quiet.
2. Do not alter resources or the opponent to manufacture a lesson. The build cannot do this, and you should not try.
3. Answer "how do I" questions about controls. Do not answer "should I" questions.
4. Model answers are recorded and are part of the evidence. Do not editorialize on them during play.
5. Note the tick and clock time of anything unusual: idle stretches over three minutes, confusion about controls, a rejected order the learner did not notice, a fault.
6. Do not generate a debrief for a learner's order during play unless the plan says so; it is paid and it is hindsight.

### 4.2 Decision notes (commander)

The app offers an optional "Decision note" under the commit slider. Text written there is stored with the next order as **contemporaneous**, together with the observed tick, the pre-order state and any reports the learner ticked. A cited report must already have been released to that side; otherwise the order is refused and the learner sees the reason. Tell learners: one line per order, written before pressing the order button. The clock never pauses for it, and it is never required.

Backup paper sheet, used only when a learner prefers it; transcribe nothing into the app afterward (that would be post-hoc):

```
Clock | Tick (header) | Order (what) | Report(s) relied on | What I am holding back and why | What I don't know
```

After play, the Learning panel lists each order that has no note and offers "Add a post-hoc statement". Those are stored as `decision_log` events labeled post-hoc with the tick at which they were written. They are scored on a separate line and never become contemporaneous.

### 4.3 Assessment log (intelligence)

The Learning panel shows an "Assessment log" form for the intelligence seat with a report picker limited to reports available at the displayed tick. Entries made while the exercise runs at the live tick are labeled contemporaneous; anything written in a historical view or after the end is labeled post-hoc. The learner should log at every release or watch update and tell the commander in their own words. Record whether they did.

### 4.4 Session log (instructor)

Record: date, build commit, identity mode, exercise ID, learner pseudonyms and seats, opponent mode and any `controller_changed` tick, report release ticks, whether staff questions or paid analysis were allowed, faults, and observations. Exercise ID and ticks are how every assessment later traces back to evidence.

## 5. After-action review

Open the Review view. It shows the record lineage, a perspective toggle (display only), the tick scrubber, the map reconstructed and fingerprint-checked at the displayed tick, the "Decisions" panel, the timeline, the reports released to the viewed side, and the Learning panel. If reconstruction fails you see an error, not an approximate state. Opposing-side reports, staff records and branches are released once the exercise has ended, or to the instructor.

### 5.1 Order of the review

1. **Outcome first, then set it aside.** State the end state (tiles and forces per side) and, if the engine ended it, read the `exercise_completed` event. Say explicitly that outcome is separate from decision quality and from learning evidence.
2. **Pick three to five moments.** Candidates: each report release, any order the "Decisions" panel labels "Review tradeoff" (over 65 percent of available forces), any `command_rejected`, any watch update, any order flagged "reason not observed".
3. **Reconstruct what was available.** Scrub to the order's observed tick. Read the reports that existed then. Read the decision note. Ask the learner to narrate from the note, not from memory.
4. **Ask the currency question.** "Which report was current at that tick? Did the order rely on it or on an older one?" The Learning panel tags each cited report `current` or `superseded at order tick`.
5. **Ask the uncertainty question.** "What did you not know, and what did you do about it?" Evidence: watches created, staff questions, the note's own words.
6. **Ask the revision question at each release.** "The estimate changed at tick N. What did you change, or why did you keep the plan?" A written "keep, because" counts. Silence does not, and the dossier lists such releases as `release-without-recorded-response`.
7. **Show the opponent record.** Toggle to Red. Show its reports and, if the model controller was on, its `model_decision` summaries and `tool_result` receipts. Say plainly: "This summary is what the model reported alongside its actions. It is not the model's reasoning."

### 5.2 What the instructor must not do

- Do not say a decision "caused" the outcome. The record shows sequence, not causation. You may say "this commitment consumed forces that were not available at tick N".
- Do not fill in a learner's reasons. If there is no note and no statement, the finding is "rationale not observed".
- Do not treat "Review tradeoff" as a judgment. It is a threshold on commitment ratio.
- Do not compare the learner to any doctrine. None is loaded.
- Do not read the dossier's counts as scores. They are descriptive.

### 5.3 Rubric scoring

Score with `rubric-provisional.md` during or immediately after the review, one row per moment, citing the exercise ID, tick, and the event ID (visible when a timeline entry is expanded) or paper line. Anything without a citation is left unscored.

### 5.4 Branch practice

The learner chooses a reviewed tick and a side, states one assumption in writing ("I assume the tick-N estimate was still current"), presses "Branch at tick N" in Review, and plays five to ten minutes. The branch inherits the reports and events up to the fork as history, is attributed to the learner, and starts with assistance `unknown`. Compare the branch state to the original at the same tick offset. Record: branch ID, fork tick, side, stated assumption, and the learner's one-line comparison. This is informed practice and is scored only on criterion 7, never as improvement.

### 5.5 Generated debrief (optional, paid)

After the exercise ends, the Learning panel can generate one model debrief for one of the learner's own orders. The server assembles only the evidence that existed (available-then) plus explicitly labeled hindsight (later reports, the opponent's action record, the post-execution state), sends one request, and validates the output. A debrief that cites unknown evidence, labels hindsight as available-then, attributes motives to the opponent controller, claims doctrine or mastery, or uses real-world framing is discarded and logged; the learner sees "Debrief discarded", not the text. Validated debriefs are cached per evidence hash and marked stale if the record changes. Use it as a prompt for the conversation, not as a grade. Read its "Limitations" section aloud.

## 6. Faults and recovery

| Symptom | Do |
| --- | --- |
| Header shows a fault or orders are refused with a durability message | Stop the session for that exercise. Create a new exercise if time allows. Record the tick. Do not tell learners it was their fault. |
| Staff answer errors with a budget or credential message | Continue. Watches still work. Note that model staff answers were unavailable from that time. |
| Model opponent errors | The baseline resumes automatically when the controller is disabled (`controller_changed`) or after a budget/credential error, which disables it. Record the tick. |
| Server restart | Orders and watches persist; the model opponent and paid watch analysis are switched off and must be re-enabled deliberately (`task_model_changed` events). Record it. |
| Rewind fails with a fingerprint mismatch | Do not review that tick. Record the message. Other ticks remain valid. |
| Native access refused mid-session | The app fails closed and shows the platform's reason. Ask the workroom operator. Assessment for that learner from that point is compromised; say so in the log. |
| Exercise ended by elimination | Review the record as it stands. Note the `exercise_completed` tick. Consider a new exercise for remaining time. |

## 7. Before you run this operationally

This guide is for a small pilot. Before any graded use, course integration, or claims about effectiveness, complete the review gate in `sme-review-and-research-plan.md`, the forms in `acceptance-and-pilot-forms.md`, and the checklist and gates in `handoff-acceptance-checklist.md`.


## September13 qualification addendum — native0.5.0

The session durations above remain facilitation plans. Current measured coverage is a two-minute automated native run with two API readers and scripted Blue orders:480reads,11historical seeks and99.49percent nominal tick progress. Passive Blue was eliminated in a separate41-second run. Record and review an early ending; do not treat the present scenario as a qualified hour-long exercise. See `evidence/soak/native-two-reader-load-baseline.json` and `native-two-reader-load-passive.json`.

Transport options now include current eligibility, sampled landing destinations, cost and recall. Sampling is not exhaustive. Eligibility is checked at admission and execution; changing resources or territorial state can still prevent an order, and a valid launch can fail to reach its destination. Fixture tests cover movement, landing, recall and isolated replay. Trade-ship scheduling and broader naval play quality remain under development.

Native debrief generation revalidates the caller's current agent permission before inference, cache insertion and delivery. If access changes, the generated answer is withheld and its usage receipt remains recorded. Older cached debriefs can be marked stale after evidence or prompt changes. Do not regenerate just to remove the label; review whether another paid analysis is useful.


## Participant review and staff history in0.6.0

In Review, select the whole exercise or a named participant before recording a judgment. The selected target is printed with the finding. Version numbers belong to that target and criterion, so correcting the commander does not replace the intelligence participant's assessment. When a participant is selected, evidence marked own identifies a new act recorded under that subject; it does not establish that the evidence demonstrates the criterion. Cite the learner's actual assessment or order and explain your interpretation. A staff question can be theirs; its model-generated answer is assistance, not their writing. Inherited branch history is context rather than a new act.

Confirmed/contested personal findings need at least one such act. Use withheld and unscored when nothing was observed. A released report by itself does not show that the participant read it. Learners can read their own personal findings and exercise-wide findings; instructor exports include all authorized targets. A removed participant remains reviewable from retained history without regaining exercise access.

When a free watch update follows model analysis, expand Previous model analysis in the watch card. It retains the original result and citations; it has not been updated for later reports. Rewind hides results that had not yet arrived. Older model updates may lack an initial observation tick; the completion tick is known.


## Stations and order outcomes (0.8.0)

Choose **Stations and reserves** for the experimental objectives mode. Inspect the marked regions and full rules before play. Scores are game points; the 20-minute cap does not ensure a 20-minute exercise. Review the smaller-versus-larger commitment example as a rule tradeoff, then ask the participant to explain and test an alternative. No automatic blunder label is assigned.

**Order outcomes** distinguishes an admitted input from a construction or transport effect actually observed later. Expand a receipt and inspect its event. Rewind hides later receipts. An inherited receipt describes an action from the source exercise, not a new choice in that branch. Other order types remain unobserved. See `../process/objectives-and-execution-notes.md` for limits and the qualification evidence. The preserved video predates these panels; their browser visual check remains pending.
