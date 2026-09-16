# Server model configuration contract

Configuration available in REPLAY 0.29.4. Model performance and project funding must be checked for each deployment.

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
REPLAY_MODEL_ID=gpt-5.6-sol
REPLAY_MODEL_REASONING=low
REPLAY_CHAT_REASONING=low
# OPENAI_API_KEY is supplied separately through server secret injection.
# OPENAI_PROJECT and OPENAI_ORGANIZATION are optional server-only IDs.
```

- Exactly `gpt-5.6-luna` and `gpt-5.6-sol` are priced and supported. Aliases, snapshots as requested model IDs, and other models fail before a ledger reservation or network request.
- Both efforts support `none`, `low`, `medium`, `high`, `xhigh`, `max`. Responses uses `REPLAY_MODEL_REASONING`; the native Chat continuation uses `REPLAY_CHAT_REASONING`. Explicit effort affects both provider request bodies and serialized client diagnostics.
- With no model settings, Luna remains the default, Responses effort remains `low`, and Chat effort remains `none`. Sol defaults to `low` for both. Sol's speed/quality balance and Chat tool compatibility remain provisional pending bounded live evaluation. The fixed output limits and timeouts were not increased. [Sol model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [migration guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6).
- Sponsored mode requires a nonblank explicit `OPENAI_API_KEY`. It never reads `REPLAY_KEY_FILE` or `luna.env` and never uses `REPLAY_MODEL_API_KEY`. Standard mode preserves the historical optional file fallback for backward compatibility.
- Server external configuration is bound to `https://api.openai.com/v1` (optional trailing slash). Setting an arbitrary external base URL with an ambient OpenAI key now fails. Explicitly constructed generic clients retain their existing compatible-endpoint support, but cannot send sponsored credentials or OpenAI project/organization headers there. Custom headers cannot override authorization or identity headers.
- The existing local branch remains separate: explicit private endpoint, local model and `REPLAY_MODEL_API_KEY`, Chat transport, `local-inference.sqlite`, zero external API billing. It ignores ambient OpenAI key/project/organization settings. There is no automatic fallback between providers.

## Costs and rotation

Sol uses $4/M uncached input, $0.40/M cached input, $20/M output, and a conservative 1.25× input cache-write multiplier. Luna retains $0.20/$0.02/$1.20 per million tokens. Both transports reserve and settle using the selected model. All output usage includes reasoning tokens. The enforced input limit is at most 32 KiB, well below the >272k input-token pricing threshold. Prices were checked 2026-09-16; reverify before later deployments. [Sol pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Swap the injected server key and optional IDs, then restart the server. Preserve the existing data directory, `inference.sqlite` and its WAL files: model/key changes do not reset usage or increase the $5/100-request application limits. Existing uncertain requests keep their full reservations; requests never retry automatically. A provider-reported different model is rejected and marked uncertain for reconciliation. Separate apps keep separate durable ledgers; sharing a project key does not merge or replace their caps. The account's aggregate usage remains a separate operational control.

Header values and the key are excluded from client serialization, errors and receipt metadata, including provider-echoed IDs/codes. Do not log or serialize the raw `readModelRoute` return object; it is an internal transient credential carrier consumed by the service constructor.

## Live qualification

Confirm the intended project/account and inspect the deployment’s existing ledger before activation. Qualify a bounded representative structured-output request and Chat tool continuation within the available allowance. Record requested/returned model, effort, final-answer completeness, legal tool arguments, latency, usage and receipt cost. An access check or a mocked test does not establish live performance.
