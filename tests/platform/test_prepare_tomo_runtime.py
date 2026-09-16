"""Offline behavioral checks for the exact supplied Tomo deployment floor."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "scripts/platform/prepare-tomo-runtime.py"
loader = importlib.util.spec_from_file_location("prepare_tomo_runtime", MODULE)
runtime = importlib.util.module_from_spec(loader)
loader.loader.exec_module(runtime)


class TomoRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, cls.manifest = runtime.generate(ROOT)
        cls.services = {s["name"]: s for s in cls.spec["services"]}
        cls.catalog = next((ROOT / "data/platform/tomo-catalog").glob(runtime.CATALOG_GLOB))
        cls.app = json.loads(cls.catalog.read_bytes())[0]
        cls.compose = yaml.safe_load(cls.app["compose_yml"])
        cls.openapi = json.loads((ROOT / "evidence/platform/installed-openapi.json").read_bytes())

    def env(self, service):
        return {e["name"]: e for e in self.services[service]["env"]}

    def test_exact_floor_images_and_frontend_ingress(self):
        self.assertEqual(list(self.services), list(runtime.FLOOR))
        self.assertEqual(self.manifest["catalogServiceCount"], 13)
        self.assertIn("background-worker", self.manifest["omittedServices"])
        self.assertIn("sandbox-worker", self.manifest["omittedServices"])
        self.assertEqual([s["name"] for s in self.services.values() if s["primary"]], ["frontend"])
        for name, service in self.services.items():
            self.assertEqual(service["image"], self.compose["services"][name]["image"])
            self.assertTrue(service["image"].endswith(":release-1.2.0"))
            self.assertIn(service["image"], self.manifest["imageArchiveSHA256"])
            self.assertEqual(service["replicas"], 1)
        self.assertFalse(self.spec["networking"]["ingress_enabled"])
        self.assertEqual(self.spec["kamiwaza"]["api_url"], "http://core-api.kamiwaza.svc:7777/api")

    def test_schema_contract_and_unknown_fields_are_rejected(self):
        runtime.validate_spec(self.spec, self.openapi)
        for target, key, value in (((), "namespace", "kamiwaza-extensions"),
                                   (("services", 0), "labels", {}),
                                   (("sandbox",), "serviceName", "sandbox-controller"),
                                   (("services", 0, "ports", 0), "container_port", 70000)):
            with self.subTest(field=key):
                spec = copy.deepcopy(self.spec)
                obj = spec
                for part in target:
                    obj = obj[part]
                obj[key] = value
                with self.assertRaises(runtime.PreparationError):
                    runtime.validate_spec(spec, self.openapi)

    def test_commands_preserve_image_entrypoints_and_empty_arguments(self):
        valkey = self.services["valkey"]
        self.assertEqual(valkey["args"], ["--maxmemory", "512mb", "--maxmemory-policy",
                                         "allkeys-lru", "--appendonly", "no", "--save", ""])
        self.assertNotIn("command", valkey)
        for name, service in self.services.items():
            if name != "valkey":
                self.assertNotIn("command", service)
                self.assertNotIn("args", service)

    def test_secrets_shared_by_consumers_and_never_embedded(self):
        found = set()
        for name in self.services:
            for key, entry in self.env(name).items():
                self.assertNotIn(key, runtime.OMIT_ENV)
                if key in runtime.SECRET_ENV:
                    found.add(key)
                    self.assertEqual(entry, {"name": key, "valueFrom": {"secretKeyRef": {
                        "name": "replay-tomo-private", "key": key}}})
        self.assertEqual(found, runtime.SECRET_ENV)
        self.assertEqual(self.env("agent-runtime")["PI_SIDECAR_TOKEN"],
                         self.env("api-backend")["PI_SIDECAR_TOKEN"])
        for key in ("SEAWEEDFS_S3_ACCESS_KEY", "SEAWEEDFS_S3_SECRET_KEY"):
            self.assertEqual(self.env("seaweedfs")[key], self.env("api-backend")[key])
        combined = runtime.encoded(self.spec) + runtime.encoded(self.manifest)
        for credential in (b"postgres:dev@", b"tomo-dev-secret", b"kaizen-local-pi-token",
                           b"kaizen-local-sandbox-token", b"kaizen-local-pkg-token"):
            self.assertNotIn(credential, combined)
        self.assertNotIn(b"${", combined)

    def test_boot_disables_model_tasks_coding_and_fallback_auth(self):
        env = self.env("api-backend")
        for key in ("LLM_ASSIST_ENABLED", "TASKS_ENABLED", "SANDBOX_ENABLED",
                    "ARTIFACT_RUN_ENABLED", "AGENT_PACKAGES_ENABLED", "DOCUMENT_IMPORT_ENABLED",
                    "DOCUMENT_EXPORT_ENABLED", "DOCUMENT_WORKER_SEPARATE_QUEUE_ENABLED",
                    "KAIZEN_A2A_POC_ENABLED", "KAIZEN_A2A_DISCOVERY_ENABLED",
                    "KAIZEN_A2A_INBOUND_ENABLED", "KAIZEN_A2A_OUTBOUND_ENABLED", "KAIZEN_A2A_SEND_ENABLED"):
            self.assertEqual(env[key]["value"], "false", key)
        self.assertEqual(env["KAMIWAZA_USE_AUTH"]["value"], "true")
        self.assertEqual(env["TASKS_BACKGROUND_AUTH_MODE"]["value"], "core")
        self.assertEqual(env["SANDBOX_WARM_POOL_MIN"]["value"], "0")
        self.assertEqual(env["SANDBOX_POOL_TARGET_IDLE"]["value"], "0")
        # True suppresses API in-process scheduling; false would restore it.
        self.assertEqual(env["WORKER_QUEUE_ENABLED"]["value"], "true")
        self.assertNotIn("workload_identity", self.spec)
        self.assertNotIn("annotations", self.spec)

    def test_urls_are_scoped_without_altering_paths(self):
        expected = {
            ("frontend", "KAIZEN_BOT_UPSTREAM"): "http://replay-tomo-api-backend:8000",
            ("agent-runtime", "PI_KAIZEN_CALLBACK_URL"): "http://replay-tomo-api-backend:8000/api",
            ("api-backend", "SHARED_CHAT_LIVE_REDIS_URL"): "redis://replay-tomo-valkey:6379/3",
            ("api-backend", "SANDBOX_CONTROLLER_URL"): "http://replay-tomo-sandbox-controller:8085",
            ("api-backend", "SEAWEEDFS_S3_ENDPOINT"): "http://replay-tomo-seaweedfs:8333",
            ("api-backend", "PKG_RUNNER_URL"): "http://replay-tomo-package-tool-runner:8090",
        }
        for (service, key), value in expected.items():
            self.assertEqual(self.env(service)[key]["value"], value)
        self.assertEqual(runtime.scoped_url("http://api-backend:8000/api/api-backend?q=postgres"),
                         "http://replay-tomo-api-backend:8000/api/api-backend?q=postgres")
        self.assertEqual(runtime.scoped_url("https://example.org/api-backend"),
                         "https://example.org/api-backend")
        with self.assertRaises(runtime.PreparationError):
            runtime.scoped_url("postgresql://user:private@postgres:5432/tomo")

    def test_health_precedence_and_startup_grace(self):
        self.assertEqual(self.services["postgres"]["healthCheck"]["exec"]["command"],
                         ["pg_isready", "-U", "postgres", "-d", "tomo"])
        backend = self.services["api-backend"]["healthCheck"]
        self.assertEqual(backend["startPeriod"], 900)
        self.assertEqual(backend["failureThreshold"], 5)
        self.assertEqual(backend["httpGet"], {"path": "/healthz", "port": 8000})
        controller = self.services["sandbox-controller"]["healthCheck"]
        self.assertEqual(controller["httpGet"], {"path": "/health", "port": 8085})
        self.assertNotIn("exec", controller)
        self.assertEqual(controller["startPeriod"], 10)
        self.assertEqual(self.services["frontend"]["healthCheck"]["exec"]["command"],
                         ["/usr/local/bin/kaizen-healthcheck"])

    def test_persistence_ephemeral_storage_and_security(self):
        for name, uid, mount in (("postgres", 70, "/var/lib/postgresql/data"),
                                 ("seaweedfs", 1000, "/data")):
            service = self.services[name]
            self.assertEqual(service["persistence"], {"enabled": True, "size": "4Gi",
                              "mountPath": mount, "storageClass": "replay-local"})
            self.assertEqual(service["containerSecurityContext"]["runAsUser"], uid)
            self.assertTrue(service["containerSecurityContext"]["readOnlyRootFilesystem"])
            self.assertNotIn(mount, [m["mountPath"] for m in service["volumeMounts"]])
        pg = self.services["postgres"]
        shm = next(v for v in pg["volumes"] if v["name"] == "pg-shm")
        self.assertEqual(shm["emptyDir"], {"medium": "Memory", "sizeLimit": "2Gi"})
        self.assertIn("/var/run/postgresql", [m["mountPath"] for m in pg["volumeMounts"]])
        for name, service in self.services.items():
            self.assertFalse(service["containerSecurityContext"]["allowPrivilegeEscalation"])
            self.assertEqual(service["containerSecurityContext"]["capabilities"]["drop"], ["ALL"])
            self.assertEqual(service["automountServiceAccountToken"], name == "sandbox-controller")
            self.assertTrue(all(set(v) == {"name", "emptyDir"} for v in service["volumes"]))
        self.assertTrue(self.services["frontend"]["containerSecurityContext"]["readOnlyRootFilesystem"])
        self.assertNotIn("persistence", self.services["valkey"])

    def test_resources_match_compose_binary_ram_and_controller_limits(self):
        self.assertEqual(self.services["postgres"]["resources"], {
            "limits": {"cpu": "2", "memory": "4Gi"},
            "requests": {"cpu": "0.25", "memory": "512Mi"}})
        self.assertEqual(self.services["valkey"]["resources"]["limits"]["memory"], "768Mi")
        self.assertEqual(self.spec["sandbox"]["resources"], {
            "limits": {"cpu": "1", "memory": "1Gi"},
            "requests": {"cpu": "50m", "memory": "256Mi"}})
        bad = copy.deepcopy(self.compose["services"]["postgres"]["deploy"]["resources"])
        bad["limits"]["pids"] = 100
        with self.assertRaises(runtime.PreparationError):
            runtime.resources(bad)

    def test_operator_tmp_is_injected_not_declared(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertFalse({v["name"] for v in service["volumes"]} & {"tmp", "data"})
                self.assertFalse({m["name"] for m in service["volumeMounts"]} & {"tmp", "data"})
                self.assertNotIn("/tmp", [m["mountPath"] for m in service["volumeMounts"]])
        for name in ("seaweedfs", "frontend", "agent-runtime", "sandbox-controller"):
            self.assertEqual(self.services[name]["volumes"], [])
            self.assertEqual(self.services[name]["volumeMounts"], [])
        self.assertEqual(self.manifest["operatorWiring"]["volumeContract"]["operatorInjectedTmp"],
                         {"name": "tmp", "mountPath": "/tmp"})

    def test_reserved_volume_and_mount_names_fail_before_publication(self):
        for reserved in ("tmp", "data"):
            for field in ("volumes", "volumeMounts"):
                with self.subTest(name=reserved, field=field):
                    spec = copy.deepcopy(self.spec)
                    spec["services"][0][field].append(
                        {"name": reserved, "emptyDir": {}} if field == "volumes"
                        else {"name": reserved, "mountPath": "/custom"})
                    with self.assertRaisesRegex(runtime.PreparationError, "Operator-reserved"):
                        runtime.validate_spec(spec, self.openapi)

    def test_mount_path_collisions_duplicates_and_unbacked_mounts_fail(self):
        cases = [
            ({"name": "other", "emptyDir": {}}, {"name": "other", "mountPath": "/tmp"}),
            ({"name": "other", "emptyDir": {}}, {"name": "other", "mountPath": "/tmp/"}),
            ({"name": "other", "emptyDir": {}}, {"name": "other", "mountPath": "/var/lib/postgresql/data/"}),
            ({"name": "other", "emptyDir": {}}, {"name": "other", "mountPath": "/dev/shm"}),
            (None, {"name": "missing", "mountPath": "/custom"}),
            ({"name": "pg-shm", "emptyDir": {}}, None),
        ]
        for volume, mount in cases:
            with self.subTest(volume=volume, mount=mount):
                spec = copy.deepcopy(self.spec)
                if volume:
                    spec["services"][0]["volumes"].append(volume)
                if mount:
                    spec["services"][0]["volumeMounts"].append(mount)
                with self.assertRaises(runtime.PreparationError):
                    runtime.validate_spec(spec, self.openapi)

    def test_operator_controller_wiring_and_provisioning_seams(self):
        self.assertTrue(self.spec["sandbox"]["enabled"])
        self.assertEqual(self.spec["sandbox"]["namespace"], "kamiwaza-sandboxes")
        self.assertEqual(self.spec["sandbox"]["service_name"], "sandbox-controller")
        self.assertFalse(self.spec["sandbox"]["persistence"])
        self.assertEqual(self.spec["sandbox"]["image_whitelist"],
                         [self.env("sandbox-controller")["AGENT_SERVER_IMAGE"]["value"]])
        wiring = self.manifest["operatorWiring"]
        self.assertEqual(wiring["namespace"], "kamiwaza-extensions")
        self.assertEqual([v["name"] for v in wiring["expectedPVCs"]],
                         ["replay-tomo-postgres-data", "replay-tomo-seaweedfs-data"])
        self.assertEqual(wiring["services"][0]["serviceSelector"], {
            "extensions.kamiwaza.io/deployment-id": "replay-tomo",
            "extensions.kamiwaza.io/service": "postgres"})

    def test_nested_defaults_and_unresolved_shapes(self):
        self.assertEqual(runtime.default_value("${A:-${B:-true}}"), "true")
        self.assertEqual(runtime.default_value("${A:-}"), "")
        self.assertEqual(runtime.default_value('${A:-[["model",1000000]]}'), '[["model",1000000]]')
        for value in ("${REQUIRED}", "${A:?message}", "${A-default}", "$A", "$$", "${A:-oops", 4, True):
            with self.subTest(value=value), self.assertRaises(runtime.PreparationError):
                runtime.default_value(value)
        with self.assertRaises(runtime.PreparationError):
            runtime.environment("api-backend", {"UNREVIEWED_API_KEY": "DO-NOT-ECHO"}, [])

    def test_no_environment_or_env_file_influence_and_byte_reproducibility(self):
        with patch.dict(os.environ, {"POSTGRES_PASSWORD": "DO-NOT-ECHO", "LLM_ASSIST_ENABLED": "true",
                                     "KAMIWAZA_BEARER_TOKEN": "DO-NOT-ECHO", "SANDBOX_WARM_POOL_MIN": "32"}):
            again, manifest = runtime.generate(ROOT)
        self.assertEqual(runtime.encoded(again), runtime.encoded(self.spec))
        self.assertEqual(runtime.encoded(manifest), runtime.encoded(self.manifest))
        self.assertEqual(self.manifest["deploySpecSHA256"], runtime.sha(runtime.encoded(self.spec)))
        self.assertNotIn(b"DO-NOT-ECHO", runtime.encoded(again) + runtime.encoded(manifest))

    def test_catalog_drift_ambiguity_missing_inputs_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(runtime.PreparationError, "exactly one"):
                runtime.generate(root)
            catalog = root / "data/platform/tomo-catalog/a/kamiwaza-extensions-tomo/registry/garden/v3/apps.json"
            catalog.parent.mkdir(parents=True)
            catalog.write_bytes(self.catalog.read_bytes() + b"\n")
            with self.assertRaisesRegex(runtime.PreparationError, "SHA256"):
                runtime.generate(root)
            catalog.write_bytes(self.catalog.read_bytes())
            with self.assertRaisesRegex(runtime.PreparationError, "unavailable"):
                runtime.generate(root)
            other = root / "data/platform/tomo-catalog/b/kamiwaza-extensions-tomo/registry/garden/v3/apps.json"
            other.parent.mkdir(parents=True)
            other.write_bytes(catalog.read_bytes())
            with self.assertRaisesRegex(runtime.PreparationError, "exactly one"):
                runtime.generate(root)

    def test_private_outputs_are_deterministic_and_confined(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "data/platform/tomo-runtime"
            runtime.write_outputs(root, out, self.spec, self.manifest)
            first = {p.name: p.read_bytes() for p in out.iterdir()}
            runtime.write_outputs(root, out, self.spec, self.manifest)
            self.assertEqual(first, {p.name: p.read_bytes() for p in out.iterdir()})
            self.assertEqual(set(first), {"deploy-spec.json", "evidence-manifest.json"})
            self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in out.iterdir()))
            with self.assertRaises(runtime.PreparationError):
                runtime.write_outputs(root, root / "tracked", self.spec, self.manifest)
            (root / "data/escape").symlink_to(root, target_is_directory=True)
            with self.assertRaises(runtime.PreparationError):
                runtime.write_outputs(root, root / "data/escape", self.spec, self.manifest)


if __name__ == "__main__":
    unittest.main()
