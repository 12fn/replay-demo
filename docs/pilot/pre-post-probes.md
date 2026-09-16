# Pre/post probes (Form A and Form B), content revision 2

**Purpose.** Written probes given before and after the session to look for change in decision-reasoning behavior on tasks that are **not** the exercise and **not** a branch of it. Branches after review are informed practice and are never used as a post measure. The probes are not implemented in the app; they are paper or plain text. The dossier's "Questions for you" list is a different thing: questions about specific orders with no recorded reason, generated from the record, not a pre/post instrument.

**Not an outcome measure.** No probe item asks who won or how much territory was held. Territory outcome is never a probe answer or a scoring input.

**Equivalence.** Forms A and B are written to the same structure, item count, information density, and scoring anchors. Their equivalence is **assumed, not established**. Counterbalance: half the learners get A before and B after, the other half the reverse. Report results by form order.

**Administration.** Ten minutes, plain text or paper, no access to the app. Learners write in the boxes provided. No feedback is given between pre and post.

**Scoring.** Use the same anchors as `rubric-provisional.md` where indicated. Two raters on a subset; report agreement.

**Fictional content.** Reports and forces are invented for the probe. No real place or organization.

---

## Form A

You command Blue in a fictional territory game. Ten ticks are one second. Read all reports, then answer.

**Reports available to you**

- R1, tick 1200: "Opposing player controls 410 tiles and holds about 9,800 uncommitted forces." Source: engine observation at tick 1200.
- R2, tick 2400: "Opposing player controls 470 tiles and holds about 6,100 uncommitted forces. This replaces R1; retain R1 as history." Source: engine observation at tick 2400.
- R3, tick 2500: staff note: "R2 was observed during an opponent expansion. Its force figure may already be lower." Source: staff inference, not an observation.

It is now tick 2700. You hold 8,000 forces and share a border with the opponent.

**A1. Currency.** Which report is your current basis for the opponent's forces? Name it and state why the others are not. (Rubric criterion 1.)

**A2. Provenance.** Write one sentence about the opponent's forces that separates what was observed from what was inferred, naming the source for each part. (Criterion 2.)

**A3. Uncertainty.** Name the most important thing you do not know at tick 2700 and one concrete thing you would do about it in the game (order, watch, question). (Criterion 3.)

**A4. Commitment.** Decide how many of your 8,000 forces to commit to an attack across the shared border, if any. State the number, what you hold back, and why. (Criterion 4.)

**A5. Revision.** At tick 3000 a new report R4 arrives: "Opposing player holds about 11,000 uncommitted forces. Replaces R2." Do you change your tick-2700 decision? Write one line: change or keep, and because of what. (Criterion 6.)

**A6. Explanation discipline.** A colleague says, "You obviously attacked because you thought Red was weak." You never wrote that down. Is the colleague's statement evidence of your reasoning? Answer yes or no, and give one sentence why. (Scored 0/1: correct answer is no, with a reason referencing that unrecorded reasons cannot be inferred.)

**A7. AI summary.** During the game the opponent's software produced this summary alongside its tool calls: "Consolidated border, committed 2,000 forces to unclaimed land." Which of the following is it? (a) The software's reasoning. (b) A report of actions it selected. (c) An observation of the map. Circle one and explain in a sentence. (Scored 0/1: b. In the app such text is the `summary` of a `model_decision` event, stored next to its tool calls.)

---

## Form B

You command Blue in a fictional territory game. Ten ticks are one second. Read all reports, then answer.

**Reports available to you**

- R1, tick 900: "Opposing player controls 380 tiles and holds about 7,200 uncommitted forces." Source: engine observation at tick 900.
- R2, tick 2100: "Opposing player controls 360 tiles and holds about 10,400 uncommitted forces. This replaces R1; retain R1 as history." Source: engine observation at tick 2100.
- R3, tick 2200: staff note: "R2 was observed after an opponent retreat. Its force figure may already be higher." Source: staff inference, not an observation.

It is now tick 2400. You hold 9,000 forces and share a border with the opponent.

**B1. Currency.** Which report is your current basis for the opponent's forces? Name it and state why the others are not. (Criterion 1.)

**B2. Provenance.** Write one sentence about the opponent's forces that separates what was observed from what was inferred, naming the source for each part. (Criterion 2.)

**B3. Uncertainty.** Name the most important thing you do not know at tick 2400 and one concrete thing you would do about it in the game. (Criterion 3.)

**B4. Commitment.** Decide how many of your 9,000 forces to commit to an attack across the shared border, if any. State the number, what you hold back, and why. (Criterion 4.)

**B5. Revision.** At tick 2700 a new report R4 arrives: "Opposing player holds about 5,500 uncommitted forces. Replaces R2." Do you change your tick-2400 decision? Write one line: change or keep, and because of what. (Criterion 6.)

**B6. Explanation discipline.** A colleague says, "You obviously held back because you were being cautious." You never wrote that down. Is the colleague's statement evidence of your reasoning? Yes or no, one sentence why. (Scored 0/1: no.)

**B7. AI summary.** During the game the opponent's software produced this summary alongside its orders: "Held reserve, requested updated report." Which is it? (a) The software's reasoning. (b) A report of actions it selected. (c) An observation of the map. Circle one and explain. (Scored 0/1: b.)

---

## Scoring sheet

```
Learner | Form order (A→B or B→A) | Pre form | Post form | Rater
Item | Criterion | Pre score | Post score | Note
1 | currency (0–3)
2 | provenance (0–3)
3 | uncertainty (0–3)
4 | commitment (0–3)
5 | revision (0–3)
6 | explanation discipline (0/1)
7 | AI summary (0/1)
```

## Interpretation limits

- A change from pre to post in a small pilot is an observation about those learners on those forms. It is not evidence the exercise causes learning. Practice effects, form differences, and the review conversation are all confounds.
- Items 6 and 7 are near-knowledge items; a post gain on them may only show that the learner heard the instructor say it.
- Report scores per item, per form order, with sample size. Do not report a single aggregate "learning gain".
