# Consent and minimal learning records (pilot, content revision 2)

This document defines what the pilot records, what it does not, which data leaves the REPLAY server, how long records are kept, and what they may be used for. It is a draft for a small internal pilot. It has not been reviewed by an institutional review board, a privacy officer, or counsel. Do that review before running learners who are not project members.

## 1. Minimal record set

| Record | Content | Where | Identifies the learner? |
| --- | --- | --- | --- |
| Session log | Date, build commit, identity mode, exercise IDs, pseudonyms, seats, opponent mode, release ticks, faults, instructor observations | Instructor's file | Pseudonym only |
| Engine record | Ordered turns and state fingerprints | `replay.sqlite` `turns` | No |
| Event log | Orders with observed tick and pre/post state, rejections, reports, watch updates, staff questions and answers, controller changes, branches, end events | `replay.sqlite` `events` | Actor is the platform subject ID (native) or a persona string (local). No name. |
| Decision notes and post-hoc statements | Learner's own text and cited report IDs | `events` (`command.details.rationale`, `decision_log`) | Subject ID as author |
| Assessment log | Intelligence learner's entries | `events` (`assessment_log`) | Subject ID as author |
| Dossier | Descriptive counts and gaps computed from the above | Computed on request; Markdown export | Subject ID and display name in the header |
| Debrief records | Validated model debrief text, reference catalogue, receipt | `replay.sqlite` `settings` | Author subject ID |
| Probe forms | Pre and post responses | Paper or text file | Pseudonym only |
| Rubric sheet | Per-moment scores with citations | Instructor's file | Pseudonym only |
| Inference ledger | Count, cost and provider IDs of paid requests | `inference.sqlite` | Context carries subject ID for staff, debrief and ontology requests |
| Native session store | Encrypted platform tokens and session metadata | `data/native/` | Yes; never exported |

Pseudonym mapping (pseudonym to platform subject ID and display name) is kept by the instructor in a separate file and destroyed at the end of the pilot unless the learner asks to keep their results.

## 2. What is not recorded

- No audio or video, unless separately consented in writing for a specific session.
- No keystrokes, mouse tracking, eye tracking, or biometrics.
- No reasons. The software does not infer intent, confidence, or understanding from actions. An order without a note is "reason not observed".
- No model chain of thought. Model outputs are stored as returned: an action summary and tool calls, a staff answer, or a validated debrief JSON.
- No platform credentials in the browser. Only an opaque session cookie.

## 3. Data that leaves the REPLAY server (external model route)

Each of the following is a metered request to the configured external model route under the project cap. Learners must be told which are enabled. Report contents are fictional game data; the learner's own text is not.

| Trigger | Who can trigger | What is sent |
| --- | --- | --- |
| "Ask staff" question | Any seat with write permission | The typed question, the seat, the current game state, and the last four reports released to that side |
| Model opponent enabled | Commander or instructor with agent permission | The opponent side's observation: shared-map state, its own resources and legal actions, its side's reports, its durable memory of prior pulses. Never the human side's reports or notes. |
| Paid analysis enabled on a watch | Watch owner or instructor with agent permission | The watch objective, material event, side resources, side reports, deterministic delta and the last deterministic result |
| Generate debrief | Order's author after the end, or instructor | The order, the author's own decision note or post-hoc statement text, side reports and watch updates available then, the opponent's action record, later reports (up to two), criteria and source list |
| Ontology publish | Instructor with agent permission | The curated game-domain source only (`src/ontology/domain.ts`). No learner data. |

If sending learner text to the external route is unacceptable for the pilot, run variant PV-4: baseline opponent, deterministic watches only, no staff questions, no debriefs. All learning records still work.

## 4. Consent text (read and sign)

> I am taking part in a pilot of REPLAY, a fictional strategy exercise used to study whether it helps people practice decision reasoning. During the session, the software records my game orders, the tick I was viewing, the reports I received, any decision notes, statements or assessments I write, my questions to the staff assistant and its answers, and the state of the game over time. I will also complete two short written probes. These records are stored on the exercise server under my platform account identifier and reported under a pseudonym. If model features are enabled, my typed staff questions, my written notes and statements, and the game state may be sent to an external model service; the instructor has told me which features are on. Nothing I do here is a graded assessment of me, will not be used for any personnel, evaluation, or selection decision, and does not measure my real-world ability. How much territory I hold is recorded but is not used to judge my reasoning. I may stop at any time, and I may ask for my records to be deleted before the pilot report is written. I understand this pilot has not been validated as training and that its results describe the exercise, not me.
>
> Pseudonym: ______  Signature: ______  Date: ______
>
> Model features enabled for my session (instructor to complete): staff questions ☐  paid watch analysis ☐  model opponent ☐  debrief ☐
>
> Optional: I consent to audio recording of the review conversation for this session only. ______

## 5. Retention and access

- Records kept for the duration of the pilot plus 90 days, then deleted, unless a written research plan extends this.
- Only the instructor and named pilot reviewers may access records. In native mode the server already limits API reads to the owner and the workroom instructor.
- The engine record and event log may be retained longer **without** the pseudonym mapping as engineering test data, if the learner does not object. Decision notes, statements and assessments are learner text and follow the shorter retention.
- Do not upload records to any external service. Do not include them in a hackathon submission except as an aggregate, anonymized summary the learners have seen.
- Never copy `data/native/`.

## 6. Limits on use

- Results may be used to improve the exercise, the rubric, the probes, and the software.
- Results may be reported in aggregate as pilot observations with sample size and limitations stated.
- Results may **not** be used for grades of record, fitness reports, selection, or any claim that a learner did or did not learn.
- Results may **not** be described as validated training outcomes or as endorsed by any institution.

## 7. Learner rights

- See their own records on request (the dossier Markdown export is the learner's own view; the event log via the instructor).
- Correct a note by adding a dated post-hoc statement or a review remark; originals are never edited.
- Withdraw and have their pseudonymous records deleted before the pilot report.
- Ask what any score was based on and receive the citation.
