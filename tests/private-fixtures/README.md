# Separately retained private recorded-input regressions

These test sources contain no private fixtures. They preserve historical regression expectations that cannot honestly be replaced by fabricated historical evidence:

- `catalog-projection.test.ts`: original 17-round recorded trial, provider-format swap and its exact mechanical outcome counts.
- `catalog-source-archive.test.ts`: exact original archive hash and selected historical member hashes/lengths.
- `objective-frontier-experiment.test.ts`: original saved policy states, recorded orders and full-game parity. This retained suite also repeats its original purity/determinism checks.
- `frontier-deployment-variants.test.ts`: original 32-game receipt and orchestration's fixed historical harness prerequisite. This retained suite also repeats original geometry/determinism checks.
- `dual-model-saved-input.test.ts`: original six-round config and byte-for-byte rebuild of three saved no-flag games. These checks now fail if inputs are missing, instead of silently returning or omitting missing games.

Run only in an authorized private environment with the separately retained complete original checkout:

```sh
REPLAY_PRIVATE_FIXTURE_ROOT=/absolute/path/to/private-checkout \
  pnpm exec vitest run --config tests/private-fixtures/vitest.config.ts --maxWorkers=2
```

The config requires an explicit absolute fixture root; missing files are failures. Do not copy the private evidence or raw trial archive into the public tree. This opt-in suite is excluded from the default public suite, was not executed for the public qualification, and is not included in its passed count. Setting this variable alone does not enable it; the explicit config is required. TypeScript checks these test sources as part of the normal typecheck.
