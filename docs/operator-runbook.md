# REPLAY operator runbook

## Native deployment

The current demonstration runs on an ARM64 Spark with Kamiwaza 1.2 and Kubernetes. Its app container uses Node 24.5.0 and pnpm 10.17.1. The Dockerfile listens on port 5181 and stores mutable state in `/data`; mount a persistent volume writable by uid 1000. The successful saved debrief used an external API model. Application placement on a Spark does not establish local GPU inference or distributed model execution.

Build a reviewed Git revision and keep its image, `replay-build.json`, and corresponding-source archive together. Run `python3 scripts/verify-corresponding-source.py --revision HEAD` after building to verify every archive member against the commit. Use the native extension API/operator to deploy the image and preserve the existing volume. Scripts under `scripts/platform/` retain examples from an earlier laptop installation; their private bindings must be supplied and reviewed for the target installation. They are not universal Spark installers.

## Kamiwaza sign-in

The installed native extension CRD uses **`spec.kamiwaza.useAuth: "true"`**; the extension-creation API spells this `kamiwaza.use_auth`. Confirm the installed schema when using a different platform version. The native `/runtime/apps/replay` route then gates entry with Kamiwaza authentication. Enable REPLAY's native SSO handoff so users do not get a second app password form.

| Server setting | Configuration |
| --- | --- |
| `REPLAY_AUTH_MODE` | `kamiwaza` |
| `REPLAY_PLATFORM_SSO` | `true` |
| `REPLAY_KAMIWAZA_API` | Trusted native API base ending in `/api` |
| `REPLAY_KAMIWAZA_VALIDATION_API` | Optional separately routed trusted identity-validation API |
| `REPLAY_WORKROOM_ID` | Existing authorized workroom |
| `REPLAY_FORWARDED_HOST` | Canonical native platform hostname used for ForwardAuth |
| `REPLAY_FORWARDED_PROTO` | `https` |
| `REPLAY_COOKIE_SECURE` | `true` |
| `REPLAY_PUBLIC_ORIGIN` | Exact HTTPS origin of this app |
| `REPLAY_LOGIN_ORIGIN` | Exact HTTPS origin serving native Kamiwaza sign-in |
| `REPLAY_ALLOWED_ORIGINS` | Explicit origins including the public and login origins |
| `REPLAY_OPERATOR_FILE_IMPORT` | Leave disabled for normal deployment |
| `REPLAY_ALLOW_LEGACY_RECORDINGS` | Leave disabled unless retained records have been independently scoped |

Keep the native validation hostname separate from the browser-facing login hostname. Use trusted TLS with the installation's CA; never disable certificate verification to make an ingress work. A public proxy must preserve native authentication, forward only the necessary app and sign-in routes, reject unrelated administration/model APIs, and strip caller-supplied identity headers. Do not expose the container port directly.

Assign native workroom permissions before applying synthetic app personas. A `replay_profiles[subject]` entry may tailor the name, organization and allowed app role; it cannot grant native membership or elevate a user to native instructor access. A demo account that creates a practice needs the relevant native write permission. Verify each role with its intended workflow and another user's exercise.

## Switch user

The native account menu offers **Switch user** with confirmation. Confirming removes the protected workspace, signs out the app, persists refusal of the previously verified token, expires known platform cookies, and requests native logout before opening the fixed native sign-in route. Cancel preserves the current selection. No client-supplied username, redirect or password is accepted by this action.

Native logout in the tested installation ended refresh reuse but did not immediately invalidate an already issued access JWT at Core. REPLAY therefore persists only a SHA-256 fingerprint of the exact switched-out token in its existing database and refuses it for cookie and native bearer access. It does not claim platform-wide immediate JWT revocation. An unverified token cannot fill this refusal store. A failed native termination leaves the user signed out with an explicit sign-in recovery action.

After any token has been refused, rolling the app back to a version without this guard could reopen access for that token. Keep traffic closed while repairing that failure, or use a release that preserves the guard. Do not restore an old database over new session refusals, records or usage.

## Model configuration and records

Use [server model configuration](model-configuration.md) for external credentials, project binding, model/effort settings and local routing. Inject secrets on the server. Each deployment retains its own request/cost ledger across model changes and restarts. There is no automatic provider fallback or retry.

For instructor handoff, use the authorized review export. The JSON carries replay inputs and source fingerprints; Markdown provides a readable review. Neither is a service backup.

For recovery, use SQLite online backups or stop the app before copying databases and their WAL files. Preserve `/data/replay.sqlite`, `/data/inference.sqlite`, `/data/local-inference.sqlite` when present, and `/data/observation-key`. Keep session encryption keys and provider credentials in a separate access-controlled operator backup. Do not publish runtime databases, browser sessions, credentials or raw provider traces in Git or the source archive.

## Deployment qualification

Before admitting learners, verify all of the following against the actual deployed image:

- Anonymous entry reaches native sign-in; there is no REPLAY password form in SSO mode.
- Login establishes the expected workroom/persona and only authorized exercise access.
- Confirmed switching reaches native sign-in, accepts a different user, and rejects old REPLAY session/token reuse across a restart.
- Wrong-origin requests, caller-supplied identity headers and unauthorized cross-user reads/writes fail.
- The prepared case opens, its evidence retrieval follows real source relationships, and an export contains the expected scoped record.
- The source archive hash matches the served build metadata and reviewed Git commit.
- Model requests remain off until a bounded, authorized qualification under the existing ledger; saved analysis stays labeled as saved.

A healthy pod or a successful model-list request alone does not qualify those user workflows. Broader game import, phone capture, tabletop reconstruction and measured learning outcomes remain separate work.
