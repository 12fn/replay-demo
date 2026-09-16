# Public source release

This repository is a clean REPLAY source snapshot. It starts new Git history so private development records, participant sessions and provider traces are not published. The original private repository remains preserved.

## Scope

The application version is 0.29.6. It gives the configured external Sol route a 60-second response window and shows pending-request and error-receipt details. The sponsored unlimited application allowance, native account switching, explicit server model/project configuration and authorization recovery behavior remain unchanged. Public tests use clearly synthetic records. Historical tests that require private trial archives are isolated under `tests/private-fixtures/`; they are not part of the public default test run. That private suite requires an explicit fixture root and fails when its required inputs are unavailable.

The source includes the deterministic engine, browser interface, native platform integration, agent and retrieval code, pinned upstream code, synthetic showcase resources, the derived catalog graph, and license notices. The graph describes supplied catalog records; it does not claim that those records were bulk-ingested into a live platform ontology.

Excluded material includes runtime databases, credentials, operator account records, private network configuration, browser state, raw model-provider sessions, private recordings, development transcripts and historical build logs. Documentation in `docs/pilot/` records prototype design and prior review context; it is not evidence of a completed instructor pilot. Installation-specific access and saved outputs require preparation in the target deployment.

## Verification

The private 0.29.0 baseline passed 1,954 tests using its supplied private fixtures. The 0.29.3 authorization/navigation change passed 272 focused tests, typecheck, build, and a native browser check of a real cookie handoff. During authorization refusal the protected interface disappeared; after verified recovery the same exercise and Debrief selection returned.

The reviewed 0.29.6 application patch passed **2,082 tests across 147 files**, with zero failures, skips or todo tests, plus TypeScript and production build. The two-worker suite took 128.22 seconds. Its 109 focused inference tests verify the 60-second Sol deadline across both transports, successful responses after the former 25-second deadline, stalled response headers and bodies, retained uncertain reservations, and refusal to retry or overwrite a timed-out receipt. Five historical test files remain explicitly excluded as the separate private scope; they are not counted as passing or skipped tests. Exact integration into this release changed only the five reviewed files, package version and these release notes; the final package passed production build. These checks made no provider requests.

A prior live Sol qualification reached the former 25-second timeout without a completed debrief. Its uncertain usage reservation and original records were retained, and the request was not retried. The 60-second change is tested with synthetic transports; successful live Sol performance still requires separate deployment qualification. A timeout does not prove provider cancellation or final billed usage. Per-request input/output limits and no-automatic-retry behavior remain in force; leaving the view does not cancel a request.

The native session tests include 10,001 forged-token switch requests that left the refusal store empty while legitimate login still succeeded. Bound expired/blocked sessions can request sign-out without reauthorizing protected content. Deployment qualification of account switching and live model performance is recorded separately; these source test results do not substitute for it.

## Rebuild

Use Node 24.5.0 and pnpm 10.17.1:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

The production build creates `public/replay-source.tar.gz` and `public/replay-build.json`. They describe the same corresponding-source archive. Keep both together when deploying. The archive is generated from an explicit allowlist, not from the whole working directory. Supply secrets and runtime data separately on the server.

## Privacy review limits

The release process compares available local credential values, known private provider session identifiers and qualification identities, and runs a secret-pattern scanner over source and archive members. A clean scan establishes the checked scope; it does not prove that every possible sensitive value can be recognized. Public binary resources are limited to supplied partner marks and pinned upstream/game assets rather than private screenshots or recordings.

## Product limits

REPLAY supports inspection, practice and educational demonstrations. General game import, physical tabletop reconstruction, measured learning outcomes, and instructor acceptance remain separate work. Generated interpretations retain their source and perspective context. A deployed Spark app may use an external API model; that is distinct from inference on its local GPU.

The native Chat continuation requires a compatible Tomo runtime, an authorized member-owned helper and its scoped tool binding. That compatible runtime is absent from the current qualification environment. Its installed OpenHands service has a different API and has not been qualified as a Tomo substitute. This release does not claim a working native Chat continuation.
