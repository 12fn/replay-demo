# SME review gate and pilot research plan (content revision 2)

## Part 1. Human subject-matter-expert review is required before operational deployment

"Operational deployment" means any of: use in a course for credit or grade of record; use where results feed any personnel process; use with learners outside the pilot team; any public or institutional claim that the exercise teaches something.

None of that is permitted until the following review is complete and recorded on `acceptance-and-pilot-forms.md` form 1. As of this refresh no SME review has occurred, no human has played a session, and no institution has endorsed the package. The concept under review is decision-making practice in an abstract territorial game; it is not operational training.

### Reviewers

| Role | Reviews | Must be |
| --- | --- | --- |
| Learning or assessment SME | Rubric anchors, probes, objectives, misconceptions list, AAR protocol | Someone with assessment design experience; not the author |
| Domain SME | Whether the abstract game and its vocabulary could mislead learners about any real practice; whether any content strays into real tactics or doctrine | Someone with relevant professional background; not the author |
| Privacy / compliance reviewer | Consent text, record set, retention, external model data flow | Institutional |
| Technical reviewer | Handoff checklist evidence, replay integrity, record completeness | Someone who did not build it |

### What each review must produce

- A dated, signed note per reviewer stating what was reviewed (file and version), what was changed, what is rejected, and what is conditionally accepted.
- For the rubric: each criterion marked keep / revise / drop, with revised anchor text where applicable.
- For the probes: an equivalence judgment for Forms A and B, and item-level edits.
- For the domain check: an explicit statement that the exercise content does not model real-world lethal targeting or tactics, or a list of what must be removed.
- For sources: a completed `dataset-source-review-template.md` per source, before any source is cited.

### What review does not do

- It does not make the exercise "validated". Validation is an empirical result, not a sign-off.
- It does not permit efficacy claims. Those require the study in Part 2, at minimum.
- It does not convert a heuristic finding in the app into a decision-quality judgment. That requires a defined evaluator, which does not exist.

## Part 2. Learning is the research question

The pilot does not assume the exercise teaches. It asks whether there is any observable change, and what limits the answer.

### Primary question

Among learners who complete one REPLAY session with the after-action review, is there an observable change between pre and post probe scores on the decision-reasoning criteria (currency, provenance, uncertainty, commitment, revision)?

### Secondary questions

1. Do learners write contemporaneous decision notes in the app at all, and at what rate per order? (Dossier counts `contemporaneousRationale` over `humanCommands`.)
2. At report releases, how often is a revision or explicit keep-decision recorded within two minutes? (The app counts any later response; the two-minute window is applied by the rater from event ticks.)
3. Do watch updates change subsequent behavior (any order, note or assessment referencing the update within two minutes)?
4. Where a model staff answer was used, is it distinguished from a report in the learner's notes? (Attempts are labeled `staff-assisted` by the app.)
5. Does the deterministic opponent create enough pressure to make commitment decisions non-trivial without eliminating an active human early? (Instructor observation, count of orders per ten minutes, and the end event.)
6. Can two raters agree on rubric scores? (Agreement statistic on a scored subset.)
7. Are generated debriefs useful as review prompts, and how often are they discarded by the validator? (Count `debrief_generated` versus `debrief_rejected` events.)

Territory outcome is recorded for every session and reported as a fact. It is not a variable in any question above.

### Design for a first pilot

- Sample: as many learners as available, likely 4 to 12. Report the number. Do not power-test; this is descriptive.
- Pre/post probes counterbalanced by form order.
- One session per learner, 90-minute plan preferred.
- Opponent mode fixed for the whole pilot unless studying it deliberately; record it.
- Two raters on all probes and on at least one third of rubric sheets.
- Instructor keeps the session log; faults and deviations are reported, not dropped.

### What will be reported

- Per-item pre and post scores, by form order, with n.
- Rates for secondary questions 1 to 4 with the counts they came from.
- Rater agreement.
- Every fault, deviation, and unscored moment.
- A plain statement of confounds: practice effects, form non-equivalence, instructor conversation in the AAR, novelty of the interface, small n.

### What will not be claimed

- That the exercise causes learning.
- That scores generalize to other scenarios, to real decisions, or to a learner's ability.
- That the AI opponent or assistant improved or harmed learning. The pilot cannot separate that.
- That any competency framework was measured. None is loaded.

### What would justify a second study

Only if the first pilot shows the instruments are usable (raters agree, learners produce logs, records are complete) is a comparative study worth designing: for example assisted versus unassisted, or two matched scenarios with a fresh scenario as the post measure instead of a written probe. That study needs the SME review above, a real identity and record system, and a research protocol review. It is not part of this package.
