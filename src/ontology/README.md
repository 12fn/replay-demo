# `src/ontology` · curated domain ontology for the shared workroom graph

The canonical source of what REPLAY publishes into the workroom's native
Graphiti instance. Pure data plus deterministic packaging; no I/O here.

| File | Role |
| --- | --- |
| `domain.ts` | The source archive: 7 concepts (Exercise, PlayerTool, Decision, SourceReport, StaffWatch, Branch, LearningObjective) and 14 rules about legal tools, source supersession, the clock, replay and branch isolation. Abstract game only. Browser-safe. |
| `source.ts` | Canonical text rendering, `sha256` content hash, the exact `AddKnowledgeRequest` (one bounded `user` message citing source id, version and hash, plus a typed `entity_types` schema with `Entity` excluded), the durable ingestion key and the local projection. |

**What is never in the shared graph:** learner profiles, personal orders,
released report texts, user identifiers, exercise ids. The per-subject learning
projection (`src/learning`) stays private to REPLAY. A private workroom
learning graph is a separate, later decision for main once an appropriate
scope exists.

**Versioning:** any edit to `domain.ts` changes the hash; bump `version` and
the pinned hash in `tests/ontology/source.test.ts` together. The ingestion key
(`ontology.publish:<workroom>:<ontology>:<sourceId>@<version>:<hash16>`) is
what makes "one modelling batch per version per workroom" durable.

## Server: `src/server/ontology-routes.ts`

```ts
import { mountOntologyRoutes } from "./ontology-routes.ts";

createApp({
  service, config, native, root,
  mount: (app) => {
    mountLearningRoutes(app, service);
    mountOntologyRoutes(app, service);          // reads REPLAY_ONTOLOGY_ID from process.env
    // or: mountOntologyRoutes(app, service, { env, now, healthCacheMs, maxNodes, maxEdges })
  },
});
```

`REPLAY_ONTOLOGY_ID` must be the UUID of the workroom's ontology instance
(`evidence/platform/ontology-created.json` → `instance.id`). Unset means
"unconfigured": reads say so, publish answers 409. Set-but-invalid throws
`OntologyConfigError` at mount so a bad deployment cannot start.

The routes use `app.locals.guards.requireActive` on every route and
`requireAgents` on publish when mounted through `createApp`, so a revoked seat
or a stale exercise fails closed with the app's own denial shape. Identity,
workroom and permissions come only from `res.locals.session` and
`res.locals.native`; the request body can only carry
`{ acknowledgeDuplicateRisk?: boolean }`.

| Route | Who | Cost | Notes |
| --- | --- | --- | --- |
| `GET /api/ontology` | any signed-in seat with a visible active exercise | none | health + bounded subgraph (cached ≤15 s per workroom), source metadata, local definition (labelled), publish state and receipts. Outages are reported as error blocks with native request ids. |
| `POST /api/ontology/publish` | instructor seat with fresh native `can_edit` + `can_run_agents` | one Graphiti batch; extraction billed through the metered bridge | `pending` persisted before the call; `accepted` only on `added_count ≥ 1` without backend error; `uncertain` (timeout / transport / 5xx after send) blocks until acknowledged; `failed` (denied / 4xx / backend rejection) can be re-sent explicitly. Never retried automatically. Single-flight per ingestion key. |

## Client: `src/client/components/OntologyPanel.tsx`

```tsx
import { OntologyPanel } from "../components/OntologyPanel";
// Platform view (technical notes included):
<OntologyPanel ctx={ctx} />
// Anywhere a learner sees it:
<OntologyPanel ctx={ctx} mode="compact" />
```

Styles live in `src/client/ontology.css` (imported by the panel); the API
contract in `src/client/ontology-api.ts`.

## Tests

`tests/ontology/source.test.ts` (hash pinning, bounds, request shape, group
validation) and `tests/server/ontology-routes.test.ts` (unconfigured/local,
instructor + native permission, cache, outage truthfulness, durable pending,
single flight, no automatic retry, payload hygiene). No network, no paid calls.
