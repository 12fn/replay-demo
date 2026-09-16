# Server model configuration contract

Configuration available in REPLAY 0.29.5. Model performance and project funding must be checked for each deployment.

## Shared server secret interface

Applications can consume the same secret-injection contract, while retaining their own durable usage ledgers:

| Server setting | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | Secret injected by the server's secret manager. Never a browser setting, client request field, public bundle, or committed file. |
| `OPENAI_PROJECT` | Optional `proj_` ID, followed by 1–120 ASCII letters, digits, underscores or hyphens. Sent only as `OpenAI-Project`. |
| `OPENAI_ORGANIZATION` | Optional `org-` ID with the same suffix character rules. Sent only as `OpenAI-Organization`. |

A project-scoped key may not require the optional headers. Successful authentication, model-list access and these headers do not establish who funds usage. Confirm the intended project/account separately before activation. [OpenAI authentication documentation](https://developers.openai.com/api/reference/overview).

## REPLAY settings

```dotenv
REPLAY_MODEL_BILLING=external
REPLAY_MODEL_TRANSPORT=responses
REPLAY_MODEL_CREDENTIAL_MODE=sponsored
REPLAY_MODEL_ALLOWANCE=capped
REPLAY_MODEL_ID=gpt-5.6-sol
REPLAY_MODEL_REASONING=low
REPLAY_CHAT_REASONING=low
# OPENAI_API_KEY is supplied separately through server secret injection.
# OPENAI_PROJECT and OPENAI_ORGANIZATION are optional server-only IDs.
```

- Exactly `gpt-5.6-luna` and `gpt-5.6-sol` are priced and supported. Aliases, snapshots as requested model IDs, and other models fail before a ledger reservation or network request.
- Both efforts support `none`, `low`, `medium`, `high`, `xhigh`, `max`. Responses uses `REPLAY_MODEL_REASONING`; the native Chat continuation uses `REPLAY_CHAT_REASONING`. Explicit effort affects both provider request bodies and serialized client diagnostics.
- With no model settings, Luna remains the default, Responses effort remains `low`, and Chat effort remains `none`. Sol defaults to `low` for both. Sol's speed/quality balance and Chat tool compatibility remain provisional pending bounded live evaluation. Output and input bounds remain unchanged. [Sol model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [migration guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6).
- External Sol has a fixed 60-second deadline per Responses or Chat request, including response-body reading. Luna retains 25 seconds and the explicit local route retains 120 seconds. This observation window is not a provider latency guarantee. A timeout aborts the local fetch, keeps its full reservation as uncertain spend, and never triggers an automatic retry; it does not prove the provider cancelled generation or incurred no charge. Leaving the browser view also does not cancel provider work. Preserve old uncertain receipts when changing this policy, and reconcile them only against actual provider evidence. Keep every proxy/request lifetime above its enclosed model deadline; the native Tomo model route retains its 90-second lifetime and separate cumulative request bound.
- Sponsored mode requires a nonblank explicit `OPENAI_API_KEY`. It never reads `REPLAY_KEY_FILE` or `luna.env` and never uses `REPLAY_MODEL_API_KEY`. Standard mode preserves the historical optional file fallback for backward compatibility.
- Server external configuration is bound to `https://api.openai.com/v1` (optional trailing slash). Setting an arbitrary external base URL with an ambient OpenAI key now fails. Explicitly constructed generic clients retain their existing compatible-endpoint support, but cannot send sponsored credentials or OpenAI project/organization headers there. Custom headers cannot override authorization or identity headers.
- The existing local branch remains separate: explicit private endpoint, local model and `REPLAY_MODEL_API_KEY`, Chat transport, `local-inference.sqlite`, zero external API billing. It ignores ambient OpenAI key/project/organization settings. There is no automatic fallback between providers.

## Costs and rotation

Sol uses $4/M uncached input, $0.40/M cached input, $20/M output, and a conservative 1.25× input cache-write multiplier. Luna retains $0.20/$0.02/$1.20 per million tokens. Both transports reserve and settle using the selected model. All output usage includes reasoning tokens. The enforced input limit is at most 32 KiB, well below the >272k input-token pricing threshold. Prices were checked 2026-09-16; reverify before later deployments. [Sol pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Swap the injected server key and optional IDs, then restart the server. Preserve the existing data directory, `inference.sqlite` and its WAL files: model/key changes do not reset usage or change the default $5/100-request application limits. Existing uncertain requests keep their full reservations; requests never retry automatically. A provider-reported different model is rejected and marked uncertain for reconciliation. Separate apps keep separate durable ledgers; sharing a project key does not merge their accounting. The account's aggregate usage remains a separate operational control.

### Explicit unlimited sponsored allowance

`REPLAY_MODEL_ALLOWANCE` accepts exactly `capped` (the default) or `unlimited`. Unlimited removes only the application's cumulative request and dollar caps. It requires the external OpenAI route, `REPLAY_MODEL_CREDENTIAL_MODE=sponsored`, a nonblank explicit server `OPENAI_API_KEY`, and an explicit validated `OPENAI_PROJECT`. The deployment must bind the intended sponsored Secret and project before enabling it. Local or standard credential modes, missing credentials/project, and unsupported allowance values fail during configuration, before requests or ledger reservations. There is no credential-file fallback for sponsored mode.

The same `inference.sqlite` retains all earlier completed, failed, reserved and uncertain receipts. Local history remains separately stored in `local-inference.sqlite`; the local route keeps its default 100-request, zero-external-dollar allowance. Returning to capped mode preserves history and refuses new reservations if the retained usage already reaches either cap.

JSON summaries use the literal string `"unlimited"` for `maxRequests`, `maxUsd`, and full-ledger `maxMicro`, `remainingRequests`, and `remainingMicro`. They report `allowance: "unlimited"`; actual usage counts and committed/reserved/uncertain costs remain finite numeric totals. The UI displays **Unlimited** and those totals, without a percentage meter for an absent cap.

This is an application allowance, not a claim of unlimited provider credits or rate limits. Per-request input/output bounds and timeouts, per-task tool/completion limits, bridge-specific limits and native authority checks remain enforced. Calls never retry automatically. Paid opponent and staff loops remain off after restart until explicitly enabled; selecting unlimited does not start them. Sol with low reasoning remains the selected deployment route when the settings above are used.

Header values and the key are excluded from client serialization, errors and receipt metadata, including provider-echoed IDs/codes. Do not log or serialize the raw `readModelRoute` return object; it is an internal transient credential carrier consumed by the service constructor.

## Live qualification

Confirm the intended project/account and inspect the deployment’s existing ledger before activation. Qualify a bounded representative structured-output request and Chat tool continuation within the available allowance. Record requested/returned model, effort, final-answer completeness, legal tool arguments, latency, usage and receipt cost. An access check or a mocked test does not establish live performance.
