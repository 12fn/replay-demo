# Public fixture provenance

## Generated fixtures

- `synthetic-trial.ts` independently authors eight rounds of schema-shaped input in memory. It includes hold, expansion, construction and transport replies, partial completion feedback, two troop shares, both provider envelope formats and a swapped assignment. Every identifier, reply, fingerprint and accounting field is synthetic. No private trace was copied; no provider was called. It tests hashes, identity consistency, legal listed choices, release cutoffs, projection separation and mechanical counts.
- The production projector labels this schema `actual-recorded`. Tests exercise that serialization contract with synthetic input; those labels do **not** turn the fixture into a real model run. Never ingest or present these fixtures as actual model evidence. The optional receipt-shaped value in the projection test validates receipt binding only; it does not prove engine reconstruction.
- `synthetic-tar.ts` extracts the existing unit tests' TAR/PAX builder. Deliberate malformed members support traversal, duplicate, link, UTF-8, checksum and size-limit rejection tests.
- `synthetic-source.ts` builds the trial graph and compressed archive from the authored fixture. Archive bytes stay in memory. Only the graph and binding manifest are written to a temporary directory, removed after the tests. Real route, graph, hash, archive and fresh-authorization checks run against this fixture; only the native storage client is mocked.
- Public objective-policy tests create a fresh engine deployment with seed `PUBTEST1`. Separate short generated games exercise legal decisions, determinism, restore and policy precedence. These are actual deterministic engine executions with scripted inputs, not model runs or historical model parity evidence.
- `synthetic-catalog-openapi.json` is an independently authored minimal unit-test contract for catalog publishing. It exercises support/refusal checks, hashing, multipart allowlists, signed identity, uncertain-write recovery and the offline Core double. It is not a downloaded or inspected installation OpenAPI document and does not qualify any deployed platform. The publisher's `--self-test` runs in a temporary directory containing this schema and the permitted preset files; it makes zero network or model calls.
- Native HTTP authorization tests inject a temporary root containing explicitly synthetic process status and journal text. They verify the real `/api/process` access control without reading the private development journal. This does not establish that the deployed app has a public process journal.

## Existing permitted preset bundle

`handoff/REPLAY-preset-catalog-1/{README.md,catalog.json,manifest.json,records.jsonl,relationships.jsonl,sources.json}` is an unchanged six-file bundle of authored synthetic presets and public reference notices. Preserve its provenance and source notices. It contains 1,749 authored synthetic records and three public reference records; it is not entirely invented content.

The public snapshot does not include `trial-records.tar.gz`, historical provider traces, personal sessions or authentication material. Other existing checked-in test fixtures retain their original provenance comments; this change does not relabel those as new synthetic input.
