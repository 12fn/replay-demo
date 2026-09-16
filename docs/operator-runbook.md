# Operator runbook

## Existing private native installation

REPLAY is deployed in the `kamiwaza-harness-poc` Podman VM, namespace `kamiwaza-extensions`, native extension name `replay`, deployment `replay-server`, service port 5181. The retained claim is `replay-server-data`, backed by `/var/lib/replay-poc`. Graphiti, Neo4j and CPU embeddings are separate native services in the same workroom. The core installation is actual Kamiwaza 1.2, not a proxy-only substitute.

The existing tunnel is started with `python3 scripts/platform_tunnel.py`; it reads private SSH configuration from ignored `data/platform-tunnel.json`. It forwards the app to http://127.0.0.1:5183/ and the native core API to port17777. If the VM is stopped, start it with `podman machine start kamiwaza-harness-poc` first. Service addresses in this tunnel are specific to this installation. Do not copy its SSH identity to another machine.

Check the deployment with `podman machine ssh kamiwaza-harness-poc 'sudo k0s kubectl get pods,pvc -n kamiwaza-extensions'`. Inspect only the relevant failed workload's logs; avoid dumping Secrets or process environments.

For a reviewed source change, run `python3 scripts/run_logged.py native-build-TAG -- python3 scripts/platform/build-upgrade.py TAG`. This builds the image, saves/imports its OCI archive, calls the native extension PATCH API and waits for rollout. The script uses the current installation's normal native operator session and private binding file. It is not a universal installer. A restart deliberately disables all paid opponent/staff loops; resume them explicitly when needed.

Deployment flags are explicit: normal `build-upgrade.py TAG` targets HTTPS cookies and disables operator-file import and legacy recording access. For this existing HTTP tunnel, pass `--loopback-http`; it preserves the normal HTTPS protocol used to address native ForwardAuth while accommodating the browser tunnel. Add `--operator-file-import` only for an explicitly intended local operator preview; the sign-in screen displays that it is enabled. Add `--allow-legacy-recordings` only when the release reviewer verifies a retained legacy recording is intentionally accessible. No flag deletes a recording.

The public ingress gateway is not qualified. This demonstration uses a private loopback tunnel. An NPS deployment needs its own TLS gateway, platform account/workroom configuration and approved persistent storage.

## Another Kamiwaza 1.2 installation

1. Build the ARM64 app image or build for the destination architecture. Push/import it into an operator-approved registry/runtime. Keep the matching source archive.
2. Create a workroom and assign users with the platform's normal roles. A workroom `replay_profiles[subject]` value may tailor role/name/organization but cannot create native permissions or elevate a non-instructor native role to instructor.
3. Submit the app extension through the native extension API using `scripts/platform/deploy_poc.py` and `upgrade-replay.ts` as installation-specific examples, after replacing their local bindings. Mount a durable `/data` volume writable by uid1000.
4. Set `REPLAY_AUTH_MODE=kamiwaza`, `REPLAY_KAMIWAZA_API` ending in `/api`, `REPLAY_WORKROOM_ID`, `REPLAY_FORWARDED_HOST`, and the correct forwarded protocol/allowed origins. Use secure cookies behind HTTPS. Leave operator file import and legacy recordings disabled for a learner pilot.
5. Bind Graphiti through the normal native ontology API, deploy the CPU embedding image, and configure `REPLAY_ONTOLOGY_ID` and the exact `REPLAY_GRAPHITI_SUBJECT`. The compatibility image contains a narrowly documented fix for the supplied1.2 Graphiti embedder assignment; inspect `services/graphiti-compat/patch.py` before applying to a different release.
6. Supply inference credentials as a Secret to the app only. The Graphiti bridge validates the platform-issued workload identity; it does not share the app user's token. All extraction and app requests draw from the same ledger and total cap.
7. Qualify native login, role-specific writes, an actual ingest/search cycle and one recorded order/branch before admitting learners. A ready pod is insufficient evidence of those workflows.

## Backup and recovery

For normal instructor handoff, use Review → Download evidence bundle. It excludes native session secrets and limits content to the authorized exercise. The completed JSON includes canonical replay inputs and fingerprints; the Markdown is a readable review, not a full backup.

For service recovery, use a SQLite online backup for both `/data/replay.sqlite` and `/data/inference.sqlite`, or stop the app before copying the database and WAL files. Preserve the two ledgers together: restoring game state without the cost ledger could forget paid usage. Preserve `/data/observation-key` with the app backup: it authenticates snapshots returned with orders across restarts. Never include it in a learner export. Keep native session encryption keys and credentials in a separate access-controlled operator backup, never in the learner bundle or Git. Retained PVs are not an off-machine backup.

A restart replays recorded canonical inputs and verifies checkpoint/final fingerprints. If it reports a mismatch, retain the original database and the exact image/source version; do not delete the failing recording to make startup appear successful. Ordinary tests cover restart/idempotency and watch cursors. Full infrastructure disaster recovery remains a separate pilot gate.

## DGX Sparks

Neither Spark has been runtime-qualified in this build. Do not treat the cable as automatic pooled memory. Choose independent workloads or an explicitly supported distributed inference topology after checking the actual installed runtime, model and interconnect configuration. The current working demonstration uses the laptop's local native cluster, local CPU embeddings and the authorized external Luna route.


## Candidate0.27.0 presenter preflight

Use [the prepared case runbook](demo/ten-minute-instructor-case.md). Do all installation/one-time seed actions before presenting. The actual native flagship is attributed to its original participant; instructor workroom access should not need legacy-record access. Independently verify its row scope and recorded debrief before changing the existing installation policy. If a private HTTP browser cannot retain a session after a secure-default upgrade, use its explicit loopback flag or qualify the intended HTTPS path; do not silently disable Secure cookies globally.

New JSON note originals remain in the existing exercise database and are included in authorized JSON exports. They are not automatically published to the native catalog. The source reader for archived model trials still uses managed catalog bytes. Native parsing/vector/Graphiti-source integration and full restore remain separate qualification work.

Operator credential/token migration outside the checkout is pending coordinated operator work: current private native binding paths are shared by existing deployment tools. Do not move those files during a live release without updating and verifying their consumers. Never package them in the corresponding-source archive or instructor export.
