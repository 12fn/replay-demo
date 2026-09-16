# Public source release

This repository is a clean REPLAY source snapshot. It starts new Git history so private development records, participant sessions and provider traces are not published. The original private repository remains preserved.

## Scope

The application version is 0.29.5. It retains native account switching, explicit external model/project configuration, and task-based interface copy from 0.29.4, and adds an explicitly configured unlimited application allowance for sponsored model credentials. The native authorization recovery fix from 0.29.3 is retained. Public tests use clearly synthetic records. Historical tests that require private trial archives are isolated under `tests/private-fixtures/`; they are not part of the public default test run. That private suite requires an explicit fixture root and fails when its required inputs are unavailable.

The source includes the deterministic engine, browser interface, native platform integration, agent and retrieval code, pinned upstream code, synthetic showcase resources, the derived catalog graph, and license notices. The graph describes supplied catalog records; it does not claim that those records were bulk-ingested into a live platform ontology.

Excluded material includes runtime databases, credentials, operator account records, private network configuration, browser state, raw model-provider sessions, private recordings, development transcripts and historical build logs. Documentation in `docs/pilot/` records prototype design and prior review context; it is not evidence of a completed instructor pilot. Installation-specific access and saved outputs require preparation in the target deployment.

## Verification

The private 0.29.0 baseline passed 1,954 tests using its supplied private fixtures. The 0.29.3 authorization/navigation change passed 272 focused tests, typecheck, build, and a native browser check of a real cookie handoff. During authorization refusal the protected interface disappeared; after verified recovery the same exercise and Debrief selection returned.

The integrated public 0.29.5 quota implementation passed **2,075 tests across 146 files**, with zero failures, skips or todo tests, and passed TypeScript. The suite used two workers and took 105.67 seconds. It includes the public synthetic-fixture baseline, native switch and token-admission tests, external-model configuration/accounting tests, and unlimited-allowance admission, persistence and presentation tests. Subsequent neutral display-label/documentation changes passed 326 focused tests and typecheck; the final ontology heading passed five focused client tests and a production build. Five historical test files remain explicitly excluded as the separate private scope; they are not counted as passing or skipped tests. No paid model calls were made for this qualification.

The native session tests include 10,001 forged-token switch requests that left the refusal store empty while legitimate login still succeeded. Bound expired/blocked sessions can request sign-out without reauthorizing protected content. Actual public-ingress two-user switching and live performance of a newly selected external model require separate deployment qualification; the source test results do not claim those are completed.

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
