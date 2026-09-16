"""Prepare the reviewed, offline release-1.2.0 Tomo chat floor. Never deploy.

This deliberately accepts ONE supplied catalog, not arbitrary Compose. It reads
neither the process environment nor .env, and never imports image application code.
Run through scripts/run_logged.py; see docs/process/tomo-runtime-preparation.md.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit, urlunsplit

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parents[2]
NAME = "replay-tomo"
NAMESPACE = "kamiwaza-extensions"
WORKROOM = "280d6347-c0f5-4123-8dd4-93a53c3045e5"
PRIVATE_SECRET = "replay-tomo-private"
CATALOG_GLOB = "**/kamiwaza-extensions-tomo/registry/garden/v3/apps.json"
CATALOG_SHA = "a82101c11afd46115f4ac486bb6925a67eaa29d889075278eccaa6c652b43b36"
COMPOSE_SHA = "65b711a97991cae7604e78db24d52d1b89f78823e98f03ea687ba650f29d23cb"
FLOOR = ("postgres", "valkey", "seaweedfs", "api-backend", "frontend",
         "agent-runtime", "sandbox-controller")
ALL_SERVICES = (*FLOOR, "background-worker", "document-worker", "document-extractor",
                "package-tool-runner", "sandbox-worker", "sandbox-egress-proxy")
SOURCE_PINS = {
    "evidence/platform/tomo-runtime-images-1.2.0.json":
        "f04b77b34ba56fdc4d9edfe9cc4ffc825dc45127eff45a7232526c4492766c1e",
    "evidence/platform/tomo-runtime-image-import-1.2.0.json":
        "5897b896a3255b45d707cd504afda9f88cf73e6cc29d5ce2e4a94410657e636d",
    "evidence/platform/installed-openapi.json":
        "b2c7ba39d0b6a6e8aa4a8b2817ed92b32ee5f7d71da9598da529217416fb6af9",
    "data/platform/tomo-image/source/wheel/kaizen/config.py":
        "8fa6e3ee2d6a9ad1d3b063edef55f5ada6884c64fbf769d40aad18ffe55f5936",
    "data/platform/tomo-image/source/wheel/kaizen/main.py":
        "867528996443f5560cf1f48f0f38d4de98ad885b5182fdbe9684275881ddc9b2",
    "data/platform/tomo-image/source/helper/kamiwaza_extensions_lib/config.py":
        "1252a55a56588a930945e952fb28e8c0c3144dd485a8ecad31b46041d294cfc9",
    "data/platform/tomo-image/source/helper/kamiwaza_extensions_lib/local_dev.py":
        "f1ed45336cb802d5aa49eb900019a9dc3cdd8924926c1bc5678ebfe6d93d7726",
    "data/platform/operator/extracted/extension-operator-1.0.0/chart/crds/"
    "extensions.kamiwaza.io_kamiwazaextensions.yaml":
        "dc3289460bc0f0100cb0df7b927e35adab613ed2f548d734d50d2e6d14d1ac23",
}
# These would introduce local user or unattended workload credentials. Do not
# even create Secret references for them; identity must come from native requests.
OMIT_ENV = frozenset({
    "KZ_EXT_DEV_LOCAL_AUTH", "KAMIWAZA_BEARER_TOKEN", "KAMIWAZA_DEV_WORKROOM_ID",
    "KAMIWAZA_SERVICE_CLIENT_ID", "KAMIWAZA_SERVICE_CLIENT_SECRET",
    "KAMIWAZA_SERVICE_TOKEN_ENDPOINT",
})
# Explicit audited set, including credential-bearing URLs and OTLP headers.
# Names, not secret values, are the shared Secret keys across services.
SECRET_ENV = frozenset({
    "POSTGRES_PASSWORD", "RETENTION_PASSWORD", "KAIZEN_APP_PASSWORD",
    "DATABASE_URL", "SECRET_ENCRYPTION_KEY", "SEAWEEDFS_S3_ACCESS_KEY",
    "SEAWEEDFS_S3_SECRET_KEY", "PI_SIDECAR_TOKEN", "SANDBOX_WORKER_TOKEN",
    "PKG_RUNNER_TOKEN", "SLACK_BOT_TOKEN", "LINEAR_WEBHOOK_SECRET",
    "KAIZEN_CAPABILITY_SIGNING_KEY", "KAIZEN_A2A_SHARED_SECRET",
    "SANDBOX_EGRESS_SIGNING_KEY", "OTEL_EXPORTER_OTLP_HEADERS",
})
API_OVERRIDES = {
    "KAMIWAZA_USE_AUTH": "true",
    "LLM_ASSIST_ENABLED": "false",
    "TASKS_ENABLED": "false",
    "TASKS_BACKGROUND_AUTH_MODE": "core",
    "DOCUMENT_IMPORT_ENABLED": "false",
    "DOCUMENT_EXPORT_ENABLED": "false",
    "DOCUMENT_WORKER_SEPARATE_QUEUE_ENABLED": "false",
    # False starts the legacy in-process scheduler (inspected kaizen/main.py).
    "WORKER_QUEUE_ENABLED": "true",
    "SANDBOX_ENABLED": "false",
    "ARTIFACT_RUN_ENABLED": "false",
    "AGENT_PACKAGES_ENABLED": "false",
    "SANDBOX_WARM_POOL_MIN": "0",
    "SANDBOX_POOL_TARGET_IDLE": "0",
    "SANDBOX_EGRESS_ENABLED": "false",
    **{f"KAIZEN_A2A_{suffix}_ENABLED": "false"
       for suffix in ("POC", "DISCOVERY", "INBOUND", "OUTBOUND", "SEND")},
}
SERVICE_KEYS = frozenset({
    "logging", "restart", "image", "x-kamiwaza", "shm_size", "environment",
    "ports", "healthcheck", "volumes", "deploy", "command", "entrypoint",
    "security_opt", "depends_on", "env_file", "read_only", "cap_drop",
})
NATIVE_KEYS = frozenset({"persistence", "containerSecurityContext", "healthCheck",
                         "automountServiceAccountToken", "primary"})
MOUNTS = {
    # Core reserves tmp/data for operator injection (not expressed in OpenAPI).
    "postgres": [("pg-run", "/var/run/postgresql", {}),
                 ("pg-shm", "/dev/shm", {"medium": "Memory", "sizeLimit": "2Gi"})],
    "valkey": [("valkey-data", "/data", {})],
    "seaweedfs": [],
    "api-backend": [("agent-packages", "/var/lib/tomo/packages", {})],
    "frontend": [],
    "agent-runtime": [],
    "sandbox-controller": [],
}
CORE_VOLUME_CONTRACT = {
    "rejectedCreateRequest": "a9e6d8eb-5bbe-422f-8a58-1c075934314f",
    "status": 422,
    "reservedNames": ["tmp", "data"],
    "operatorInjectedTmp": {"name": "tmp", "mountPath": "/tmp"},
    "inspectedInstalledModule": "kamiwaza/serving/garden/extensions/service_volumes.c",
    "installedModuleSHA256": "a13fb7a43c382c9e74b396bae28fbf30c3c9442acfa9f291a5650ba931cccf6e",
    "scope": "Static installed Core validator inspection; not successful create or Tomo readiness",
}


class PreparationError(ValueError):
    """An input is outside the inspected contract; messages contain no values."""


def require(condition, message):
    if not condition:
        raise PreparationError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode()


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        require(key not in obj, "Duplicate JSON key")
        obj[key] = value
    return obj


def read_pinned(path, expected):
    try:
        data = path.read_bytes()
    except OSError:
        raise PreparationError("Required inspected input unavailable") from None
    require(sha(data) == expected, "Inspected input SHA256 changed; review required")
    return data


def default_value(value):
    """Resolve only literal/default Compose expressions, including nested :-.

    No environment lookup, shell execution, required variables, escape expansion,
    alternate operators or bare $NAME. Errors intentionally omit input values.
    Secret expressions are separately replaced without evaluating their defaults.
    """
    require(isinstance(value, str), "Expected a string environment value")
    out, i = [], 0
    while i < len(value):
        if value[i] != "$":
            out.append(value[i])
            i += 1
            continue
        require(value.startswith("${", i), "Unsupported interpolation")
        depth, end = 1, i + 2
        while end < len(value) and depth:
            if value.startswith("${", end):
                depth += 1
                end += 2
            else:
                if value[end] == "}":
                    depth -= 1
                end += 1
        require(depth == 0, "Unclosed interpolation")
        expression = value[i + 2:end - 1]
        match = re.fullmatch(r"[A-Z][A-Z0-9_]*:-(.*)", expression, re.S)
        require(match is not None, "Unresolved or unsupported interpolation")
        out.append(default_value(match[1]))
        i = end
    return "".join(out)


def scoped_url(value):
    """Rewrite only parsed sibling URL hosts; never replace substrings in paths."""
    if "://" not in value:
        return value
    try:
        u = urlsplit(value)
        require(not u.username and not u.password, "Credential URL must be a Secret reference")
        if u.hostname in ALL_SERVICES:
            host = f"{NAME}-{u.hostname}"
            if u.port is not None:
                host += f":{u.port}"
            return urlunsplit((u.scheme, host, u.path, u.query, u.fragment))
    except ValueError:
        raise PreparationError("Unsupported URL shape") from None
    return value


def seconds(value):
    m = re.fullmatch(r"([1-9][0-9]*)(s|m)", value)
    require(m is not None, "Unsupported probe duration")
    return int(m[1]) * (60 if m[2] == "m" else 1)


def resources(compose):
    require(set(compose) == {"limits", "reservations"}, "Unexpected resource groups")
    result = {}
    for source, target in (("limits", "limits"), ("reservations", "requests")):
        group = compose[source]
        require(set(group) == {"cpus", "memory"}, "Unexpected resource names")
        require(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", group["cpus"]) is not None,
                "Unexpected CPU quantity")
        memory = re.fullmatch(r"([1-9][0-9]*)(M|G)", group["memory"])
        require(memory is not None, "Unexpected Compose memory quantity")
        # Docker RAM quantities use powers of 1024; K8s M/G are decimal.
        result[target] = {"cpu": group["cpus"], "memory": memory[1] + memory[2] + "i"}
    return result


def health(service, catalog_override):
    result = {}
    if "healthcheck" in service:
        check = service["healthcheck"]
        require(set(check) <= {"test", "interval", "timeout", "retries", "start_period"},
                "Unexpected Compose healthcheck fields")
        test = check["test"]
        require(isinstance(test, list) and len(test) >= 2
                and all(isinstance(x, str) for x in test), "Unexpected probe command")
        if test[0] == "CMD":
            result["exec"] = {"command": test[1:]}
        elif test[0] == "CMD-SHELL" and len(test) == 2:
            result["exec"] = {"command": ["/bin/sh", "-c", test[1]]}
        else:
            raise PreparationError("Unsupported probe command")
        for old, new in (("interval", "periodSeconds"), ("timeout", "timeoutSeconds"),
                         ("start_period", "startPeriod")):
            if old in check:
                result[new] = seconds(check[old])
        if "retries" in check:
            result["failureThreshold"] = check["retries"]
    for override in (catalog_override, service.get("x-kamiwaza", {}).get("healthCheck", {})):
        if any(k in override for k in ("exec", "httpGet", "tcpSocket")):
            for key in ("exec", "httpGet", "tcpSocket"):
                result.pop(key, None)
        result.update(copy.deepcopy(override))
    require(sum(k in result for k in ("exec", "httpGet", "tcpSocket")) == 1,
            "Exactly one health action is required")
    return result


def environment(name, compose_env, deltas):
    overrides = API_OVERRIDES if name == "api-backend" else {}
    env = {}
    for key, raw in sorted(compose_env.items()):
        require(re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is not None, "Unexpected env name")
        if key in OMIT_ENV:
            deltas.append({"service": name, "env": key, "action": "omit_identity_fallback"})
            continue
        if key in SECRET_ENV:
            env[key] = {"name": key, "valueFrom": {"secretKeyRef": {
                "name": PRIVATE_SECRET, "key": key}}}
            deltas.append({"service": name, "env": key, "action": "secret_reference",
                           "sourceValue": "[REDACTED]"})
            continue
        require(not re.search(r"(?:PASSWORD|SECRET|TOKEN$|API_KEY|SIGNING_KEY)", key),
                "Unclassified credential environment variable")
        resolved = default_value(raw)
        value = overrides.get(key, scoped_url(resolved))
        env[key] = {"name": key, "value": value}
        if value != resolved:
            deltas.append({"service": name, "env": key,
                           "action": "boot_override" if key in overrides else "scope_sibling_url",
                           "value": value})
    for key, value in overrides.items():
        if key not in env:
            env[key] = {"name": key, "value": value}
            deltas.append({"service": name, "env": key, "action": "inspected_config_override",
                           "value": value})
    # The web image refuses an empty app path. Match the operator-native path,
    # including when ingress is disabled for main's private bootstrap review.
    if name in ("frontend", "api-backend"):
        key = "KAMIWAZA_APP_PATH"
        env[key] = {"name": key, "value": f"/runtime/apps/{NAME}"}
        deltas.append({"service": name, "env": key, "action": "explicit_native_app_path",
                       "value": env[key]["value"]})
    return [env[key] for key in sorted(env)]


def validate_volume_contract(service):
    """Enforce the inspected Core rules missing from OpenAPI and operator CRD.

    Also refuse an aliased explicit /tmp mount, which would collide with operator
    injection even without using a reserved name. No existing-claim fallback.
    """
    volumes = service.get("volumes") or []
    mounts = service.get("volumeMounts") or []
    names = [v.get("name") for v in volumes]
    require(all(isinstance(n, str) and n for n in names), "Missing volume name")
    require(len(names) == len(set(names)), "Duplicate volume name")
    require(not set(names) & {"tmp", "data"}, "Operator-reserved volume name")
    persistence = service.get("persistence") or {}
    pvc_path = (persistence.get("mountPath", "").rstrip("/")
                if persistence.get("enabled") is True else "")
    paths = set()
    for mount in mounts:
        name, path = mount.get("name"), mount.get("mountPath")
        require(name not in {"tmp", "data"}, "Operator-reserved volumeMount name")
        require(name in names, "Volume mount has no declared backing volume")
        require(isinstance(path, str) and path.startswith("/"), "Mount path must be absolute")
        path = path.rstrip("/")
        require(path != "/tmp", "Mount collides with operator-injected /tmp")
        require(not pvc_path or path != pvc_path, "Mount collides with operator persistence path")
        require(path not in paths, "Duplicate volume mount path")
        paths.add(path)


def validate_spec(spec, openapi):
    """Validate Core's actual schema, tightening named objects against typos.

    Core declares env/probe/volume payloads as free-form dicts. The generator
    constructs those explicitly; the installed CRD also validates their K8s shape.
    """
    schema = copy.deepcopy(openapi["components"]["schemas"])
    for name in ("CreateExtension", "ExtensionServiceSpec", "ExtensionPort",
                 "SandboxSpec", "KamiwazaIntegrationSpec", "NetworkingSpec",
                 "NetworkPolicySpec", "ResourceSpec", "SecuritySpec"):
        schema[name]["additionalProperties"] = False
    document = {"$ref": "#/components/schemas/CreateExtension", "components": {"schemas": schema}}
    errors = list(jsonschema.Draft202012Validator(document).iter_errors(spec))
    require(not errors, "Generated request does not match installed CreateExtension schema")
    for service in spec["services"]:
        validate_volume_contract(service)


def generate(root=ROOT):
    root = Path(root)
    catalogs = sorted((root / "data/platform/tomo-catalog").glob(CATALOG_GLOB))
    require(len(catalogs) == 1, "Expected exactly one supplied Tomo catalog")
    catalog_bytes = read_pinned(catalogs[0], CATALOG_SHA)
    evidence = {path: read_pinned(root / path, digest) for path, digest in SOURCE_PINS.items()}
    try:
        apps = json.loads(catalog_bytes, object_pairs_hook=unique_object)
        require(isinstance(apps, list) and len(apps) == 1, "Unexpected catalog app set")
        app = apps[0]
        require(app["name"] == "kaizen-next" and app["version"] == "0.4.1",
                "Unexpected catalog identity")
        require(sha(app["compose_yml"].encode()) == COMPOSE_SHA, "Compose SHA256 changed")
        compose = yaml.safe_load(app["compose_yml"])
        openapi = json.loads(evidence["evidence/platform/installed-openapi.json"])
    except (KeyError, TypeError, json.JSONDecodeError, yaml.YAMLError):
        raise PreparationError("Unexpected catalog or schema shape") from None
    require(set(compose["services"]) == set(ALL_SERVICES), "Expected exact thirteen-service catalog")
    deltas = []
    services = []
    for name in FLOOR:
        source = compose["services"][name]
        require(set(source) <= SERVICE_KEYS, "Unexpected Compose service fields")
        native = source.get("x-kamiwaza", {})
        require(set(native) <= NATIVE_KEYS, "Unexpected native Compose fields")
        require(source["image"].endswith(":release-1.2.0")
                and source["image"] in app["docker_images"], "Unpinned service image")
        require(all(isinstance(p, str) and p.isdigit() for p in source["ports"]),
                "Only the inspected internal port form is supported")
        require(source.get("env_file", ".env") == ".env", "Unexpected env_file")
        # Resolve ignored restart interpolation too; never allow hidden unresolved input.
        require(default_value(source["restart"]) == "unless-stopped", "Unexpected restart policy")
        security = copy.deepcopy(native["containerSecurityContext"])
        if "read_only" in source:
            security["readOnlyRootFilesystem"] = source["read_only"]
        if "security_opt" in source:
            require(source["security_opt"] == ["no-new-privileges:true"], "Unexpected security options")
            security["allowPrivilegeEscalation"] = False
        if "cap_drop" in source:
            security.setdefault("capabilities", {})["drop"] = source["cap_drop"]
        service = {
            "name": name, "image": source["image"], "replicas": 1,
            "primary": native.get("primary", False),
            "ports": [{"container_port": int(p), "protocol": "TCP"} for p in source["ports"]],
            "env": environment(name, source.get("environment", {}), deltas),
            "resources": resources(source["deploy"]["resources"]),
            "containerSecurityContext": security,
            "automountServiceAccountToken": native.get("automountServiceAccountToken", False),
            "healthCheck": health(source, app["services"].get(name, {}).get("healthCheck", {})),
            "volumes": [{"name": key, "emptyDir": opts} for key, _, opts in MOUNTS[name]],
            "volumeMounts": [{"name": key, "mountPath": path} for key, path, _ in MOUNTS[name]],
        }
        # Compose command overrides image CMD, not ENTRYPOINT. Critical for Valkey.
        for old, new in (("entrypoint", "command"), ("command", "args")):
            if old in source:
                require(isinstance(source[old], list)
                        and all(isinstance(x, str) for x in source[old]), "Unsupported command form")
                service[new] = [default_value(x) for x in source[old]]
        if "persistence" in native:
            service["persistence"] = {**native["persistence"], "size": "4Gi",
                                      "storageClass": "replay-local"}
            deltas.append({"service": name, "action": "external_volume_binding_required",
                           "catalogSize": native["persistence"]["size"], "size": "4Gi",
                           "mountPath": native["persistence"]["mountPath"],
                           "storageClass": "replay-local"})
        deltas.append({"service": name, "action": "explicit_ephemeral_mounts",
                       "mounts": copy.deepcopy(service["volumeMounts"])})
        services.append(service)
    controller_env = {e["name"]: e["value"] for e in services[-1]["env"]}
    spec = {
        "name": NAME, "type": app["type"], "version": app["version"],
        "workroom_id": WORKROOM, "services": services,
        "kamiwaza": {"namespace": "kamiwaza", "api_url": "http://core-api.kamiwaza.svc:7777/api",
                     "public_api_url": "https://kamiwaza-harness.localhost", "use_auth": "true"},
        "networking": {"ingress_enabled": False, "path_prefix": f"/runtime/apps/{NAME}",
                       "network_policy": {"enabled": True}},
        # Provision controller namespace/RBAC even though application coding is off.
        # Core uses snake_case here; the CRD uses serviceName / imageWhitelist.
        "sandbox": {"enabled": True, "namespace": controller_env["SANDBOX_NAMESPACE"],
                    "service_name": "sandbox-controller", "persistence": False,
                    "image_whitelist": [controller_env["AGENT_SERVER_IMAGE"]],
                    "resources": {
                        kind: {resource: controller_env[f"SANDBOX_RESOURCE_{resource.upper()}_{suffix}"]
                               for resource in ("cpu", "memory")}
                        for kind, suffix in (("requests", "REQUEST"), ("limits", "LIMIT"))}},
        "security": {"risk_tier": app["risk_tier"], "source_type": app["source_type"],
                     "verified": app["verified"]},
    }
    validate_spec(spec, openapi)
    # Validate free-form native service payloads against the installed operator CRD.
    crd = yaml.safe_load(evidence[next(p for p in SOURCE_PINS if "/crds/" in p)])
    versions = crd["spec"]["versions"]
    stored = next(v for v in versions if v.get("storage"))
    crd_service = stored["schema"]["openAPIV3Schema"]["properties"]["spec"]["properties"]["services"]["items"]
    for service in services:
        for field in ("containerSecurityContext", "healthCheck", "persistence", "volumes", "volumeMounts"):
            if field in service:
                errors = list(jsonschema.Draft7Validator(crd_service["properties"][field]).iter_errors(service[field]))
                require(not errors, "Native service payload does not match installed operator CRD")
    require("$" not in encoded(spec).decode(), "Unresolved interpolation in generated spec")
    verified_images = json.loads(evidence["evidence/platform/tomo-runtime-images-1.2.0.json"])["images"]
    imported_images = json.loads(evidence["evidence/platform/tomo-runtime-image-import-1.2.0.json"])["images"]
    require({i["image"] for i in verified_images} == {s["image"] for s in services}
            == {i["image"] for i in imported_images}, "Image receipt set does not match floor")
    archive_hashes = {i["image"]: i["sha256"] for i in verified_images}
    require(all(i["importExitCode"] == 0 and i["archiveSha256"] == archive_hashes[i["image"]]
                for i in imported_images), "Image import receipt mismatch")
    secret_consumers = {}
    for service in services:
        for env in service["env"]:
            if "valueFrom" in env:
                secret_consumers.setdefault(env["name"], []).append(service["name"])
    missing = sorted(set(ALL_SERVICES) - set(FLOOR))
    gaps = [
        "Create replay-tomo-private separately; required Secret keys are listed without values. "
        "SLACK_BOT_TOKEN, LINEAR_WEBHOOK_SECRET and OTEL_EXPORTER_OTLP_HEADERS must be present as "
        "empty strings. No native user/workload credentials.",
        "DATABASE_URL must use replay-tomo-postgres:5432/tomo and credentials consistent with Postgres "
        "initialization. The private URL is not constructed or inspected by this generator.",
        "Bind externally provisioned retained 4Gi Postgres and SeaweedFS volumes to operator PVCs; "
        "ensure writable ownership for UID/GID 70 and 1000 respectively. No PV/Secret objects are generated.",
        "Core CreateExtension cannot set deployment namespace or pod fsGroup. The installed operator "
        "must target kamiwaza-extensions. Existing replay-server has fsGroup=1000 and tmp emptyDir "
        "mode 2777 owner 0:1000; embeddings has no pod fsGroup. This does not prove Tomo permissions. "
        "Verify UID70 can write Postgres /tmp, /var/run/postgresql and /dev/shm, and its PVC; "
        "do not assume fsGroup follows runAsGroup=70.",
        "WORKER_QUEUE_ENABLED remains true to suppress the API legacy scheduler. No background-worker "
        "or document-worker consumes queues; do not enable ingestion/scheduled jobs on this floor.",
        "Extractor, package runner and egress proxy URLs point to omitted services; their features are "
        "disabled. Restore and qualify those dependencies before enabling uploads/packages/coding.",
        "API package storage and Valkey are ephemeral. Conversation authority is Postgres; shared-chat "
        "presence/leases/cache disappear on Valkey restart. This is not the full persistent catalog topology.",
        "Verify operator sandbox RBAC/service-account injection, trust bundle, service DNS and all seven "
        "ports under additive NetworkPolicies. SandboxSpec enables controller wiring, not application coding.",
        "Native frontend path, signed user/workroom session, API health/migrations and MCP callbacks "
        "require main's runtime qualification through an actual signed Core ForwardAuth envelope. "
        "The helper parses identity headers and relies on upstream Core verification; never expose "
        "Tomo API to naked browser identity headers. No local auth bridge or workload fallback.",
        "LLM remains off until explicit model selection and reviewed enablement. Config-store persisted "
        "overrides must be audited before reusing existing data; env flags alone cannot reset Admin state.",
        "Ingress is disabled for private bootstrap review. Main must qualify the native authenticated "
        "entry route before exposing the app; no deployment or inference occurred here.",
    ]
    manifest = {
        "format": "replay-tomo-runtime-preparation/1", "catalogSHA": CATALOG_SHA,
        "catalogPath": catalogs[0].relative_to(root).as_posix(), "composeSHA": COMPOSE_SHA,
        "sourceSHA256": SOURCE_PINS, "deploySpecSHA256": sha(encoded(spec)),
        "target": {"name": NAME, "namespace": NAMESPACE, "workroom_id": WORKROOM},
        "catalogApp": {"name": app["name"], "version": app["version"]},
        "catalogServiceCount": len(compose["services"]),
        "catalogServices": sorted(compose["services"]), "services": [
            {"name": s["name"], "image": s["image"], "primary": s["primary"],
             "ports": s["ports"], "resources": s["resources"], "healthCheck": s["healthCheck"]}
            for s in services],
        "imageArchiveSHA256": archive_hashes,
        "operatorWiring": {
            "basis": "Observed installed replay-server Deployment/Service/PVC labels and selectors; "
                     "Tomo equivalents are expected reconciliation outputs, not already created objects",
            "namespace": NAMESPACE,
            "volumeContract": CORE_VOLUME_CONTRACT,
            "labels": {"extensions.kamiwaza.io/deployment-id": NAME,
                       "extensions.kamiwaza.io/managed-by": "kamiwaza-extension-operator",
                       "extensions.kamiwaza.io/name": NAME, "extensions.kamiwaza.io/type": "app"},
            "services": [{"service": name, "deploymentAndService": f"{NAME}-{name}",
                          "serviceLabel": {"extensions.kamiwaza.io/service": name},
                          "serviceSelector": {"extensions.kamiwaza.io/deployment-id": NAME,
                                              "extensions.kamiwaza.io/service": name}}
                         for name in FLOOR],
            "expectedPVCs": [{"name": f"{NAME}-{name}-data", "namespace": NAMESPACE,
                              "size": "4Gi", "storageClass": "replay-local", "uid": uid, "gid": uid}
                             for name, uid in (("postgres", 70), ("seaweedfs", 1000))],
            "sandboxNamespace": controller_env["SANDBOX_NAMESPACE"],
            "controllerService": "sandbox-controller",
            "controllerServiceAccount": "Assigned by operator through SandboxSpec.service_name; verify after creation",
            "nativeApiExposure": "Signed Core ForwardAuth envelope only; secure browser edge pending",
            "observedExistingReplayPod": {"podSecurityContext": {"fsGroup": 1000,
                "fsGroupChangePolicy": "OnRootMismatch"},
                "tmpEmptyDir": {"mode": "2777", "uid": 0, "gid": 1000},
                "qualification": "Read-only installed replay-server observation; not a Tomo readiness check"},
        },
        "omittedServices": missing, "secretName": PRIVATE_SECRET,
        "requiredSecretKeys": dict(sorted(secret_consumers.items())),
        "deltas": deltas + [
            {"action": "seven_service_floor", "omittedServices": missing},
            {"action": "operator_injected_tmp", "reason": "Omit explicit tmp volumes and /tmp mounts; Core reserves tmp/data names and the operator injects them", "requestId": CORE_VOLUME_CONTRACT["rejectedCreateRequest"]},
            {"action": "ignore_env_file", "reason": "Only explicit catalog environment is consumed"},
            {"action": "ignore_catalog_env_defaults", "reason": "Compose defaults plus reviewed boot overrides"},
            {"action": "kubernetes_lifecycle", "reason": "One replica per service; no Compose dependency ordering or json-file logging driver"},
            {"action": "compose_ram_units", "reason": "Docker M/G translated to binary Mi/Gi"},
            {"action": "native_health_precedence", "reason": "Compose timings, then catalog health, then x-kamiwaza health; startPeriod retained for startup probe"},
        ],
        "remainingGaps": gaps, "validation": {"coreCreateExtension": True,
            "operatorNativeServiceShapes": True, "inspectedCoreVolumeContract": True,
            "coreCreateAccepted": False, "runtimeQualified": False},
        "deployed": False, "inference": False,
    }
    return spec, manifest


def write_outputs(root, output_dir, spec, manifest):
    root, output_dir = Path(root).resolve(), Path(output_dir).resolve()
    require(output_dir.is_relative_to(root / "data"), "Outputs must remain under ignored data/")
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(not output_dir.is_symlink(), "Output directory must not be a symlink")
    output_dir.chmod(0o700)
    for filename, value in (("deploy-spec.json", spec), ("evidence-manifest.json", manifest)):
        # Atomic replacement and a spec hash in the manifest make interrupted
        # two-file publication detectable. Never publish before all validation.
        fd, tmp = tempfile.mkstemp(prefix=".prepare-", dir=output_dir)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encoded(value))
            os.replace(tmp, output_dir / filename)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data/platform/tomo-runtime")
    args = parser.parse_args(argv)
    try:
        spec, manifest = generate()
        write_outputs(ROOT, args.output_dir, spec, manifest)
    except PreparationError as error:
        print(f"Tomo preparation refused: {error}; no new spec published.")
        return 1
    except OSError:
        # No third-party parse/schema exception text (which can embed input values).
        print("Tomo preparation I/O failed; verify the output pair's hash before use.")
        return 1
    print(json.dumps({"prepared": NAME, "services": len(spec["services"]),
                      "catalogSHA": CATALOG_SHA, "deploySpecSHA256": manifest["deploySpecSHA256"],
                      "deployed": False, "inference": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
