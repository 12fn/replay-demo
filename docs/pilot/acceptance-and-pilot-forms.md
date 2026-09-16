# Forms: SME acceptance and small-pilot run

Two forms. Form 1 is completed by reviewers before any operational use. Form 2 is completed once per pilot session by the instructor. Both are plain text so they can be kept with the session log. Nothing on either form may be pre-filled as "accepted" or "passed".

---

## Form 1. Subject-matter-expert acceptance

**Package reviewed:** REPLAY pilot package, curriculum `replay-crosscurrent-decision-reasoning` version 0.1.0, content revision ____. **Build commit:** ____________. **Date:** ________.

### 1.1 Reviewer

| Field | Entry |
| --- | --- |
| Name and role | |
| Review type (assessment / domain / privacy / technical) | |
| Relationship to the authors (must not be an author) | |
| Files read in full (list) | |
| Ran the dry run in instructor guide section 2.7? (yes / no / observed) | |

### 1.2 Framing statements (initial each)

- ____ The exercise is an abstract Blue-versus-Red territory game. I found no content that models a real force, adversary, place, doctrine, tactic or targeting process. Exceptions listed in 1.6.
- ____ Territory outcome is recorded as fact and is never used to score reasoning in any document, form or app view I examined.
- ____ Model outputs are described everywhere as external action summaries or validated debriefs, never as the model's reasoning.
- ____ Human validation is pending; nothing in the package claims training effectiveness or institutional endorsement.

### 1.3 Rubric criteria (assessment SME)

| Criterion | Keep / revise / drop | Revised anchor text or reason |
| --- | --- | --- |
| C1 Evidence currency | | |
| C2 Provenance | | |
| C3 Uncertainty handling | | |
| C4 Resource commitment reasoning | | |
| C5 Decision explanation (contemporaneous) | | |
| C6 Revision on material change | | |
| C7 Counterfactual practice | | |

Scale (0–3) acceptable as written? ______ Comments: ______________________

### 1.4 Objectives, misconceptions, probes

| Item | Accept / revise / reject | Note |
| --- | --- | --- |
| OBJ-1 … OBJ-8 statements | | |
| Misconceptions M1–M10 | | |
| Probe Form A | | |
| Probe Form B | | |
| Forms A and B equivalent? (yes / no / cannot judge) | | |
| Session plans 60 / 90 / 120 | | |

### 1.5 App signals (technical or assessment reviewer)

| Signal | Fair as a rater aid? | Note |
| --- | --- | --- |
| Dossier counts and gap kinds | | |
| "Review tradeoff" 65 percent threshold label | | |
| Contemporaneous versus post-hoc labeling | | |
| Debrief validator rejections (unknown citation, hindsight, motive, doctrine, real-world) | | |

### 1.6 Content that must be removed or changed before operational use

| Location (file, section, or app view) | Problem | Required change |
| --- | --- | --- |
| | | |

### 1.7 Decision

- ☐ Accepted for a small internal pilot with the changes in 1.6 made first
- ☐ Accepted for a small internal pilot as is
- ☐ Not accepted. Reason: ______________________________________

This acceptance does not make the exercise validated and does not permit efficacy claims. Signature: ____________ Date: ________

---

## Form 2. Small-pilot session record

One per session. Attach the rubric summary sheets and probe scoring sheets.

### 2.1 Session

| Field | Entry |
| --- | --- |
| Date, start and end clock time | |
| Build commit and identity mode (local-demo / kamiwaza) | |
| Workroom ID (native) | |
| Exercise ID(s), including branches | |
| Plan used (60 / 90 / 120) and deviations | |
| Opponent mode; `controller_changed` tick if switched | |
| Model features enabled (staff questions / paid watch analysis / model opponent / debrief) | |
| Report release ticks (instructor) | |
| How the exercise ended (End for review tick / elimination tick / fault tick) | |
| Faults, restarts, denials (tick and message) | |

### 2.2 Learners

| Pseudonym | Seat | Pre form (A/B) | Post form (A/B) | Notes per order (n/N) | Assessment entries (n) | Watches (n) | Staff questions (n) | Assistance label in dossier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

### 2.3 Review moments scored

| Tick | Why chosen (release / tradeoff flag / rejection / watch / no note) | Criteria scored | Evidence IDs cited | Post-hoc lines |
| --- | --- | --- | --- | --- |
| | | | | |

### 2.4 Branch practice

| Branch ID | Fork tick | Side | Written assumption | Comparison sentence | C7 score |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

### 2.5 Observations (no interpretation)

- Idle stretches over three minutes (tick ranges): ______________________
- Control confusion observed: ______________________
- Rejected orders the learner did not notice: ______________________
- Did the intelligence learner brief the commander after releases? ______________________
- Did the deterministic opponent create real commitment decisions? ______________________
- Debrief generated? Validated / discarded (receipt ID): ______________________

### 2.6 Exports completed

| Artifact | Done | File name |
| --- | --- | --- |
| Dossier Markdown per learner | ☐ | |
| Debrief Markdown (if any) | ☐ | |
| Engine record JSON per exercise and branch | ☐ | |
| Event log extract (SQLite) | ☐ | |
| Inference ledger summary | ☐ | |

### 2.7 Consent and records

- Consent signed by every learner ☐ Pseudonym mapping stored separately ☐ Native session store excluded from exports ☐

Instructor signature: ____________ Second reviewer (if present): ____________

No conclusion about learning is drawn on this form. Analysis follows `sme-review-and-research-plan.md` Part 2.
