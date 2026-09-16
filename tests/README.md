# Public and private test scopes

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test --maxWorkers=2
pnpm typecheck
```

The default suite runs public source, unit, security, deterministic engine, archive, ontology, and client tests. Synthetic replacements and their limits are documented in [fixtures/README.md](fixtures/README.md). Historical file absence no longer silently counts as a passing test.

`tests/private-fixtures/**` is the only additional default exclusion. It preserves exact historical recorded-input regression tests separately; those artifacts are intentionally absent from this public repository. Exclusion is not a passing or skipped-test result. The earlier private 1,954-test qualification is a separate historical receipt and must not be described as this public suite's result.

See [private-fixtures/README.md](private-fixtures/README.md) for the explicit private-only invocation. No model, paid API, or external deployment is needed by the public test suite; some route tests open local loopback servers.
