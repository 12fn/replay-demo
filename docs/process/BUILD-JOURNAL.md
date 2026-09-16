# Public release journal

This is a curated public release summary. Private development logs, operator identities, credentials, participant records and provider sessions are excluded.

## 0.29.5 candidate

Add an explicit unlimited application allowance only for an external sponsored server credential with a validated project setting. Keep all existing receipt history, reservations, uncertain outcomes, local accounting and per-request/task limits. UI allowance fields use the explicit string `unlimited`, display Unlimited beside usage totals, and omit an inapplicable spend meter. Restart continues to pause paid opponent and staff loops. Tomo's displayed external model label is Connected model; technical identifiers and receipts are unchanged.

The allowance implementation passed 2,075 tests in 146 files and TypeScript, using only synthetic credentials and offline model fixtures. The first focused run caught two new presentation expectations that incorrectly assumed three currency decimals; corrected to the existing two-decimal format. The final neutral Tomo label and documentation are qualified separately. Native rollout and live model performance remain separate deployment checks; this candidate made no inference calls or credential reads.

## 0.29.3

Preserve the selected review panel across a verified native session recovery. Authorization refusal still removes the protected interface. Selection recovery is scoped to the same identity, workroom, role and exercise; a change of scope resets it.

Validation: 272 focused tests, typecheck, production build, browser harness checks and a real native cookie-handoff check passed. The native records and inference ledgers were unchanged by this release.

## Clean public source preparation

Preserve the working application and upstream notices while replacing private test-data dependencies with synthetic fixtures. Keep private historical comparisons in an explicitly separate suite. Public qualification passed 1,950 tests across 137 files with no failures, skips or todo tests, plus TypeScript. Five private historical test files remain explicitly separate and unexecuted. Source packaging and the matching archive are verified separately.
