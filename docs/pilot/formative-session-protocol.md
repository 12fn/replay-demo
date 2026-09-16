# REPLAY 20-minute formative usability session (protocol, not a result)

Drafted 2026-09-13. Status: **draft protocol for a first human session that has not been run.** Nothing here reports an observation. This session satisfies handoff checklist item **C1** ("20-minute formative playtest without presenter coaching") only once it has actually been conducted and its record filed. It is not the 60-minute session (C2), not the pilot research study in `sme-review-and-research-plan.md`, and not an NPS-approved or institution-approved activity. No one has approved this protocol.

Purpose: find out whether a person who has never seen REPLAY can, without coaching, enter their seat, act, record a reason, notice a report change, and find a moment in Review; and where the interface or its wording confuses them. The secondary purpose is to see whether the decision-reasoning record the app produces is legible to the person who made it. Game outcome is recorded as a fact and is never a measure.

## 1. Participants and roles

| Role | Who | Notes |
| --- | --- | --- |
| Participant | One novice (no prior REPLAY exposure) **or** one subject-matter person (assessment or wargaming background) | Run separately; do not pair them in this 20-minute format. Two participants per protocol variant is enough for a first pass. |
| Facilitator | One person who did not write the app copy being tested, if possible | Runs the clock, reads prompts verbatim, records. Does not coach. |
| Instructor seat operator | Facilitator or a second person signed in as instructor | Releases reports on the schedule below. Speaks only the scripted release line. |

Seat for the participant: **Commander (Blue)** on the native deployment with a real workroom sign-in. The intelligence seat is not tested in this session; note that as scope.

## 2. Consent, privacy and withheld scoring

Read and have the participant sign the consent text in `consent-and-learning-records.md` section 4 before anything is shown. For this session the model-feature checklist on that form is:

- staff questions ☐ **off**
- paid watch analysis ☐ **off**
- model opponent ☐ **off** (deterministic scripted opponent)
- debrief ☐ **off**

That is variant PV-4 in that document: no participant text leaves the REPLAY server. Confirm in the Platform view before the participant sits down that Paid requests has not moved during setup.

What is recorded: the app's normal event record under the participant's platform subject ID, the facilitator's paper sheet (section 7), and optional audio of the participant thinking aloud **only** if the optional audio line on the consent form is signed. No screen video unless separately consented; if the in-app **Record walkthrough** control is used, tell the participant it captures the app view only and show them the "actual app-view capture" footer.

Scoring is **withheld**. The facilitator records task completion and observations. No rubric score is written for this session. If an instructor judgment is later entered in the app for this exercise, its disposition is **Withheld / unobserved** with the rationale "formative usability session; not assessed". The participant is told this in the briefing and again at the end. The exercise ID and pseudonym mapping are kept as the consent document specifies.

## 3. Setup (facilitator, before the participant arrives)

1. Native deployment reachable; header shows **Kamiwaza identity** for the participant's account with seat Commander and badge WRITE (agents badge may be absent; paid features are off anyway).
2. Run the dry run in `instructor-guide.md` section 2.7 on a throwaway exercise. If any step fails, do not run the session.
3. Create nothing in advance for the participant. They create the exercise themselves (task 1).
4. Instructor seat signed in on a separate device or browser profile, on the same workroom, ready to select the participant's exercise once it exists.
5. Facilitator sheet (section 7) printed; clock visible to the facilitator only.
6. Confirm the budget counter and write it on the sheet. Re-read it at the end; it must be unchanged.

## 4. Session timeline (20 minutes)

| Clock | Segment | Facilitator does |
| --- | --- | --- |
| 0:00–2:00 | Briefing (section 5) | Reads the briefing verbatim. Answers only "how do I" questions about the room, not the app. |
| 2:00–14:00 | Uninterrupted exercise with embedded tasks | Hands the participant the task card (section 6). Starts the clock. Does not speak except for the scripted report releases and to answer a direct control question with the neutral response in section 8. |
| 14:00–14:30 | End | Says: "Please end the exercise for review when you're ready." If the participant cannot find the control within 30 seconds, notes it and says: "It's in the Objectives panel." |
| 14:30–18:30 | Review tasks (task card part B) | Same rule: silent except neutral responses. |
| 18:30–20:00 | Short interview (section 9) | Reads the five questions verbatim; writes answers. |

There is **no mandatory interruption** during the exercise. The instructor's report releases are the only planned events: one at about clock 5:00 and one at about clock 9:00 (after the app's own automatic releases in the first minute). Each release is announced with exactly: "A report has been released." Nothing else.

If the exercise ends early by elimination, the facilitator notes the clock and tick and moves directly to the review tasks. Early elimination is a finding, not a failure of the participant.

## 5. Briefing (read verbatim)

> You'll play a short, fictional strategy exercise: Blue versus Red on a map. Nothing represents a real place or force. The point is not to win. I'm interested in whether the screen makes sense to you and whether you can find things. I won't help with the app while you play; if you get stuck, say what you're trying to do and keep going, or move to the next task. Please think out loud if you're comfortable. The app records your orders and anything you type. Nothing here scores you, and no one will judge your play. There's a card with tasks. Do them in order if you can; skip any you can't. You have about twelve minutes of play, then a few minutes looking back at what happened.

## 6. Task card (given to the participant)

Neutral wording. The card names outcomes, not controls, so that the test measures whether the interface reveals its controls.

**Part A — during play**

1. Start a new exercise using the option called "Crosscurrent · stations and reserves".
2. Find out what has to happen for the exercise to end.
3. Give one order of your choice. Before you send it, write one line saying why.
4. Find out which of your reports is the most recent.
5. Set something up so you're told when the estimate of the opposing force changes.
6. When you hear "a report has been released", find it, and do whatever you think makes sense. If you keep your plan, write down that you kept it.
7. Find out whether a build or boat order you gave actually finished.
8. End the exercise when you're ready or when asked.

**Part B — after play**

9. Go back to the first order you gave and see what the map looked like at that moment.
10. Find the line you wrote for that order.
11. Find out which report you were relying on and whether a newer one had replaced it by then.
12. Find your own summary of what you did and wrote during this exercise.

## 7. What the facilitator records (paper sheet)

One row per task, filled during the session, plus free observations. Time is the facilitator's clock; tick is read from the app header when visible.

```
Session: date | build source hash (Platform view) | exercise ID | participant pseudonym | novice / SME
Budget before: ___ / 100     Budget after: ___ / 100
Report releases (instructor): clock ___ tick ___ ; clock ___ tick ___
Exercise end: clock ___ tick ___ ; how (End for review / elimination / fault)

Task | Start clock | Outcome (D=done unaided, H=done after neutral hint, P=partial, X=not done, S=skipped) | Time to complete (s) | Where they looked first | Control they used | Quote / confusion
1 ...
12 ...

Observations (no interpretation):
- Wrong-control attempts (what they clicked expecting what):
- Wording the participant read aloud and misread:
- Rejected orders they did not notice (tick):
- Idle stretches over 2 minutes (clock range):
- Think-aloud statements about *why* they gave an order (verbatim, with clock):
- Anything the participant said was "the app's reasoning" or "the AI's thinking":
- Faults, errors shown, denials (tick, message text):
```

**Definition of task success.** "Done unaided" means the participant reached the stated outcome with no facilitator words other than the scripted release line. A neutral response from section 8 downgrades the row to H. Success is per task, binary, and reported as counts per task across participants; no aggregate "usability score" is computed from this session.

**Evidence of learning is kept separate from game success.** The sheet has no column for territory, points or who was ahead. The end state is written once as a fact (line "Exercise end"). The only reasoning-related evidence the facilitator captures is (a) whether a decision note existed for task 3 and task 6 (read later from the app's Learning panel: "reason recorded · contemporaneous" or "reason not observed"), and (b) verbatim think-aloud lines. Neither is scored. They exist so that a later, separate analysis can ask whether the app captured what the participant said they were thinking, which is a legibility question, not a learning outcome.

## 8. Neutral prompts (the only things the facilitator may say during tasks)

When the participant asks for help or is silent and visibly stuck for 60 seconds:

- "What are you trying to do right now?"
- "Where would you expect that to be?"
- "Keep going with whatever you'd do next."
- "You can skip this one and come back."

When asked "should I do X" or "is this a good move": "I can't advise on that. Do what you'd normally do."

When asked "what does this mean" about an on-screen word: "What do you think it means?" Record the word and their answer. Do not define it.

Never: point at a control, name a button, read a tooltip aloud, or comment on the game state.

## 9. Closing interview (read verbatim, record answers)

1. "In your own words, what is this exercise for?"
2. "Was there anything on screen you didn't understand? Which words?"
3. "When you gave an order, did you know what would happen next? What told you?"
4. "When you looked back at your first order, did the screen show what you remembered? What was different?"
5. "Is there anything you'd want the app to have recorded that it didn't, or recorded that you'd rather it hadn't?"

Do not ask "did you learn anything" or "would you recommend this". Those are not measurable here and invite politeness.

## 10. Stop criteria (end the session early and record why)

Stop immediately and record the clock, tick and message when any of the following happens. Do not tell the participant it was their fault.

- The app shows a fault or durability message and refuses orders (`service_fault`).
- A native access denial appears mid-session.
- A rewind shows a fingerprint mismatch in Part B (record it; other ticks may be used if time allows).
- The budget counter changes at any point (a paid feature was not actually off).
- The participant asks to stop, or shows distress.
- Part A task 1 is not done unaided or with a hint within 4 minutes (the participant cannot start; the session becomes an interview about the New dialog).
- Any credential, token or private configuration becomes visible on screen.

Stop criteria for the **protocol** (do not run further sessions until fixed): two participants in a row fail the same task at X; the dry run fails; or the instructor seat cannot release a report.

## 11. What this session can and cannot support

It can support statements like "two of two novices found the decision note unaided" or "both participants read 'Accepted' as 'succeeded'". It cannot support any statement about learning, transfer, engagement over time, pacing of a long session, opponent quality, or the intelligence seat. It does not satisfy C2, C3, C4, D1–D5, L1–L7 or any SME gate.

File the completed sheet, the exercise ID and the budget readings in the instructor's session folder. Do not attach the sheet to the hackathon package except as a summarized, anonymized finding the participants have seen.

## 12. Later 60-minute validation session (outline only; not done)

To be designed in full only after at least two formative sessions above have been run and their wording fixes shipped. This outline exists so that the shape of the next gate is visible; it is not a claim that anything below has happened.

| Segment | Duration | Purpose | Measures (all descriptive) |
| --- | --- | --- | --- |
| Consent, quick start, pre-probe (Form A or B) | 10 min | Baseline on paper, off-app | Probe item scores per `pre-post-probes.md`, two raters |
| Continuous play, commander + intelligence pair, scripted opponent | 30 min | Pacing and attention with humans (C2, C4) | Orders per 10 minutes; idle stretches > 3 min; notes per order; assessment entries per release; releases with a recorded response; elimination tick if any; admission latency as felt (any order the participant reports as "didn't take") |
| End for review + after-action review per `instructor-guide.md` section 5 | 12 min | Whether the record supports a conversation about decisions | Moments reviewed; rewinds attempted and mismatches; whether the learner narrates from the note or from memory (facilitator observation) |
| Branch practice (optional, informed practice only) | 5 min | Whether the branch flow is usable | Assumption written yes/no; branch created; order given |
| Post-probe (alternate form) | 3 min | Descriptive change on paper, confounded | Per-item, by form order, with n |

Gates the 60-minute session would inform, if run: C2, C4, partial C5, L1 (note rate). It would still not establish learning, and its report must state practice effects, form non-equivalence, instructor conversation, novelty and small n as confounds. The scripted opponent's fitness for an hour of human play is itself unknown: automated characterization ended matches in 2.7 to 6.6 simulated minutes on candidate scenarios, and the stations scenario has a 20-minute cap. Plan the 60-minute session as two or three shorter exercises unless a sustained scenario has been qualified first.
