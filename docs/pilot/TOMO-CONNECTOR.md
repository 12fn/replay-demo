# Native exercise read connector

Qualified 2026-09-14 on actual local Kamiwaza 1.2.0. The `replay-tools` extension is a **Running tool** visible to the normal commander member. It forwards member requests to the existing REPLAY application; it has no exercise database, saved member token, workload credential or inference client of its own.

This proves native registration, member discovery and authenticated tool calls. **A real Tomo conversation has not yet been qualified.** The supplied seven-service Tomo runtime is now Running. A private API-image compatibility patch preserves seven signed Core1.2 fields that its bundled forwarding helper dropped. Its actual admin catalog discovered534tools; only the six REPLAY reads were enabled. An ordinary commander then discovered all six through the member capability catalog and was denied admin access. Authenticated browser entry, model routing and a real conversation are next.

Available tools:

| Tool | Purpose |
|---|---|
| `list_exercises` | Find exercises assigned to the caller in this workroom. |
| `get_exercise_state` | Read a public summary at live position or an explicit recorded tick. |
| `get_station_objectives` | Read station and reserve game points where the scenario supports them. |
| `get_team_assessments` | Read side-shared analyst entries, with observed/recorded timing. |
| `get_key_moments` | Retrieve selected evidence for the caller, or instructor shared scope. |
| `get_replay_provenance` | Read engine/scenario lineage and released source references at the cutoff. |

The app checks the calling member's bearer and workroom against native ForwardAuth and runtime context. It ignores caller-supplied identity headers. Reconstructed reads recheck authority before releasing data. Tools cannot issue orders, move a browser's selection, access another learner's personal coaching, run code or spend inference budget.

Operator evidence:

- `evidence/platform/replay-tool-0.11.0.json`: native creation request and receipt.
- `evidence/platform/native-mcp-0.11.0.json`: direct member protocol qualification.
- `evidence/platform/native-mcp-proxy-0.11.0.json`: commander catalog visibility and actual proxy calls.
- `docs/process/tomo-native-contract.md`: inspected supplied Tomo contract.
- `docs/process/tomo-mcp-implementation-notes.md` and `mcp-proxy-notes.md`: tested boundaries and runtime configuration.

The proxy image is `localhost/replay:0.11.0`; the app is now0.14.4; the proxy implementation is unchanged. The internal tool endpoint is `http://replay-tools-mcp.kamiwaza-extensions.svc.cluster.local:5181/mcp`. Public ingress is disabled. Host port 5184 was a temporary qualification tunnel, not a public product endpoint. The app remains available through the existing loopback tunnel on port 5183.

All records are from an abstract fictional game. Tool-provided game points and selected moments are not validated measures of mastery. Scheduled/background Tomo tasks require a separate authority design because the inspected release does not forward an active member's headers in those jobs.

Current evidence: `tomo-runtime-create-1.2.0.json`, `tomo-forwarding-image-1.2.0-envelope.1.json`, `tomo-forwarding-deployment-1.2.0-envelope.1.json`, `tomo-read-tool-selection-1.2.0-envelope.1.json`, and `tomo-native-member-1.2.0-envelope.1.json` under evidence/platform. The temporary installation-admin workroom membership was removed; the local5185diagnostic tunnel was closed. Tomo private credentials and proprietary images/source are not distributed in the handoff. See `../process/tomo-runtime-follow-up.md`.

## Conversation status in0.14.4

Actual supplied Tomo runs with normal member identity, durable room/input/event transport and a registered Core model. Local routing preserves native Core ForwardAuth because this k0s installation has no Istio gateway. The model request reaches Luna but returnsHTTP400. One input consumed the six-attempt provider allowance through upstream retries; all six were rejected at zero settledcost. The connector reads remain qualified, but a successful Tomo tool conversation is not yet available. The small complete example, broader agent/coding workflow and refreshed video remain outstanding. Do not demonstrate this as a working chat or reset its ledger. Details and preserved failures are in docs/process/tomo-local-native-routing.md, tomo-model-facade.md and evidence/platform/tomo-conversation-0.14.4.json.
