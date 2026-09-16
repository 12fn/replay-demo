# Assessment and data export procedure

What can be exported from the build as implemented, by whom, and how. Every path below exists in `src/server/native-http.ts`, `src/server/learning-routes.ts`, `src/server/agent-routes.ts`, `src/server/review-routes.ts`, `src/review/assessment.ts` or `src/server/store.ts`. Nothing here sends data outside the REPLAY server.

## 1. What exists and where

| Data | Where it lives | Export path |
| --- | --- | --- |
| Personal dossier (counts, observations, gaps, probes, practice, limitations) | Computed on request from the exercise record | `GET /api/learning/dossier` (JSON) and `GET /api/learning/dossier.md` (Markdown attachment); "Markdown" button in the Learning panel |
| Validated debrief of one order | `settings` table, key `learning.debrief:<exerciseId>:<eventId>` | `GET /api/learning/debrief/:eventId` (JSON with `record.markdown`); "Markdown" button in the debrief view (browser download) |
| Engine record (all turns and state fingerprints) | `turns` table | `GET /api/record/:id` (JSON: `version`, `upstreamCommit`, `options`, `turns`, `fingerprints`) |
| Watch with its trace (updates, model decisions, receipts, rejections) | `tasks` and `events` tables | `GET /api/agents/tasks/:id` (JSON `{task, trace}`) |
| Tool catalog, opponent mode and budget for a side | Computed | `GET /api/agents/tools?side=blue` |
| Current overview (state, filtered timeline, reports, tasks, findings, dossier summary, platform block) | Computed | `GET /api/overview` (JSON). The timeline is **filtered**: the last 120 visible events plus all human commands, reports, staff updates and watch creations; opposing-side events only after the end or for an instructor. Not a complete export. |
| Authorized complete learning evidence | `replay.sqlite` and `inference.sqlite` | `GET /api/review/export.json` and `/api/review/export.md`; Review → Download evidence bundle / Readable review. JSON includes full authorized events, reports, tasks, canonical replay, receipts, debrief versions, curriculum hash and instructor judgments. |
| Instructor judgment history | Append-only `settings` entries | `GET /api/review/assessment`; native instructor writes through Review → Record an instructor judgment. Scores require cited evidence; changes append a new version. |
| Inference ledger (paid requests, reservations, settlements) | `inference.sqlite` | Selected exercise receipts are included in the authorized review bundle. All receipts for that exercise, including unrendered/failed output, are included after completion or for instructors. Cross-exercise receipts are excluded. Global summaries remain in the agent/learning responses. |
| Native session material | `data/native/` (AES-256-GCM at rest) | Never exported. Contains platform tokens. Exclude from any copy. |

Data directory: `REPLAY_DATA_DIR`, default `./data` locally; `/data` on the retained volume in the native deployment (`evidence/platform/replay-upgrade.json`).

## 2. Per-learner export through the API (native mode)

Access rules are enforced server side on every call: a learner can read only exercises they own in the configured workroom; an instructor can read every exercise in the workroom. The dossier is produced only for the signed-in subject's own attributed exercise; an instructor cannot generate another participant's dossier through the API. The learner exports it themselves, or the instructor uses section 3.

1. Learner signs in and selects the exercise (header selector or `POST /api/select {exerciseId}`).
2. Learner presses "Markdown" in the Learning panel (`GET /api/learning/dossier.md`). File name `replay-dossier-<first 8 of exercise id>.md`.
3. For each generated debrief, press "Markdown" in the debrief view, or fetch `GET /api/learning/debrief/:eventId` and save `record.markdown`. The `stale` flag says whether the record changed after generation.
4. Open Review and download the evidence bundle (`GET /api/review/export.json`) plus Readable review. Repeat for each branch. Completed exercises and instructors receive canonical replay inputs; a live learner bundle withholds opposing private records and complete canonical inputs. Verify the SHA256 over the JSON serialization of `payload`; this is an integrity reference, not an administrator-proof signature.
5. For each watch of interest, `GET /api/agents/tasks/:id`.

Store the files under the learner's pseudonym with the exercise ID, following `consent-and-learning-records.md`.

## 3. Optional operator inspection (read-only)

The authenticated review bundle is the normal handoff path. The following direct inspection is optional for troubleshooting. Open the store read-only while the API is stopped or use a copy; the database runs in WAL mode.

```
sqlite3 -readonly data/replay.sqlite
```

```sql
-- exercises in the store (id, name, kind, owner, workroom, curriculum version)
SELECT json_extract(body,'$.id'), json_extract(body,'$.name'), json_extract(body,'$.kind'),
       json_extract(body,'$.options.ownerSubject'), json_extract(body,'$.options.workroomId'),
       json_extract(body,'$.options.curriculumVersion'), json_extract(body,'$.options.assistance')
FROM exercises ORDER BY rowid;

-- complete ordered event log for one exercise
SELECT sequence, id, tick, kind, actor, side, summary, details, recorded_at
FROM events WHERE exercise_id = :exercise ORDER BY sequence;

-- reports released to each side
SELECT tick, json_extract(body,'$.side'), json_extract(body,'$.id'), json_extract(body,'$.title'),
       json_extract(body,'$.supersedes') FROM reports WHERE exercise_id = :exercise ORDER BY tick, rowid;

-- every order, accepted or rejected, with its settlement body
SELECT id, actor, side, status, intent, body FROM commands WHERE exercise_id = :exercise ORDER BY rowid;

-- cached debriefs for one exercise
SELECT key, value FROM settings WHERE key LIKE 'learning.debrief:' || :exercise || ':%';
```

Export as CSV or JSON with the SQLite `.mode` and `.output` commands. Event `details` is a JSON string; the fields used by the rubric are listed in `rubric-provisional.md`.

Event kinds you will see, all written by `src/server/service.ts` or `src/server/native-http.ts`: `exercise_started`, `report`, `command`, `command_rejected`, `decision_log`, `assessment_log`, `task_created`, `task_model_changed`, `staff_update`, `staff_answer`, `staff_rejected`, `staff_model_decision`, `staff_tool_result`, `staff_model_error`, `staff_result_discarded`, `controller_changed`, `model_decision`, `tool_result`, `model_error`, `model_result_discarded`, `branch_created`, `inherited_event`, `exercise_ended`, `exercise_completed`, `service_fault`, `debrief_generated`, `debrief_rejected`, `debrief_unavailable`.

## 4. Inference ledger

```
sqlite3 -readonly data/inference.sqlite '.tables'
```

Receipts carry purpose, context (exercise, subject, side or tick), model requested and returned, reserved and settled micro-USD, token counts and provider IDs. No prompt or completion text is stored in the ledger. Include the summary (requests used, committed USD) in the pilot report.

## 5. What is not available

- No xAPI, Moodle, CSV or ZIP export endpoint. Build one only after the record schema is stable.
- No instructor-side "export all learners" call. Use section 3.
- No export of the platform session store, by design.
- Local-demo exercises without an owner are excluded from every dossier and, in native mode, are visible only to instructors with `REPLAY_ALLOW_LEGACY_RECORDINGS=true`.

## 6. Hygiene

- Copy files, never the live `replay.sqlite` while the API runs, unless the copy tool handles WAL.
- The application export redacts credential-shaped fields. Preserve evidence IDs and source timing when preparing pseudonymized research copies.
- Do not upload any export to an external service. See `consent-and-learning-records.md` section 5.


##0.6.0 assessment target privacy

The JSON bundle's assessment object uses replay.assessment/2 and includes target, targets, findings and evidence options. New judgment rows keep replay.instructor-judgment/1 with optional participantSubject and evidenceOwnership. Missing participantSubject continues to mean exercise-wide; old rows are not rewritten. Markdown has separate exercise-wide and named-participant sections. A learner's exports exclude other participants' personal judgments, even after completion; the already released shared game events and roster remain shared. Instructor export contains all recorded participant judgment streams.

New UI judgment writes carry the intended exerciseId. If session navigation changes the active exercise before the server handles the save, the write is refused. Evidence ownership is a mechanical attribution check, not automated confirmation of the instructor's rationale. All0.6.0native qualification entries are explicitly automated, withheld and unscored; they are not SME assessments.
