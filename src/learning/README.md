# `src/learning` · evidence-led learning projection

Pure functions that turn records the server already holds into a personal
dossier, a source-grounded debrief context, a validator for the model's debrief
JSON, and Markdown artifacts. No I/O, no inference calls, no mutation of inputs.
The service layer owns identity resolution, storage, API endpoints, inference
routing and the learner workspace.

## What it guarantees

- **Identity separation.** Only exercises whose `ownerSubject` equals the
  authenticated `identity.subject` are compared. Unattributed local sessions and
  other participants are listed under `excluded` with a reason, never compared.
  Native Kamiwaza identity: resolve the signed `x-user-id` to `subject` before
  calling in; this module never touches headers or tokens.
- **Comparable attempts only.** Same `scenarioId` and same curriculum semver
  major. Branches are labelled `informed-practice` and never count as
  independent improvement, whenever they were opened; the "created before the
  current attempt" restriction applies only to independent trials. A branch as
  the current exercise suppresses comparison lines.
- **Submission versus execution.** In the debrief catalogue the order itself is
  timed at the tick the participant observed when submitting (`available-then`);
  its execution tick is stated in the text, and the post-execution state is a
  separate `hindsight` reference.
- **Unobserved is not failed.** Missing rationale yields a probe question, not a
  deduction. Superseded-source use is flagged only when `sourceIds` were
  explicitly recorded. No numerical mastery score exists anywhere in the output.
- **Available-then vs hindsight.** The debrief catalogue tags every reference.
  Reports and staff updates after the order's `observedTick`, the opponent
  controller's action summary and tool receipts, and the post-execution state
  are hindsight. `validateDebrief` rejects a claim labelled `available-then`
  that cites hindsight.
- **No hidden reasoning.** The opponent record is an external action summary
  plus tool receipts; the model's `observation` payload and receipt costs are not
  forwarded. Opponent-perspective claims that attribute motives are rejected.
- **No doctrine/mastery claims** unless an approved curriculum source is cited.
  With `SRC-000` (status `none`) nothing qualifies.

## Inputs the caller assembles

```ts
import type { ExerciseRecord, LearningInput } from '../learning/index';
```

| Field | Source in `GameService` |
| --- | --- |
| `identity` | `session.identity` (`subject`, `role`, `organization`) |
| `current.exercise` | `store.exercise(id)` plus `ownerSubject`, `scenarioId`, `curriculumVersion`, `assistance` (main persists these on the row/options) |
| `current.events` | `store.events(id)` |
| `current.reports` | `store.reports(id)` |
| `candidates` | same triple for every other exercise in the store; eligibility is decided here |
| `curriculum` | `docs/pilot/exercise-curriculum.json` |

Rationale evidence is read from a human command event's
`details.rationale`, `details.rationaleTiming` (`contemporaneous` \| `post-hoc`)
and `details.sourceIds`, or from a separate `decision_log` event whose
`details.commandId` matches the command. Intelligence-seat entries are
`assessment_log` events with `details.sourceIds`. If main records these under
other keys, adapt at the boundary; nothing else is inferred.

## Integration example

```ts
import curriculum from '../../docs/pilot/exercise-curriculum.json';
import {
  buildDossier, buildDebriefContext, validateDebrief,
  formatDossierMarkdown, formatDebriefMarkdown,
  type Curriculum, type ExerciseRecord,
} from '../learning/index';

// In GameService (main-owned), given a Session:
function recordFor(this: GameService, id: string): ExerciseRecord {
  const row = this.store.exercise(id)!;
  return {
    exercise: {
      id: row.id, name: row.name, kind: row.kind, humanSide: row.humanSide, parentId: row.parentId,
      forkTick: row.forkTick, createdAt: row.createdAt, status: row.status,
      ownerSubject: row.options.ownerSubject,            // main records at create()/branch()
      scenarioId: row.options.scenarioId ?? 'crosscurrent',
      curriculumVersion: row.options.curriculumVersion,   // e.g. curriculum.version at create time
      assistance: row.options.assistance ?? 'unknown',
    },
    events: this.store.events(id),
    reports: this.store.reports(id),
  };
}

// GET /api/learning/dossier
const current = recordFor.call(service, session.activeId);
const candidates = service.store.exercises().filter(e => e.id !== current.exercise.id).map(e => recordFor.call(service, e.id));
const dossier = buildDossier({ identity: session.identity, current, candidates, curriculum: curriculum as unknown as Curriculum }, { now: new Date().toISOString() });
res.json({ dossier, markdown: formatDossierMarkdown(dossier, { link: id => `#evidence/${encodeURIComponent(id)}` }) });

// POST /api/learning/debrief  { commandEventId }
const context = buildDebriefContext(current, req.body.commandEventId, curriculum as unknown as Curriculum, { maxChars: 12000 });
// Main owns the paid call and ledger: reserve, then send context.prompt.instructions + context.prompt.input
// with jsonSchema: context.outputSchema. Store the receipt.
const result = await service.luna.complete({ purpose: 'participant debrief', context: { exerciseId: current.exercise.id, subject: session.identity.subject }, instructions: context.prompt.instructions, input: context.prompt.input, maxOutputTokens: 1200, jsonSchema: context.outputSchema });
const verdict = validateDebrief(result.parsed ?? result.text, context);
if (!verdict.ok) {
  // Do not render an unvalidated debrief. Record the errors and offer a retry; the receipt still counts.
  return res.status(422).json({ errors: verdict.errors, receiptId: result.receipt.id });
}
res.json({ debrief: verdict.debrief, context: { references: context.references, availableThenIds: context.availableThenIds, hindsightIds: context.hindsightIds }, markdown: formatDebriefMarkdown(verdict.debrief!, context) });
```

`link` is optional. Without it, IDs render as plain code; no URL is guessed.

## Exports

| Function | Purpose |
| --- | --- |
| `buildDossier(input, {now?})` | `Dossier` JSON: counts, observed behaviours with event IDs/ticks, prior comparison lines, gaps, probes, targeted practice, next-session plan, counterfactual practice (separate), limitations. |
| `buildDebriefContext(record, commandEventId, curriculum, {maxChars?, hindsightLimit?})` | Reference catalogue, prompt instructions + bounded JSON input, output JSON schema. |
| `validateDebrief(modelJSON, context)` | `{ok, errors, debrief?}`. Object or JSON string accepted. |
| `formatDossierMarkdown(dossier, {link?})`, `formatDebriefMarkdown(debrief, context, {link?})` | Compact Markdown with disclaimer. |
| `classifyCandidate`, `curriculumMajor`, `rationaleFor`, `sourceStatusAt`, `humanCommands` | Building blocks, exported for reuse and tests. |

## Not in scope here

API endpoints, inference routing and ledger reservations, rationale capture UI,
the rendered learner workspace, filesystem writes. Tests live in
`tests/learning/`.
