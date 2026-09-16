# Native Kamiwaza 1.2 platform adapter

`src/platform` is the only code that talks to the installed Kamiwaza platform.
It is a typed REST adapter over the OpenAPI document captured in
`evidence/platform/installed-openapi.json`. It performs no I/O at import time,
never logs, and never stores credentials.

## What a call does

Every protected method runs the same two-step sequence, once per call:

1. **Native ForwardAuth.** `GET {apiBase}/auth/forward/validate` with the
   caller's bearer token and the gateway headers for the exact target:
   `X-Forwarded-Method`, `X-Forwarded-Uri` (`/api` prefix + path + query),
   `X-Forwarded-Host` (configured host), `X-Forwarded-Proto` (configured,
   default `https`) and, when a workroom context is supplied, `X-Workroom-ID`.
2. **Target request.** Only after a 200 with signed identity. The target carries
   the original bearer token plus the signed identity headers copied unchanged.

The target is never sent when ForwardAuth denies (401/403 → `auth_denied`),
fails otherwise (`auth_error`), times out (`timeout`), or returns 200 without
`x-user-id` and `x-user-signature` (`missing_signature`).

### Forwarded header allowlist

The identity, attribute, tenant-scope and signature headers listed in `SIGNED_IDENTITY_HEADERS` are forwarded unchanged. Live qualification established that omitting email, groups, attribute hash or scope fields invalidates the signature. The initial nine-header list was incomplete; the adapter now preserves the full observed signed contract. Core fields include:

```
x-user-id, x-user-name, x-user-roles, x-workroom-id, x-user-workroom-role,
x-user-signature, x-user-signature-stable, x-user-signature-ts, x-auth-token
```

Any other `x-*` header the platform returns is dropped. The adapter never
manufactures identity, signature or workroom headers. If the platform did not
return `x-workroom-id`, the target gets none, even if the caller supplied a
workroom context: the caller's workroom is a hint to ForwardAuth, the platform
decides the signed scope, and that scope is what the target sees.

Callers cannot set `authorization`, `cookie`, `host`, `x-workroom-id` or any
`x-forwarded-*`, `x-user-*`, `x-auth-*` header. Attempting to fails with
`forged_header` before any network call.

## Caller responsibilities

The adapter is deliberately narrow. The application that uses it owns:

| Concern | Who | Notes |
| --- | --- | --- |
| **Bearer token** | Caller | `getToken()` returns the token for each call. Rotation, refresh and storage are the caller's job. The adapter keeps nothing. |
| **Login** | Caller (server only) | `login()` posts user-supplied native credentials to the auth-exempt `POST /auth/token` and returns Keycloak tokens. Hold credentials and tokens in server memory only. Do not log, persist or send them to a browser. |
| **Session vs PAT** | Caller | Workroom binding (`enterWorkroom`, `leaveWorkroom`) needs a login session token whose JWT carries a `sid` claim. A personal access token is rejected with `session_required` before any request. Other methods work with either. |
| **Re-minted tokens** | Caller | In Lite/SAML mode `EnterWorkroomResponse.access_token` is a re-minted JWT. If present, the caller must switch its token provider to it. |
| **Grants** | Platform admins | The adapter checks ReBAC decisions; it does not create grants. A denial (`allow: false`, or ForwardAuth 403) means the subject lacks the relation on the installed policy. Fix it in the platform, not in the app. |
| **Workroom context** | Caller | Pass `workroomId` (client default or per call). It is a hint only; see the allowlist section. |
| **Capability claims** | Caller / UI | `capabilities()` reports `native` only after an actual successful signed call through the instance. Present anything else as unverified. |

## Methods

All protected methods return `SignedResult<T>`:

```ts
{
  data: T,                       // typed response body
  identity: {                    // public fields from the platform's signed identity
    userId, userName, roles, workroomId, workroomRole
  },
  receipt: {
    clientRequestId, requestId,  // adapter id; platform x-request-id when present
    target: { method, path }, status, durationMs, validatedAt, signatureTs
  }
}
```

Signature values are never exposed on results or errors.

| Method | Endpoint | Notes |
| --- | --- | --- |
| `login(req)` | `POST /auth/token` | Exempt. Form body. Returns `TokenResponse`. |
| `me()` | `GET /auth/users/me` | `UserInfo`. |
| `workroom(id)` | `GET /workrooms/{id}` | `WorkroomResponse`. |
| `workroomContext(id)` | `GET /workrooms/{id}/runtime/context` | `WorkroomRuntimeContextResponse`. |
| `enterWorkroom(id, {sessionToken?})` | `POST /workrooms/{id}/enter` | Session token required. |
| `leaveWorkroom({sessionToken?})` | `POST /workrooms/leave` | Session token required. |
| `check({subject, relation, object})` | `POST /auth/check` | `relation` is limited to the installed vocabulary (`REBAC_RELATIONS`). Returns `CheckResponse`. |
| `listExtensions({workroomId?})` | `GET /extensions` | `Extension[]`. |
| `createExtension(spec)` | `POST /extensions` | 201. Persist the returned `name`. |
| `listOntologies({workroomId?})` | `GET /context/ontologies` | `OntologyInstance[]`. |
| `ontologyHealth(id)` | `GET /context/ontologies/{id}/health` | Open object per schema. |
| `contextHealth()` | `GET /context/health` | No declared schema. |
| `addKnowledge(id, req)` | `POST /context/ontologies/{id}/knowledge` | `AddKnowledgeResult`. |
| `searchOntology(id, req)` | `POST /context/ontologies/{id}/search` | `KnowledgeSearchResult` with fact source attribution. |
| `episodes(id, groupId, {lastN?})` | `GET /context/ontologies/{id}/episodes/{groupId}` | `EpisodesResult`. |
| `request(spec)` | any | Escape hatch with the same ForwardAuth and header rules. |

Responses are checked for the platform's declared required fields; anything
else fails with `malformed_response`. Open-object fields are typed as
`Record<string, unknown>` rather than guessed.

## Errors

`KamiwazaError` carries `code`, `httpStatus`, `target`, `requestId` and a short
`detail`. Codes: `invalid_config`, `invalid_request`, `forged_header`,
`missing_credentials`, `session_required`, `auth_denied`, `auth_error`,
`missing_signature`, `timeout`, `network_error`, `malformed_response`,
`http_error`.

`detail` is the platform's `detail` field after redaction of the current
token, the login password, anything shaped like `Bearer …` or a JWT, truncated
to 240 characters. Headers and raw bodies are never attached. The error's
`cause` is not attached either, since transport errors can echo the token.

## Configuration

```ts
new KamiwazaClient({
  apiBase: "https://kamiwaza.example/api", // must end in /api
  getToken: () => sessionStore.token(),      // caller-owned
  fetchImpl,                                 // optional; tests inject a mock
  timeoutMs: 15_000,                         // one budget for validate + target
  forwardedHost: "kamiwaza.example",         // default: host of apiBase
  forwardedProto: "https",                   // default
  workroomId: "…",                           // default X-Workroom-ID hint
});
```

## Tests

`tests/platform` runs with a mocked fetch and no network:
forged header rejection, target not sent on denial or missing signature,
immutable signed workroom scope, allowlist enforcement, malformed responses,
timeouts across both hops, secret redaction in every error path, PAT rejection
for workroom binding, exact request shapes for each method, and capability
labels flipping to `native` only on success.

## Not verified here

No call in this directory has been made against the live installation. Main
qualifies the adapter against the installed platform and records the evidence.
Open points for that pass:

- Whether ForwardAuth returns `x-user-signature-ts` on every 200 (treated as optional here).
- Whether `x-auth-token` should remain in the forwarded set. It is forwarded
  because the gateway forwards it; trim `SIGNED_IDENTITY_HEADERS` if live
  qualification shows the target does not need it.
- The exact role separator in `x-user-roles` (assumed comma-separated for the
  public `identity.roles`; the raw header is forwarded unchanged regardless).
