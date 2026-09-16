# REPLAY expert first session — facilitator protocol (20–30 minutes)

> Current release: start with [REPLAY 0.26 expert session](start-here-026.md). It supersedes older build/map/video descriptions below; retain the forms and teaching protocol as reference.

Drafted 2026-09-14 for the hackathon. **Status: protocol only. It has not been run.** Nothing here reports an observation, a human validation, measured fun or measured learning. It complements, and does not replace, the novice usability protocol in `formative-session-protocol.md`, the SME gate in `sme-review-and-research-plan.md`, or the planned paired AI playtest in `../playtests/whole-experience-red-team.md`.

**Purpose.** A domain or teaching expert plays a few minutes of the current build, reviews one of their own decisions, retries it once, and then helps define what observable evidence of **one skill** they care about should look like in this product. The output is a short, prioritized list of findings the team can act on during the hackathon. It is product critique, not assessment of the expert.

**Build.** The current native release is 0.26.5 on Kamiwaza 1.2. Use `start-here-026.md` and `../stages/status.json` for the latest release and prepared discussion links. The current six-minute recording shows 0.26.0 Taiwan play and 0.26.1 graph footage. Later archived-source and review-link features have separate browser evidence. Existing integrated automated examples and nine offline model games support a facilitated pilot; no human session or curriculum acceptance is recorded.

## What to say before anyone touches the app

Use a short, candid introduction; adapt the wording to the expert:

- REPLAY is a **fictional, abstract** Blue-versus-Red territory game on the pinned OpenFront engine. It uses a Taiwan Strait map with fictional relay objectives, forces and rules. Realistic military behavior and instructional validity have not been validated; ask experts which abstractions are useful and which would mislead learners.
- The opponent is **scripted software** (or, only if deliberately enabled, a bounded model controller). It is uncalibrated, it is not optimal, and nobody steers it to teach a lesson.
- The clock shows **simulated ticks** (nominally ten per second) and a minute:second readout derived from them. It is not a claim about real-world decision tempo, and a scenario "limit" is a cap, not a promised duration.
- Territory or points at the end are recorded facts. They are never a measure of reasoning quality.

## 1. Qualified routes versus the unrehearsed integrated workflow

The integrated automated learning example, substantive practice branch, native role checks and nine offline model games have completed. Their scope and receipts are in `../stages/core-acceptance-plan.md`. They do not substitute for this first human session.

| Step in this session | Prior evidence | Human question still open |
| --- | --- | --- |
| Native sign-in and role-aware seat | Separate Commander and Intelligence sessions and owned Tomo helpers qualified | Can a first-time expert enter with their own account? |
| Taiwan exercise, continuous orders and reports | Regional automated browser play and native changing-evidence example | Are choices understandable and engaging without repeated coaching? |
| Delegate provenance monitoring | Native Tomo-created watch and subsequent alerts retained | Can a small human team use the help effectively? |
| Review a recorded decision and its source timing | Native API and browser decision-perspective checks | Can the expert separate contemporary evidence from hindsight? |
| Open an archived model decision and exact saved source | Native source hash checks for both roles; Commander browser link, cutoff and history checks | Does this make the model's stated reason inspectable and teachable? |
| Branch and compare with the original | Automated substantive alternative, canonical action and original preservation verified | Is the retry useful for the chosen skill? |
| Instructor correction and personal dossier | Actual cached debrief, instructor revision and separate learner history qualified | What evidence would the expert accept, reject or need added? |


## 2. Setup (facilitator, 15 minutes before; not part of the 20–30)

1. **Access.** Use only the access route and accounts provided by the workroom operator for the deployed build. Do not create shared or default credentials, and do not reuse anyone's account. The current installation is reached through a private operator tunnel (`../operator-runbook.md`); a public ingress is not qualified. If the expert cannot reach the build from their own device, run on the facilitator's machine with the expert signed in under their own provisioned account, and note this in the session record.
2. **Seats.** Expert: **Commander (Blue)**, which requires a writable workroom role (editor/operator; see `instructor-guide.md` §2.2). Facilitator or a second person: **Instructor** on a separate browser profile, for report releases. Confirm in the header: "Kamiwaza identity", workroom, seat and access badge.
3. **Paid features off.** Leave the opponent on its scripted controller; do not enable Luna, paid watch analysis, staff questions or a generated debrief. Write down the request counter shown in the Platform view or Learning panel before and after. The project has a small remaining request allowance (`../stages/status.json`: `paid_inference`); this isolates the basic play/review usability route. A separate brief AI demonstration may use the existing bounded allowance with the actual request delta recorded; paid features are not prohibited.
4. **Dry run the exact path once** on a throwaway exercise: create "Taiwan Strait · relay contest", give one order with a Decision note, release a report as instructor, End for review, open Review, select that order, confirm Decision perspective loads, Branch at that tick, return to the source. If a step fails, record it as blocked or skipped. Mark "demonstrated by facilitator" only if a facilitator actually completes it.
5. **Scenario.** Use **Taiwan Strait · relay contest**. If the dry run ends quickly, retain that finding and use its review and branch. Do not substitute a different scenario without recording the change; sustained pacing remains unvalidated.
6. Print the feedback form (section 8) and the one-line skill menu (section 4).

## 3. Timeline

| Clock | Segment | Facilitator does |
| --- | --- | --- |
| 0:00–0:03 | Briefing and consent to record | Give the short briefing below. Confirm the expert agrees that their orders, notes and comments are recorded under their account. No audio or screen capture unless separately agreed. |
| 0:03–0:05 | Expert chooses one skill | Show the skill menu (section 4). The expert picks one, or names their own in one sentence. Write it at the top of the form. |
| 0:05–0:15 | Play (minimally prompted) | Hand over the task card (section 5). Silent except the scripted release line and neutral prompts (section 7). Instructor releases one report at about 0:09 and one at about 0:12. |
| 0:15–0:21 | Review one decision | Review card, part B. |
| 0:21–0:25 | One retry | Review card, part C. |
| 0:25–0:30 | Define evidence and priorities | Interview (section 6). The expert writes or dictates the evidence definition. |

For a 20-minute session, shorten play to 0:05–0:11 (one report release at about 0:08), review to 4 minutes, retry to 3 minutes and the interview to 2 minutes.

**Briefing (suggested wording).**

> This is a fictional, abstract strategy game: Blue versus Red on a map. It uses fictional forces and relay objectives on a Taiwan Strait map. Help us identify abstractions that support learning and ones that would mislead. The opponent is scripted software, not an ideal adversary. The clock counts game ticks, not real-world time. You'll play for about ten minutes, look back at one of your own decisions, try it once differently, and then help us decide what evidence of one skill should look like here. We're not assessing you. What helps us most is where the product fails to show or support that skill, and specific moments where it did or didn't. I won't help with the app while you play; say what you're trying to do, and skip anything you're stuck on.

## 4. Skill menu (expert picks one)

These are the build's existing, provisional practice targets (`exercise-curriculum.json`, `rubric-provisional.md`). The expert may reword one or name a different skill; record their words exactly.

- **Evidence currency:** acting on the report current at the moment of the order, treating older reports as history.
- **Provenance:** tying a claim about the opponent to a specific report or map observation.
- **Uncertainty handling:** saying what is unknown and doing something recorded about it.
- **Resource commitment:** choosing how much to commit and what to hold, with a reason.
- **Revision on material change:** at a new report, changing the plan or explicitly keeping it with a reason.
- **Counterfactual practice:** stating an assumption, retrying from a recorded moment, comparing honestly.

## 5. Task card (give to the expert)

Outcomes, not button names.

**Part A — play**

1. Start a new exercise using "Taiwan Strait · relay contest".
2. Find out what ends the exercise.
3. Give at least one order. Before sending your first order, write one line about what you expect and what you're holding back.
4. Set something up so you'll be told when something important to you changes.
5. When you hear "A report has been released", find it and do whatever you think makes sense. If you keep your plan, say so in writing.
6. End the exercise for review when asked.

**Part B — review one decision**

7. Go back to the order you most want to discuss and show the map at the moment you gave it.
8. Find what you wrote for it and which reports existed then.
9. Open that order's recorded perspective: what was available, the choice, and what had happened by that point.
10. In one sentence: what did the screen let you see about the skill you chose, and what was missing?

**Part C — one retry**

11. On paper, write one assumption you're changing (for example, "I assume the report at tick N was still current").
12. Retry from that moment and give one different order.
13. Return to the original and confirm it is unchanged.
14. In one sentence: what does the retry show about the skill, and what does it not show?

**Facilitator notes for part B/C (do not read aloud; use only if the expert is stuck for 60 seconds, and mark the row H).** End for review is in the Objectives panel. Review's order list is titled "Recent orders"; its title link moves the map to that tick, and, in0.16.2, selects it so "Decision perspective" loads. Timeline entries and evidence chips also select it. Retry is **Continue from here → Branch at tick N**; the app has no assumption field, so the written assumption lives on the form. "Review tradeoff" marks commitments above65percent.0.16.2labels recorded facts/fixed review prompts and offers a comparison to explore; these are not evaluations and lower commitment is not inherently better. A retry informed by the later record is informed practice, not evidence of improvement.

## 6. Interview (0:25–0:30, read verbatim, write answers)

Ask for moments and observables, not opinions of the product.

1. "For the skill you chose: what would someone who is good at it **do or write** in this game that someone who isn't would not? Give one example from what you just played."
2. "Which of those things did the app record? Show me where. Which did it miss?"
3. "At the moment you reviewed, what did you know then, and what did you only learn afterwards? Did the screen keep those apart?"
4. "If you were teaching this skill, what is the one question you'd ask a learner at that moment? Could they answer it from what's on screen?"
5. "What in this session would **mislead** a learner about the skill? Point to the screen or the moment."
6. "What would a learner practice next, and what would you need to see to believe they did?"

Also ask: "Where did play become engaging or tedious? Which choices mattered? Which abstraction would teach the wrong lesson? What one change would make this useful in your course?" Record concrete moments alongside general impressions. Domain and realism feedback are central inputs to the hackathon backlog; prioritize reviewed source or scenario changes where feasible.

## 7. Neutral prompts (only these during tasks)

- "What are you trying to do right now?"
- "Where would you expect that to be?"
- "You can skip this and come back."
- To "should I…?" or "is this a good move?": "I can't advise on that; do what you'd do."
- To "what does this mean?": "What do you think it means?" (record the word and the answer)

**Stop and record** (clock, tick, message): a fault or durability message, a native access denial, a fingerprint mismatch on rewind, any change in the unexpected paid request counter change, any credential or private configuration on screen, or the expert asking to stop.

## 8. Feedback form (compact, blank)

```
SESSION   date ____  build/image ____  source hash (Platform view) ____  exercise ID ____
          branch ID ____  expert pseudonym ____  domain ____  seat ____  scenario ____
          access: own device / facilitator machine    paid requests before ___ after ___
          ended at clock ___ tick ___ by: End for review / elimination / fault / stopped

SKILL (expert's words) ______________________________________________

TASKS  (D done unaided  H after neutral prompt  P partial  X not done  S skipped)
 1 __  2 __  3 __  4 __  5 __  6 __ | 7 __  8 __  9 __  10 __ | 11 __  12 __  13 __  14 __
 Where they looked first / wrong control tried (task #: ...) _________________________

MOMENT REVIEWED   order tick ___  observed tick ___  note written? Y/N  reports then ___
 Screen showed about the skill: _____________________________________
 Missing / misleading: ______________________________________________
RETRY   fork tick ___  written assumption: ______________  different order: ___________
 What the retry shows / does not show: ______________________________

OBSERVABLE EVIDENCE FOR THE SKILL (expert-defined)
 Would be seen as (action or written words): _______________________
 Recorded by app now? Y / N / partly   where: ______________________
 Not evidence (looks like it but isn't): ___________________________
 Question a teacher would ask at that moment: _______________________

FINDINGS  (one per line)
 # | moment (tick/screen) | observed (verbatim if possible) | type* | severity** | expert's suggested change
 1 |                      |                                 |       |            |
 2 |                      |                                 |       |            |
 3 |                      |                                 |       |            |
 *type: B blocked  M misleading  E evidence gap  F friction  D domain content request
 **severity: 1 stopped the skill from showing  2 distorted it  3 slowed it  4 polish

DO NOT RECORD: game outcome as quality, the expert's performance as a score, credentials.
```

## 9. Turning findings into priorities (same day)

1. **Merge** findings across sessions by the screen or moment they point to, keeping each expert's words and the exercise ID/tick that locates them.
2. **Classify** with the form's type and severity. Prefer a moment when available; retain broader course needs and domain gaps as design hypotheses to investigate.
3. **Rank** in this order: (a) B/M at severity 1–2 on the route in section 1, especially anything that makes information-available-then indistinguishable from hindsight, presents heuristic text as judgment, or implies realism or opponent quality; (b) E gaps where the expert-defined evidence exists in the record but the screen cannot surface it; (c) F friction on the play → review → retry path; (d) polish.
4. **Route** each ranked item to one of: copy/label fix, facilitator-guide fix, small UI fix (main owns app code and qualification), later design question, or **domain content request**. Realism, doctrine and agency-specific content requests go through `dataset-source-review-template.md` and SME review. Experts can help prioritize and review feasible changes during the hackathon.
5. **Carry the skill definition forward.** Record each expert's "would be seen as / not evidence / teacher's question" lines against the matching `OBJ-*` in `exercise-curriculum.json` as a **proposed, unreviewed** observable, for the team to compare with `rubric-provisional.md`. Record the reviewing expert and version when adopting a rubric change; do not retroactively rescore prior sessions.
6. **Report honestly.** Summaries say "n experts, facilitated, the actual deployed version, scenario and controller, with paid-request delta" and describe what was observed. They do not claim learning, fun, realism, opponent quality or validation, and they do not substitute for the paired AI trial or the SME gate.
