# Context integration review: expert on their own identity

2026-09-15 (UTC). Read-only source review of the working tree against the deployed native **0.22.1** (`docs/stages/status.json` → `delivery.current_native_image`, source `0b0fb151…`). Nothing was executed: no native, browser, model, test or build calls. Every claim below points to code or retained evidence. "Needs fresh validation" means no retained receipt covers it on 0.22.1.

**Target flow:** an expert signs in with their own Kamiwaza account → sees context for their seat → asks Tomo to watch something while play continues → reviews sources that change → queries their earlier decisions.

## 0. What is deployed and what is not

| Deployed in 0.22.1 (native) | Working tree only / not in the image |
|---|---|
| Native login, seat mapping, `replay_profiles` (`src/server/native-session.ts`) | Operator scripts: `scripts/ai-player-trial.ts` (modified, `seat-context/1`), `scripts/dual-model-trial.ts`, `scripts/run-dual-model-trial.py`, `tests/operators/`, `tests/learning/{dual-model-trial,red-seat-context}.test.ts`. Offline harnesses only; status says "no runtime delta" (`development.not_deployed`). |
| Tomo entry, capped conversation and model bridge (`src/server/tomo-*.ts`), MCP reads + `create_watch` (`REPLAY_MCP_WATCH_WRITE=true`, `scripts/platform/upgrade-replay.ts:11`) | `scripts/platform/qualify-native-guarded-voyage.ts`: this runs *against* 0.22.1 and is not part of it. Receipts: `d84d5f9d` passed, `fbd6bb2d` no-legal-candidate, `a0e6eb11` failed/refused-other. |
| `crosscurrent-evidence/1` packet, source-chain UI, deterministic watches, practice history, Decision perspective, branch | `src/client/views/ExerciseView.tsx` has an uncommitted edit (queued "exercise keeps running on ended map" copy fix, `native-0221-ui-review.json` limitations). The line numbers cited below are from the working tree. |

Red in the native app is still the scripted `objectives/1` controller. Neither the dual-model nor the Red-seat work is shipped, and it doesn't touch the expert flow.

## 1. Reuse, don't rebuild

- **Pinned OpenFront engine** (`src/engine/engine.ts`) already covers legal validation (`service.ts:175`), deterministic ticks and fingerprints, rewind and branch, transport, and station control under `NETWORK_RULES` (`src/campaign/network.ts:3-4`). Packet claims stay authored scenario text layered on top. No new rules layer is needed for context.
- **Native Kamiwaza 1.2.0** already covers these pieces:
  - Password login at `POST /auth/token` (`src/platform/client.ts:257-281`).
  - Signed ForwardAuth identity (`src/platform/forward-auth.ts`).
  - Runtime context with `effective_workroom_role`, `can_edit` and `can_run_agents` (`native-session.ts:369-387`).
  - Workroom attributes, already read for `replay_profiles` (`native-session.ts:381-383, 857-868`).
  - ReBAC `POST /auth/check` (`client.ts:368-381`).
  - Extension patching (`upgrade-replay.ts:14-19`).
  - **Tomo 1.2.0**, which provides the conversation UI, agent and member MCP catalog, and calls REPLAY MCP with the *member's own bearer* (`src/server/mcp-auth.ts:4-25`). Use it as the chat surface. Don't build another chat.
  - Native model route and Graphiti. Graphiti is component-qualified, but packet graph ingestion is still pending (`context-and-practice-memory-plan.md:144`), so the SQL projection remains the authoritative query path.
- **Keep in REPLAY:** the durable watch service. Native Tomo background tasks still lack end-user authority forwarding (`context-and-practice-memory-plan.md:106`), and `createMcpWatch` already binds owner, side and tick server-side (`mcp-watch-service.ts:57-104`).

## 2. Top three gaps

### Gap 1: A new expert's own account can't reach Tomo or delegate without a redeploy and three separate operator steps

**Observed basis**
- The Tomo conversation is gated by a **deploy-time env allowlist**:
  - `REPLAY_TOMO_SUBJECTS` is parsed once at boot (`src/server/index.ts:44`).
  - It is baked from `data/platform/tomo-conversation.json` into the extension env (`scripts/platform/upgrade-replay.ts:15`).
  - It is enforced in three places: the status route (`index.ts:75`), the conversation entry, which returns 403 `tomo_pilot_not_enabled` (`tomo-conversation-entry.ts:42`), and the native model route (`index.ts:56`, `subjects:tomoSubjects`).
  - Adding one expert means an extension PATCH and a restart.
- **Default seat mapping blocks the intelligence role entirely:**
  - viewer maps to intelligence (`native-session.ts:11-14,174-179`).
  - Tomo POST requires `requireWrite`+`requireAgents` (`tomo-conversation-entry.ts:41`).
  - The Staff panel watch goes through `/api/staff` `requireWrite` (`native-http.ts:776`), and MCP `create_watch` requires `canEdit` (`mcp-watch-service.ts:67`).
  - An Intelligence expert who delegates therefore needs editor/operator workroom role, *plus* `can_run_agents`, *plus* a `replay_profiles[subject].role="intelligence"` attribute, *plus* the env allowlist.
- **Nothing tells the user which of those is missing.** `PlatformView.tsx:29` shows only "Conversations are not enabled for this sign-in yet". `/api/tomo/status` returns no reasons (`index.ts:75`).
- **Two roles asking at once collide.** The bridge is single-flight and immediately returns 429 `tomo_model_busy` (`tomo-model-bridge.ts:107`), so simultaneous Commander and Intelligence questions fail rather than queue.
- **Shared capacity is small.** 93/100 app requests are used (`status.json` `paid_inference`), and the Tomo route has 17/26 attempts (`tomo_runtime`). The 0.21.0 Tomo watch used 2 requests (`evidence/platform/tomo-watch-0.21.0-main-review.json`), so only about three Tomo turns remain across all participants. This is a constraint to plan around, not a budget request.
- Access is still the private tunnel on a loopback host with `REPLAY_COOKIE_SECURE:false` (`upgrade-replay.ts:11`; `expert-first-session.md:183`). Sign-in is only the REPLAY username/password form (`native-http.ts:538-550`). A federated/SSO-only account path is unqualified.

**Repro (operator, no paid calls):** provision a fresh workroom member with viewer role → sign in → Platform view shows "not enabled for this sign-in" → Staff panel "Monitor report provenance" → 403 `read_only`. Promote to editor → Staff watch succeeds, but Tomo still shows preview-only (subject not in env) until redeploy.

**Minimal plan**
1. Add an opt-in `REPLAY_TOMO_SUBJECTS=workroom-profile` mode. In that mode, a subject is enabled when `replay_profiles[subject].tomo === true`. Read it in `readProfile` (`native-session.ts:857`) and mirror it in `mcp-auth.ts`, which already copies the profile logic "byte for byte". Expose `tomoEnabled` on `NativeIdentity` and use it at `index.ts:56,75` and `tomo-conversation-entry.ts:42`.
   - Writes already fetch attributes fresh (`native-session.ts:351,381`), so revocation takes effect on the next POST.
   - The existing explicit list stays the default. A profile still grants no write or agent permission.
2. Extend `/api/tomo/status` with booleans only: `seat`, `canEdit`, `canRunAgents`, `tomoEnabled`, `watchCreationEnabled`, `sharedRequestsRemaining`. Render one line per missing prerequisite in `PlatformView.tsx:27-32`, e.g. "Workroom role is read-only: ask the owner for editor access." No identifiers or secrets.
3. In `tomo-model-bridge.ts:107`, replace the immediate `tomo_model_busy` with a bounded in-process wait of ≤20 s for the single slot. Keep the reservation, fingerprint and cap checks at `:108-111` unchanged. No extra provider calls.

**Acceptance checks**
- Unit tests:
  - Profile-mode subject allowed; attribute removed → next conversation POST 403.
  - A `tomo:true` profile on a viewer is still 403 `read_only`.
  - Env list mode unchanged.
  - Status reasons contain no token, subject list or workroom attributes.
  - Two concurrent bridge calls run serially and both complete; a duplicate fingerprint is still refused 409.
- Native (zero paid): a newly provisioned expert account, with no redeploy, sees `tomoEnabled:true` after the owner sets the attribute; revocation flips it within one fresh write check. Needs fresh validation: that attribute writes are owner-restricted on the installed platform.

### Gap 2: Role context and changing sources never appear in the same exercise, and Tomo tools carry no role context

**Observed basis**
- **The changing-evidence scenario has no organization pack.**
  - `SCENARIO_PACKS` maps only classic/maneuver/crossing and network/objectives (`src/context/exercise-context.ts:5-11`; `organization-packs.ts:274,296,313`).
  - `crosscurrent-evidence/1` (`src/scenarios/catalog.ts:39-41`) therefore gets no `organizationPack` at creation (`service.ts:115-116`).
  - `RoleContextPanel` renders nothing (`RoleContextPanel.tsx:10`, `ExerciseView.tsx:63`), and staff chat gets `organizationContext:null` (`service.ts:546`).
  - The only role cue is one sentence, `sourceDesk.focus` (`evidence-packet.ts:135-139`, `service.ts:529`), inside a collapsed `<details>` in the Staff panel (`StaffPanel.tsx:170`).
- **Conversely, the expert protocol's scenario has no source packet.** The pack-bearing "stations and reserves" scenario (`expert-first-session.md:187`) has no evidence packet, only instructor-injected reports.
- **Tomo reads are role-blind.** `get_exercise_state` returns forces and provenance only (`mcp-service.ts:235-252`), and `get_replay_provenance` returns released reports (`:340-366`); neither includes seat, report template or focus. The Tomo conversation tool allowlist is `get_exercise_state`, `get_replay_provenance`, `search_practice_history`, `create_watch` (`index.ts:45`). `list_exercises`, the only tool that returns `viewer.role` (`mcp-service.ts:228`), is excluded, so the user must paste the UUID from `PlatformView.tsx:30`.
- **Packet claims don't connect to the playable board.** Packet entities (Lantern/Marsh/Tidewell, `evidence-packet.ts:141-145`) aren't the objective stations (Aster/Beacon/Cedar…, `network.ts:4`), and no mapping exists in `src/scenarios`. This is deliberate for honesty (`docs/demo/changing-evidence-demo.md:29`), but a source question can't yet change a decision on the map. Adding a mapping is a **product decision**: it would need a new, disclosed, versioned scenario, not a quiet edit of `/1`.

**Repro (zero paid):** create "Crosscurrent · changing intelligence" as Commander, then again as Intelligence in a second profile → no "Your role context" panel for either; the Staff → source desk sentence is the only difference. Call MCP `get_exercise_state` as each → identical shape, no role fields.

**Minimal plan**
1. Append a new immutable pack, `crosscurrent-changing-evidence@1.0.0`, to `ORGANIZATION_PACK_CATALOG` (`organization-packs.ts:313`); never edit existing versions. Reuse the island role views, add an intelligence "source lineage" field and a commander "open questions before committing" field from `monitoringFocus`, then map `crosscurrent-evidence/1` in `SCENARIO_PACKS`. Only new exercises receive it; retained records still return null (`exercise-context.ts:18`).
2. Add `roleContext: {seat, organizationContext: agentOrganizationContext(row.options, identity.role), sourceDeskFocus}` to `get_exercise_state`. Compute it after `recheckIdentity`, reusing the existing 6,000-byte bound (`agent-context.ts:8`).
3. Show `sourceDesk.focus` at the top of `RoleContextPanel` instead of hiding it in the Staff panel.
4. Optional: add read-only `list_exercises` to `tomoMemberTools` (`index.ts:45`) so Tomo can find the active exercise itself. It adds tool-schema bytes against the 32 KiB chat input, so needs fresh validation.

**Acceptance checks**
- Unit tests:
  - New evidence exercise resolves the new pack for all three roles.
  - Legacy evidence exercise overview is byte-identical.
  - Commander and Intelligence `get_exercise_state` on the same exercise return different `report.id` and focus.
  - A profile role change is reflected on the next call.
  - Output stays under `MAX_TOOL_OUTPUT_BYTES` (`mcp-service.ts:99`).
- Native (zero paid): one two-seat direct-MCP check on a new 0.22.x exercise using the existing `mcp-watch-0.20.0` qualifier pattern. At most one Tomo question afterwards (about 2 requests).

### Gap 3: "What did I decide last time, and why?" can't be answered: reasons and source status are dropped

**Observed basis**
- **Reasons are stored:** command rationale in `details.rationale` (`service.ts:174-186`) and post-hoc statements in `decision_log.details.text` (`service.ts:629`).
- **Practice history drops the text:**
  - It projects only `rationaleRecorded: boolean` (`src/server/practice-history.ts:38`); the UI shows "Written reason recorded" (`PracticeHistoryPanel.tsx:246`).
  - Literal search covers only `summary`, `kind`, exercise name and scenario ID (`practice-history.ts:30`), so searching a word from your own note returns nothing.
- **Source status is lost.** Items carry bare `sourceIds` (`:38`). Whether a cited source was current, superseded or disputed at the order, and what happened later, lives only in `get_replay_provenance` (`mcp-service.ts:363`, `store.reports(id, asOf)`). Getting it means an extra tool round per exercise, which the remaining Tomo requests can't afford.
- **Output size matters.** The one actual Tomo history query retrieved correct facts, but Tomo's outer tool display truncated at 8,000 characters on a 1-item page, and the answer used a non-integer count (`docs/process/tomo-history-attempt1-review.md`). Pages must stay small.

**Repro (zero paid):** in an evidence exercise, send an order with Decision note "hold Marsh reserve until correction" citing `blue-r02` before tick 600 → End for review → My practice, search "Marsh" → no result. Search by scenario → item says "Written reason recorded" with the bare ID `…:blue-r02`; no text and no "superseded by blue-r04 at 600".

**Minimal plan (new `replay.practice-history/2`; keep `/1` responses byte-stable for existing verifiers)**
1. Add `statement: {text ≤500 redacted with the existing `text()`, timing: 'contemporaneous'|'post-hoc'} | null` from `details.rationale` / `details.text`. Visibility is unchanged: `mine` stays actor-only (`practice-history.ts:28`), and `workroom` stays instructor-only (`:17`).
2. Add `sources: [{id, statusAtDecision, laterStatus, supersededBy, disputedWith}]`. Compute it with `store.reports(exerciseId, observedTick)` and the completed cutoff, limited to reports visible to the item's side.
3. Extend the search to `json_extract(details,'$.rationale')` and `'$.text'`.
4. Default the MCP `limit` to 5 and add a test that serialized output stays well under 8,000 characters.

**Acceptance checks**
- Unit tests:
  - Own note text is searchable; another participant's note never appears in `mine`, and it appears for the instructor in `workroom`.
  - Post-hoc text is never labelled contemporaneous.
  - Order citing `blue-r02` before 600 → `statusAtDecision: current`, `laterStatus: superseded`, `supersededBy: blue-r04`.
  - Branch-inherited events are not duplicated.
  - `sk-` strings are redacted.
  - Revoked enrollment hides items.
  - Live exercises are excluded.
  - Zero inference calls.
- Native (zero paid): direct MCP `search_practice_history` on the retained integrated exercise `70d107e2-f0e3-414c-bdc8-33e2cc6a9852` (`evidence/platform/integrated-learning-demo-0211-main-review.json`) returns statement and source status.

**Integration order:** Gap 1 (unblocks every real account) → Gap 3 (zero-inference, directly answers "prior decisions") → Gap 2. Each is independent and testable offline.

## 3. Next demonstration (about 8 minutes, existing features, 0.22.1)

Evidence labels: **[Q]** = a retained qualification exists; **[FV]** = needs fresh validation on 0.22.1 before recording. Label live vs recorded on screen. Red is scripted `objectives/1`. Use no more than one Tomo conversation (about 2 of the 7 remaining requests); everything else is free.

| Time | Beat | Status |
|---|---|---|
| 0:00–0:40 | Commander signs in with a provisioned account; header shows Kamiwaza identity, workroom, seat and access badge. | [Q] 0.4.1/0.10 distinct native sign-ins. [FV] on 0.22.1 with the actual expert account (Gap 1 provisioning done by hand). |
| 0:40–1:20 | New → "Crosscurrent · changing intelligence". Show objectives and the Staff source-desk focus. Second browser profile: Intelligence shows its own focus sentence. | [Q] 0.18.0 packet and 0.21.1 integrated run. [FV] visual check of the role focus in both seats; say plainly that no role pack panel exists for this scenario yet (Gap 2). |
| 1:20–2:40 | Platform → Open Tomo assistant → "Monitor report provenance" for the shown exercise ID, **before tick 600**. Back in Exercise → Staff → Watches shows the owned free watch. **Free fallback if Tomo is slow, busy or denied:** type the same phrase in the Staff panel (`service.ts:533-537`, no inference). | [Q] `tomo-watch-0.21.0-main-review.json` (watch at tick 46, 2 requests). [FV] `/api/tomo/status` on 0.22.1 shows `watchCreationEnabled:true` for this subject, and Tomo latency stays within the window. |
| 2:40–4:10 | Play continues. Give an order with a Decision note citing `blue-r02`. Tick 600: the watch alerts on `blue-r04` superseding `blue-r02`. Tick 900: `blue-r06` disputes `blue-r05`. Open Report perspective. Intelligence publishes one source-linked assessment. | [Q] `late-watch-0.21.1-main-review.json` (alerts at 600/900, zero retroactive), integrated 0.21.1 (Intelligence assessment; orders were **scripted**). [FV] a human-driven browser order in this scenario on 0.22.1. |
| 4:10–5:40 | End for review → Review → select the order → Decision perspective with the hindsight toggle; the source chain shows what was current then vs later. | [Q] 0.16.2 browser perspective/toggle; `native-0221-ui-review.json` observed/admitted/recorded timing. [FV] source link-to-rewind browser retake (`core-acceptance-plan.md:66`). |
| 5:40–6:50 | Continue from here → Branch at the order tick → one different order; return and confirm the original is unchanged. | [Q] `substantive-practice-0212-main-review.json` (automated branch, original preserved). |
| 6:50–8:00 | My practice → search by scenario → open the retained event in Review. State the limit honestly: the reason shows only as "recorded" (Gap 3). Optionally show the **retained** Tomo history receipt labelled as recorded; don't re-run it. | [Q] 0.17.1 practice history and event→Review navigation (zero inference). The recorded Tomo history receipt is partial (strict verifier failed). |

**Do not show or claim:** a model Red player, dual-model results, doctrine grounding, human validation, learning effect, Graphiti search of the packet, or SSO/public access.

## Main follow-up after this static review

The actual offline Sol-Blue/Opus-Red six-round trial is now verified (12providerreplies,79sourcehashes,finalreplay); it may be shown with its offline/capped labels, but is not deployed native Red. The existing native app can run a Luna opponent when enabled; the current recorded demonstration used scripted objectives and every paidcontroller is now off. The review’s “do not show model Red” applies to claims about that native recorded demo, not the separately verified offline result. The Intelligence restriction described above is the default viewer mapping, not an inherent prohibition: configured editor participants can retain Intelligence presentation via replay_profiles. Main is implementing role/source pack and versioned compact prior-decision text after independent review.
