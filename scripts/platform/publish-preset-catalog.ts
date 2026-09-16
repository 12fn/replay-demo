/**
 * Publish the immutable PUBLIC SYNTHETIC preset catalog (handoff/REPLAY-preset-catalog-1) as one native
 * Kamiwaza 1.2 writable catalog dataset with platform-managed `file` storage.
 *   Plan (default, offline): tsx scripts/platform/publish-preset-catalog.ts [--plan] [--out evidence/platform/NEW.json]
 *   Apply (main, reviewed):  run_logged.py LABEL -- tsx scripts/platform/publish-preset-catalog.ts --apply
 *   Offline checks:          tsx scripts/platform/publish-preset-catalog.ts --self-test
 * Apply logs in serially as the existing workroom owner (poc-viewer) and sends every Core call only after a
 * fresh ForwardAuth for that exact method and URI. It creates at most one dataset and five objects: no PUT,
 * PATCH or DELETE, no retried uncertain POST, no gates, memberships, admin, ontology, ingestion or models.
 * Catalog record links stay portable data inside the uploaded files, not native ontology edges.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { KamiwazaClient } from '../../src/platform';
import { buildForwardAuthHeaders, extractSignedIdentity } from '../../src/platform/forward-auth';

type Json = Record<string, any>;
export class CheckFailure extends Error {}
function check(value: unknown, code: string): asserts value { if (!value) throw new CheckFailure(code); }
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Json)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const digest = (value: unknown) => sha256(stable(value));

export const HANDOFF_DIR = 'handoff/REPLAY-preset-catalog-1';
/** Trust anchor: manifest.json of the immutable export. Every other file is pinned through it. */
export const EXPECTED_MANIFEST_SHA256 = '568457d20256a27665ad3f6ba856c1d698fdac447854876c8a95d7f0ea94d206';
export const OPENAPI_FILE = 'evidence/platform/installed-openapi.json';
export const LEDGER_DIR = 'evidence/platform/preset-catalog-publish/replay-preset-catalog-1';
export const CATALOG_SCHEMA = 'replay.preset-catalog/1';
export const CATALOG_VERSION = 'preset-catalog/1';
export const CATALOG_SEED = 'authored-deterministic/preset-catalog/1';
export const DATASET_NAME = 'replay-preset-catalog-1';
// Installed Core _validate_writable_create requires its own platform for managed bytes.
export const DATASET_PLATFORM = 'kamiwaza';
export const DATASET_ENVIRONMENT = 'DEV';
export const DATASET_URN = `urn:li:dataset:(urn:li:dataPlatform:${DATASET_PLATFORM},${DATASET_NAME},${DATASET_ENVIRONMENT})`;
export const PUBLISHER = 'replay.preset-catalog-publisher/1';
export const CALL_CAP = 24;
const OWNER_USERNAME = 'poc-viewer';
const FORWARDED_HOST = 'kamiwaza-harness.localhost';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const HANDOFF_ENTRIES = ['README.md', 'catalog.json', 'manifest.json', 'records.jsonl', 'relationships.jsonl', 'sources.json'];
export const UPLOADS = [
  { name: 'catalog.json', contentType: 'application/json' },
  { name: 'records.jsonl', contentType: 'application/x-ndjson' },
  { name: 'relationships.jsonl', contentType: 'application/x-ndjson' },
  { name: 'sources.json', contentType: 'application/json' },
  { name: 'manifest.json', contentType: 'application/json' },
] as const;
const KINDS = ['persona', 'report', 'case', 'event', 'asset', 'glossary', 'historical', 'lesson', 'organization', 'red-profile'];
const RELATIONS = ['belongs-to', 'authored-by', 'cites', 'derived-from', 'supersedes', 'disputes', 'reviews', 'precedes', 'uses', 'contrasts-with'];
const ROLES = ['commander', 'intelligence', 'instructor'];
const PROVENANCE = ['synthetic', 'public-reference'];
const RECORD_REQUIRED = ['id', 'aorId', 'kind', 'title', 'summary', 'body', 'roles', 'tags', 'provenance', 'sourceIds', 'links', 'fields'];
const RECORD_OPTIONAL = ['personaId', 'caseId', 'observedTick', 'availableAtTick'];
const SOURCE_KEYS = ['id', 'title', 'url', 'publisher', 'retrievedAt', 'summary', 'usage', 'scope'];
const DATASET_CREATE_KEYS = ['name', 'platform', 'environment', 'description', 'tags', 'properties', 'dataset_schema', 'writable', 'storage'];
const MULTIPART_FIELDS = ['file', 'logical_path'];
const SAFE_TARGET = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSafeName = (name: unknown): name is string =>
  typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.includes('..');
const isRecord = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
function exactKeys(value: unknown, keys: readonly string[], code: string): asserts value is Json {
  check(isRecord(value) && stable(Object.keys(value).sort()) === stable([...keys].sort()), code);
}
function utf8(bytes: Uint8Array, code: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new CheckFailure(code); }
}
function parseJsonBytes(bytes: Uint8Array | null, code: string): any {
  try { return JSON.parse(utf8(bytes ?? new Uint8Array(), code)); } catch { throw new CheckFailure(code); }
}

// ---------------------------------------------------------------------------
// Immutable handoff validation
// ---------------------------------------------------------------------------

/** Reads one regular file without following links; the returned buffer is what gets hashed and uploaded. */
function readRegular(dir: string, name: string): Buffer {
  check(isSafeName(name), 'unsafe-file-name');
  const file = path.join(dir, name);
  const link = fs.lstatSync(file, { throwIfNoEntry: false });
  check(link, `missing-file:${name}`);
  check(!link.isSymbolicLink() && link.isFile(), 'symlink-or-special-file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    check(stat.isFile() && stat.ino === link.ino && stat.dev === link.dev, 'file-changed-during-open');
    check(stat.size <= MAX_FILE_BYTES, 'file-too-large');
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < stat.size;) {
      const n = fs.readSync(fd, bytes, offset, stat.size - offset, offset);
      check(n > 0, 'file-short-read');
      offset += n;
    }
    check(fs.readSync(fd, Buffer.alloc(1), 0, 1, stat.size) === 0, 'file-grew-during-read');
    return bytes;
  } finally { fs.closeSync(fd); }
}

export interface HandoffFile { name: string; contentType: string; bytes: Buffer; size: number; sha256: string }
export interface CatalogSummary {
  schema: string; version: string; seed: string; catalogSha256: string; readmeSha256: string;
  records: number; relationships: number; counts: Record<string, number>; provenance: Record<string, number>;
  aors: string[]; sources: number;
}
export interface VerifiedHandoff { manifestSha256: string; uploads: HandoffFile[]; summary: CatalogSummary }

export function validateHandoff(dir = HANDOFF_DIR, expectedManifestSha256 = EXPECTED_MANIFEST_SHA256): VerifiedHandoff {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  check(stat && stat.isDirectory() && !stat.isSymbolicLink(), 'handoff-directory');
  check(fs.realpathSync(dir) === path.resolve(dir), 'handoff-symlinked-path');
  check(stable(fs.readdirSync(dir).sort()) === stable([...HANDOFF_ENTRIES].sort()), 'handoff-unexpected-entries');
  const raw = new Map(HANDOFF_ENTRIES.map(name => [name, readRegular(dir, name)]));
  const bytesOf = (name: string) => raw.get(name)!;

  const manifestSha256 = sha256(bytesOf('manifest.json'));
  check(manifestSha256 === expectedManifestSha256, 'manifest-sha256-mismatch');
  const manifest = parseJsonBytes(bytesOf('manifest.json'), 'manifest-json');
  exactKeys(manifest, ['version', 'seed', 'catalogSha256', 'total', 'counts', 'relationships', 'files'], 'manifest-keys');
  check(manifest.version === CATALOG_VERSION && manifest.seed === CATALOG_SEED, 'manifest-version');
  check(/^[a-f0-9]{64}$/.test(manifest.catalogSha256), 'manifest-catalog-sha256');
  check(Array.isArray(manifest.files), 'manifest-files');
  for (const f of manifest.files) {
    exactKeys(f, ['name', 'bytes', 'sha256'], 'manifest-file-keys');
    check(isSafeName(f.name), 'manifest-unsafe-file-name');
  }
  const names: string[] = manifest.files.map((f: Json) => f.name);
  check(new Set(names).size === names.length
    && stable([...names].sort()) === stable(HANDOFF_ENTRIES.filter(n => n !== 'manifest.json').sort()), 'manifest-file-set');
  for (const f of manifest.files) {
    const bytes = bytesOf(f.name);
    check(f.bytes === bytes.length && f.sha256 === sha256(bytes), `manifest-hash-mismatch:${f.name}`);
  }

  const catalogText = utf8(bytesOf('catalog.json'), 'catalog-utf8');
  const catalog = parseJsonBytes(bytesOf('catalog.json'), 'catalog-json');
  exactKeys(catalog, ['schema', 'version', 'seed', 'notice', 'aors', 'sources', 'records'], 'catalog-keys');
  check(catalog.schema === CATALOG_SCHEMA && catalog.version === CATALOG_VERSION && catalog.seed === CATALOG_SEED, 'catalog-schema-version');
  check(typeof catalog.notice === 'string' && catalog.notice.includes('fictional synthetic'), 'catalog-synthetic-notice');
  check(catalogText === JSON.stringify(catalog, null, 2) + '\n', 'catalog-not-canonical');
  check(Array.isArray(catalog.aors) && Array.isArray(catalog.sources) && Array.isArray(catalog.records), 'catalog-arrays');

  const aorIds = new Set<string>(catalog.aors.map((a: Json) => a?.id));
  check(aorIds.size === catalog.aors.length && [...aorIds].every(id => typeof id === 'string'), 'catalog-aor-ids');
  const sourceIds = new Set<string>();
  for (const s of catalog.sources) {
    exactKeys(s, SOURCE_KEYS, 'catalog-source-keys');
    check(typeof s.id === 'string' && !sourceIds.has(s.id), 'catalog-source-ids');
    check(s.usage === 'link-and-original-summary' && typeof s.url === 'string' && s.url.startsWith('https://'), 'catalog-source-usage');
    sourceIds.add(s.id);
  }
  const recordIds = new Set<string>();
  for (const r of catalog.records) {
    check(typeof r?.id === 'string' && /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(r.id) && !recordIds.has(r.id), 'catalog-record-id');
    recordIds.add(r.id);
  }
  const counts: Record<string, number> = {}, provenance: Record<string, number> = {};
  let relationships = 0;
  for (const r of catalog.records) {
    const keys = Object.keys(r);
    check(RECORD_REQUIRED.every(k => keys.includes(k)) && keys.every(k => RECORD_REQUIRED.includes(k) || RECORD_OPTIONAL.includes(k)), 'catalog-record-keys');
    check(KINDS.includes(r.kind) && PROVENANCE.includes(r.provenance) && aorIds.has(r.aorId), 'catalog-record-enum');
    check(Array.isArray(r.roles) && r.roles.every((x: unknown) => ROLES.includes(x as string)), 'catalog-record-roles');
    check(Array.isArray(r.tags) && r.tags.every((x: unknown) => typeof x === 'string') && isRecord(r.fields), 'catalog-record-fields');
    check(Array.isArray(r.sourceIds) && r.sourceIds.every((x: string) => sourceIds.has(x)), 'catalog-source-reference');
    check(Array.isArray(r.links), 'catalog-links');
    for (const l of r.links) {
      exactKeys(l, ['relation', 'targetId'], 'catalog-link-keys');
      check(RELATIONS.includes(l.relation), 'catalog-link-relation');
      check(recordIds.has(l.targetId), 'catalog-link-target');
    }
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    provenance[r.provenance] = (provenance[r.provenance] ?? 0) + 1;
    relationships += r.links.length;
  }
  check(manifest.total === catalog.records.length, 'manifest-total');
  check(stable(manifest.counts) === stable(counts), 'manifest-counts');
  check(manifest.relationships === relationships, 'manifest-relationships');

  // Derived exports must be byte-identical to the catalog, so every uploaded object says the same thing.
  check(utf8(bytesOf('records.jsonl'), 'records-utf8') === catalog.records.map((r: Json) => JSON.stringify(r)).join('\n') + '\n', 'records-jsonl-mismatch');
  check(utf8(bytesOf('relationships.jsonl'), 'relationships-utf8') === catalog.records.flatMap((r: Json) => r.links.map((l: Json) =>
    JSON.stringify({ from: r.id, relation: l.relation, to: l.targetId, aorId: r.aorId }))).join('\n') + '\n', 'relationships-jsonl-mismatch');
  check(utf8(bytesOf('sources.json'), 'sources-utf8') === JSON.stringify(catalog.sources, null, 2) + '\n', 'sources-json-mismatch');

  return {
    manifestSha256,
    uploads: UPLOADS.map(u => ({ name: u.name, contentType: u.contentType, bytes: bytesOf(u.name), size: bytesOf(u.name).length, sha256: sha256(bytesOf(u.name)) })),
    summary: {
      schema: catalog.schema, version: catalog.version, seed: catalog.seed, catalogSha256: manifest.catalogSha256,
      readmeSha256: sha256(bytesOf('README.md')), records: catalog.records.length, relationships, counts, provenance,
      aors: [...aorIds], sources: catalog.sources.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Installed native schema and request plan
// ---------------------------------------------------------------------------

const refName = (schema: unknown) => isRecord(schema) && typeof schema.$ref === 'string' ? schema.$ref.split('/').pop() : undefined;
const OBJECTS_ROUTE = '/catalog/datasets/v2/{dataset_urn}/objects';

/** Fails with an explicit `unsupported-*` code when the inspected installation lacks what apply relies on. */
export function assertNativeCatalogSupport(openapi: Json): { storageBackends: string[] } {
  const paths = openapi?.paths, schemas = openapi?.components?.schemas;
  check(isRecord(paths) && isRecord(schemas), 'unsupported-openapi-shape');
  const routes: [string, string][] = [['/catalog/datasets/', 'post'], ['/catalog/datasets/', 'get'], ['/catalog/datasets/by-urn', 'get'],
    [OBJECTS_ROUTE, 'post'], [OBJECTS_ROUTE, 'get'], [`${OBJECTS_ROUTE}/{item_id}/content`, 'get']];
  for (const [route, method] of routes) check(isRecord(paths[route]?.[method]), `unsupported-native-endpoint:${method.toUpperCase()} ${route}`);
  const create = paths['/catalog/datasets/'].post;
  check(refName(create.requestBody?.content?.['application/json']?.schema) === 'DatasetCreate' && create.responses?.['201'], 'unsupported-dataset-create-operation');
  const createProps = schemas.DatasetCreate?.properties;
  check(isRecord(createProps), 'unsupported-dataset-create-schema');
  for (const key of DATASET_CREATE_KEYS) check(key in createProps, `unsupported-dataset-create-field:${key}`);
  check(Array.isArray(createProps.storage.anyOf) && createProps.storage.anyOf.some((x: unknown) => refName(x) === 'DatasetStorageRequest'), 'unsupported-dataset-storage');
  const storage = schemas.DatasetStorageRequest?.properties;
  check(isRecord(storage) && stable(Object.keys(storage)) === stable(['backend']), 'unsupported-storage-request-shape');
  const storageBackends: string[] = (storage.backend.anyOf ?? [storage.backend]).flatMap((x: Json) => Array.isArray(x?.enum) ? x.enum : []);
  check(storageBackends.includes('file'), 'unsupported-storage-backend-file');
  const upload = paths[OBJECTS_ROUTE].post;
  const uploadSchema = schemas[refName(upload.requestBody?.content?.['multipart/form-data']?.schema) ?? ''];
  check(isRecord(uploadSchema?.properties) && stable(Object.keys(uploadSchema.properties).sort()) === stable(MULTIPART_FIELDS), 'unsupported-object-multipart-fields');
  check(upload.responses?.['201'], 'unsupported-object-create-status');
  const item = schemas.DatasetContentItemResponse;
  check(['item_id', 'logical_path', 'etag', 'size_bytes', 'state'].every(k => item?.required?.includes(k)), 'unsupported-object-item-shape');
  check(paths[OBJECTS_ROUTE].get.parameters?.some((p: Json) => p.name === 'state' && p.schema?.enum?.includes('all')), 'unsupported-object-state-filter');
  return { storageBackends };
}

const RECORD_SCHEMA_FIELDS: [string, string, string][] = [
  ['id', 'string', 'Stable lowercase path identifier'],
  ['aorId', 'string', 'taiwan | caribbean | hormuz'],
  ['kind', 'string', KINDS.join(' | ')],
  ['title', 'string', 'Fictional or public-reference title'],
  ['summary', 'string', 'Short authored summary'],
  ['body', 'string', 'Authored body; complete, including hindsight'],
  ['roles', 'array<string>', ROLES.join(' | ')],
  ['tags', 'array<string>', 'Free-form tags'],
  ['provenance', 'string', PROVENANCE.join(' | ')],
  ['sourceIds', 'array<string>', 'Public source link ids from sources.json'],
  ['links', 'array<object>', 'relation + targetId; portable graph data, not native ontology edges'],
  ['fields', 'object', 'Kind-specific scalar fields'],
  ['personaId', 'string?', 'Optional fictional persona id'],
  ['caseId', 'string?', 'Optional case id'],
  ['observedTick', 'number?', 'Optional synthetic game tick'],
  ['availableAtTick', 'number?', 'Optional synthetic release tick'],
];

/** String values only: DataHub custom properties are string maps even though DatasetCreate allows any JSON. */
export function datasetProperties(h: VerifiedHandoff): Record<string, string> {
  const s = h.summary;
  return {
    'replay.publisher': PUBLISHER,
    'replay.dataset_key': DATASET_NAME,
    'replay.classification': 'PUBLIC SYNTHETIC',
    'replay.catalog_schema': s.schema,
    'replay.catalog_version': s.version,
    'replay.catalog_seed': s.seed,
    'replay.catalog_sha256': s.catalogSha256,
    'replay.manifest_sha256': h.manifestSha256,
    'replay.records': String(s.records),
    'replay.relationships': String(s.relationships),
    'replay.counts': stable(s.counts),
    'replay.provenance': stable(s.provenance),
    'replay.aors': s.aors.join(','),
    'replay.sources': String(s.sources),
    'replay.objects': stable(h.uploads.map(f => ({ logicalPath: f.name, sha256: f.sha256, bytes: f.size, contentType: f.contentType }))),
    'replay.relationships_are_ontology_edges': 'false',
    'replay.llm_ingestion': 'false',
  };
}

export function buildDatasetCreate(h: VerifiedHandoff): Json {
  return {
    name: DATASET_NAME,
    platform: DATASET_PLATFORM,
    environment: DATASET_ENVIRONMENT,
    description: 'PUBLIC SYNTHETIC REPLAY preset reference catalog (preset-catalog/1). Fictional personas, organizations, assets, '
      + 'reports and cases plus public-source historical link cards. Not real people, forces, users, exercises or intelligence. '
      + 'Record links are portable data, not ontology edges.',
    tags: ['replay', 'public-synthetic', 'preset-catalog'],
    properties: datasetProperties(h),
    dataset_schema: { name: CATALOG_SCHEMA, platform: DATASET_PLATFORM, version: 1,
      fields: RECORD_SCHEMA_FIELDS.map(([name, type, description]) => ({ name, type, description })) },
    writable: true,
    storage: { backend: 'file' },
  };
}

/** Exactly the reviewed fields: no container, custom location, gate or extra keys. */
export function assertDatasetCreateBody(body: unknown): void {
  exactKeys(body, DATASET_CREATE_KEYS, 'dataset-create-unexpected-fields');
  check(body.name === DATASET_NAME && body.platform === DATASET_PLATFORM && body.environment === DATASET_ENVIRONMENT, 'dataset-create-identity');
  check(body.writable === true, 'dataset-create-not-writable');
  exactKeys(body.storage, ['backend'], 'dataset-create-storage-fields');
  check(body.storage.backend === 'file', 'dataset-create-storage-backend');
  check(isRecord(body.properties) && Object.values(body.properties).every(v => typeof v === 'string'), 'dataset-create-properties');
  check(Array.isArray(body.tags) && body.tags.every((t: unknown) => typeof t === 'string'), 'dataset-create-tags');
  exactKeys(body.dataset_schema, ['name', 'platform', 'version', 'fields'], 'dataset-create-schema-fields');
  for (const f of body.dataset_schema.fields) exactKeys(f, ['name', 'type', 'description'], 'dataset-create-schema-field');
}

export const objectsPath = () => `/catalog/datasets/v2/${encodeURIComponent(DATASET_URN)}/objects`;

export function buildPlan(h: VerifiedHandoff, openapiBytes: Uint8Array) {
  const support = assertNativeCatalogSupport(parseJsonBytes(openapiBytes, 'openapi-json'));
  const body = buildDatasetCreate(h);
  assertDatasetCreateBody(body);
  const objects = h.uploads.map(f => ({ logicalPath: f.name, contentType: f.contentType, bytes: f.size, sha256: f.sha256,
    method: 'POST' as const, path: objectsPath(), multipartFields: MULTIPART_FIELDS }));
  const plan = {
    schema: 'replay.native-preset-catalog-plan/1',
    classification: 'PUBLIC SYNTHETIC',
    handoff: { dir: HANDOFF_DIR, manifestSha256: h.manifestSha256, ...h.summary },
    native: { openapiFile: OPENAPI_FILE, openapiSha256: sha256(openapiBytes), storageBackendsAdvertised: support.storageBackends,
      datasetUrn: DATASET_URN, name: DATASET_NAME, platform: DATASET_PLATFORM, environment: DATASET_ENVIRONMENT,
      writable: true, storageBackend: 'file', identity: `existing workroom owner (${OWNER_USERNAME})`, callCap: CALL_CAP },
    datasetCreate: { method: 'POST' as const, path: '/catalog/datasets/', bodySha256: sha256(JSON.stringify(body)), body },
    objects,
    requestSequence: [
      'GET /catalog/datasets/by-urn?urn=<urn> and GET /catalog/datasets/?query=<name> (inspect)',
      'POST /catalog/datasets/ only when absent and never previously uncertain',
      'GET /catalog/datasets/by-urn (confirm exact identity, writable, file storage, workroom scope)',
      'GET /catalog/datasets/v2/<encoded urn>/objects?state=all (inspect)',
      ...objects.flatMap(o => [`POST objects ${o.logicalPath} only when absent`, `GET objects/<item_id>/content ${o.logicalPath} (sha256 ${o.sha256})`]),
      'GET by-urn and objects?state=all (final exact state)',
    ],
    guarantees: { forwardAuthPerTarget: true, serial: true, putPatchDelete: false, retryUncertainPost: false, adminElevation: false,
      gateOrMembershipChanges: false, customStoragePath: false, ontologyEdges: false, llmIngestion: false, modelCalls: 0 },
  };
  return { ...plan, planSha256: digest(plan) };
}
export type PublishPlan = ReturnType<typeof buildPlan>;

export function buildObjectForm(file: HandoffFile): FormData {
  check(isSafeName(file.name), 'multipart-logical-path');
  check(file.bytes.length === file.size && sha256(file.bytes) === file.sha256, 'upload-bytes-changed');
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.name);
  form.set('logical_path', file.name);
  assertMultipartFields(form);
  return form;
}
export function assertMultipartFields(form: FormData): void {
  check(stable([...form.keys()]) === stable(MULTIPART_FIELDS), 'multipart-unexpected-fields');
  check(isSafeName(form.get('logical_path')) && form.get('file') instanceof Blob, 'multipart-logical-path');
}

// ---------------------------------------------------------------------------
// Append-only receipts and resume decisions
// ---------------------------------------------------------------------------

const GENESIS = '0'.repeat(64);

/** Hash-chained JSONL. Each entry is fsynced before the next native call. Existing lines are never rewritten. */
export class ReceiptLedger {
  readonly entries: Json[] = [];
  private fd = -1;
  private last = GENESIS;
  private constructor(readonly file: string) {}
  static open(dir: string): ReceiptLedger {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    check(fs.realpathSync(dir) === path.resolve(dir), 'ledger-symlinked-path');
    const ledger = new ReceiptLedger(path.join(dir, 'receipts.jsonl'));
    const stat = fs.lstatSync(ledger.file, { throwIfNoEntry: false });
    check(!stat || (stat.isFile() && !stat.isSymbolicLink()), 'ledger-not-regular-file');
    if (stat) {
      const text = fs.readFileSync(ledger.file, 'utf8');
      check(text === '' || text.endsWith('\n'), 'ledger-torn-write');
      for (const [i, line] of text.split('\n').slice(0, -1).entries()) {
        let entry: Json;
        try { entry = JSON.parse(line); } catch { throw new CheckFailure('ledger-unparseable'); }
        check(entry.seq === i + 1 && entry.prevSha256 === ledger.last, 'ledger-chain-broken');
        ledger.entries.push(entry);
        ledger.last = sha256(line);
      }
    }
    ledger.fd = fs.openSync(ledger.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    return ledger;
  }
  append(entry: Json, secrets: readonly string[] = []): Json {
    check(this.fd >= 0, 'ledger-closed');
    check(!('seq' in entry) && !('prevSha256' in entry), 'ledger-reserved-field');
    const full = { seq: this.entries.length + 1, prevSha256: this.last, at: new Date().toISOString(), ...entry };
    const line = JSON.stringify(full);
    check(!secrets.some(s => s.length > 0 && line.includes(s)), 'secret-in-receipt');
    fs.writeSync(this.fd, line + '\n');
    fs.fsyncSync(this.fd);
    this.entries.push(full);
    this.last = sha256(line);
    return full;
  }
  close(): void { if (this.fd >= 0) { fs.closeSync(this.fd); this.fd = -1; } }
}

/**
 * `blocked`: an intent with no recorded outcome (crash), an uncertain outcome or a 409; never re-sent, only reconciled
 * by exact inspection. `not-sent` (ForwardAuth refused) and definitive 4xx rejections committed nothing.
 */
export type Prior = 'none' | 'succeeded' | 'blocked' | 'reconciled';
export function priorState(entries: readonly Json[], intentId: string): Prior {
  let state: Prior = 'none';
  for (const e of entries) {
    if (e.intentId !== intentId) continue;
    if (e.kind === 'intent') state = 'blocked';
    else if (e.kind === 'outcome') state = e.outcome === 'succeeded' ? 'succeeded' : e.outcome === 'not-sent' || e.outcome === 'rejected' ? 'none' : 'blocked';
    else if (e.kind === 'reconciled') state = 'reconciled';
  }
  return state;
}
export const datasetIntentId = (plan: PublishPlan) =>
  digest({ op: 'create-dataset', method: 'POST', path: plan.datasetCreate.path, bodySha256: plan.datasetCreate.bodySha256, urn: DATASET_URN });
export const objectIntentId = (o: PublishPlan['objects'][number]) =>
  digest({ op: 'upload-object', method: o.method, path: o.path, logicalPath: o.logicalPath, sha256: o.sha256, bytes: o.bytes });

const PLATFORM_FORMS = [DATASET_PLATFORM, `urn:li:dataPlatform:${DATASET_PLATFORM}`];
export function datasetMismatch(plan: PublishPlan, dataset: unknown, workroomId: string): string | null {
  if (!isRecord(dataset)) return 'dataset-shape';
  if (dataset.urn !== DATASET_URN || dataset.name !== DATASET_NAME || !PLATFORM_FORMS.includes(dataset.platform)
    || dataset.environment !== DATASET_ENVIRONMENT) return 'dataset-identity-mismatch';
  const properties = isRecord(dataset.properties) ? dataset.properties : {};
  for (const [key, value] of Object.entries(plan.datasetCreate.body.properties)) if (properties[key] !== value) return 'unrelated-dataset';
  if (dataset.writable !== true) return 'dataset-not-writable';
  const binding = dataset.storage_binding;
  if (!isRecord(binding) || binding.backend !== 'file') return 'dataset-storage-backend';
  if (binding.state !== 'ready') return 'dataset-storage-not-ready';
  if (dataset.workroom_id !== workroomId || binding.workroom_id !== workroomId || binding.scope !== 'workroom') return 'dataset-workroom-scope';
  return null;
}

export interface DatasetObservation { byUrnStatus: number | null; dataset?: unknown; listed: unknown[] }
export type Decision<T> = T | { action: 'stop'; code: string };
const stop = (code: string) => ({ action: 'stop' as const, code });

export function decideDataset(plan: PublishPlan, obs: DatasetObservation, prior: Prior, workroomId: string): Decision<{ action: 'create' | 'adopt' }> {
  if (obs.byUrnStatus === 200) {
    const mismatch = datasetMismatch(plan, obs.dataset, workroomId);
    return mismatch ? stop(mismatch) : { action: 'adopt' };
  }
  if (obs.byUrnStatus !== 404) return stop(`dataset-inspection-${obs.byUrnStatus ?? 'failed'}`);
  if (obs.listed.some(d => isRecord(d) && (d.name === DATASET_NAME || d.urn === DATASET_URN))) return stop('dataset-name-collision');
  if (prior === 'blocked') return stop('prior-dataset-create-unresolved');
  if (prior !== 'none') return stop('dataset-missing-after-create');
  return { action: 'create' };
}

export interface ObjectStep { logicalPath: string; action: 'upload' | 'verify'; prior: Prior; item?: Json }
export const isObjectItem = (i: unknown): i is Json => isRecord(i) && typeof i.item_id === 'string' && UUID.test(i.item_id)
  && typeof i.logical_path === 'string' && Number.isSafeInteger(i.size_bytes) && typeof i.state === 'string' && typeof i.etag === 'string';

export function decideObjects(plan: PublishPlan, items: unknown[], priors: ReadonlyMap<string, Prior>): Decision<{ action: 'proceed'; steps: ObjectStep[] }> {
  if (!items.every(isObjectItem)) return stop('object-item-shape');
  const listed = items as Json[];
  if (listed.some(i => !plan.objects.some(o => o.logicalPath === i.logical_path))) return stop('unexpected-dataset-object');
  const steps: ObjectStep[] = [];
  for (const o of plan.objects) {
    const here = listed.filter(i => i.logical_path === o.logicalPath), live = here.filter(i => i.state === 'live');
    const prior = priors.get(o.logicalPath) ?? 'none';
    if (live.length > 1 || here.some(i => i.state !== 'live' && i.state !== 'tombstoned')) return stop('object-state-ambiguous');
    if (here.some(i => i.state === 'tombstoned')) return stop('tombstoned-object-at-path');
    if (live.length === 1) {
      if (live[0].size_bytes !== o.bytes) return stop('unrelated-object');
      steps.push({ logicalPath: o.logicalPath, action: 'verify', prior, item: live[0] });
    } else if (prior === 'blocked') return stop('prior-object-upload-unresolved');
    else if (prior !== 'none') return stop('object-missing-after-upload');
    else steps.push({ logicalPath: o.logicalPath, action: 'upload', prior });
  }
  return { action: 'proceed', steps };
}

// ---------------------------------------------------------------------------
// Signed Core transport (fresh ForwardAuth per exact target)
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface CoreSession { apiBase: string; apiPrefix: string; forwardedHost: string; subject: string; workroomId: string; token(): string }
export interface NativeEnv { fetch: FetchLike; session: CoreSession; calls: { count: number; cap: number } }
/** not-sent: ForwardAuth refused or failed, target untouched. uncertain: no response, body lost, 408 or 5xx; may have committed. */
export type Outcome = 'succeeded' | 'conflict' | 'rejected' | 'uncertain' | 'not-sent';
export interface CallSpec { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; json?: string; form?: FormData; maxBytes: number; timeoutMs?: number }
export interface CallResult { outcome: Outcome; status: number | null; body: Buffer | null; receipt: Json }

async function readCapped(response: Response, max: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > max) { await response.body?.cancel().catch(() => {}); throw new CheckFailure('response-too-large'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) { await reader.cancel().catch(() => {}); throw new CheckFailure('response-too-large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export async function signedCall(env: NativeEnv, spec: CallSpec): Promise<CallResult> {
  const { session } = env;
  check(SAFE_TARGET.test(spec.path) && !spec.path.includes('//') && !spec.path.includes('..'), 'unsafe-target-path');
  check(spec.json === undefined || spec.form === undefined, 'target-body-ambiguous');
  check(++env.calls.count <= env.calls.cap, 'native-call-cap');
  const target = spec.path + (spec.query ? `?${new URLSearchParams(spec.query)}` : '');
  const url = session.apiBase + target;
  check(new URL(url).href === url, 'target-uri-normalized');
  const token = session.token();
  check(typeof token === 'string' && token.length >= 16, 'session-token-missing');
  const started = performance.now();
  const receipt: Json = { method: spec.method, path: target, clientRequestId: randomUUID() };
  const finish = (outcome: Outcome, status: number | null, body: Buffer | null, code?: string): CallResult => {
    Object.assign(receipt, { outcome, status, latencyMs: Math.round(performance.now() - started), ...(code ? { code } : {}) });
    return { outcome, status, body, receipt };
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? 60_000);
  try {
    let validation: Response;
    try {
      validation = await env.fetch(`${session.apiBase}/auth/forward/validate`, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: buildForwardAuthHeaders({ token, method: spec.method, uri: session.apiPrefix + target,
          host: session.forwardedHost, proto: 'https', workroomId: session.workroomId }),
      });
    } catch { return finish('not-sent', null, null, 'forward-auth-network'); }
    await validation.body?.cancel().catch(() => {});
    if (validation.status !== 200) return finish('not-sent', null, null, `forward-auth-${validation.status}`);
    let signed: ReturnType<typeof extractSignedIdentity>;
    try { signed = extractSignedIdentity(validation.headers); } catch { return finish('not-sent', null, null, 'forward-auth-unsigned'); }
    Object.assign(receipt, { signatureTs: signed.signatureTs, signedHeaderNames: Object.keys(signed.forwardHeaders).sort(),
      signedIdentity: { userId: signed.identity.userId, workroomId: signed.identity.workroomId, workroomRole: signed.identity.workroomRole, roles: signed.identity.roles } });
    if (signed.identity.userId !== session.subject || signed.identity.workroomId !== session.workroomId)
      return finish('not-sent', null, null, 'signed-identity-scope');
    if (controller.signal.aborted) return finish('not-sent', null, null, 'timeout-before-target');
    // Bearer plus every signed identity header copied unchanged; multipart boundaries come from fetch.
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}`, ...signed.forwardHeaders };
    if (spec.json !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await env.fetch(url, { method: spec.method, headers, body: spec.json ?? spec.form, redirect: 'error', credentials: 'omit', signal: controller.signal });
    } catch { return finish('uncertain', null, null, 'target-no-response'); }
    receipt.requestId = response.headers.get('x-request-id');
    const status = response.status;
    let body: Buffer;
    try { body = await readCapped(response, spec.maxBytes); } catch (error) {
      return finish('uncertain', status, null, error instanceof CheckFailure ? error.message : 'target-body-unreadable');
    }
    if (status >= 200 && status < 300) return finish('succeeded', status, body);
    if (status === 409) return finish('conflict', status, null, 'http-409');
    if (status === 408 || status >= 500) return finish('uncertain', status, null, `http-${status}`);
    return finish('rejected', status, body, `http-${status}`);
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export interface PublishReport {
  status: 'published' | 'already-published' | 'stopped'; code?: string; phase: string; runId: string; planSha256: string;
  datasetUrn: string; subject: string; workroomId: string; nativeCalls: number;
  mutations: { datasetCreated: boolean; objectsUploaded: string[] };
  verified: { dataset?: Json; objects: Json[] };
  catalog: CatalogSummary; notes: string[]; ontologyEdgesClaimed: false; modelCalls: 0;
}

export async function publishCatalog(opts: { env: NativeEnv; ledger: ReceiptLedger; plan: PublishPlan; handoff: VerifiedHandoff; runId?: string }): Promise<PublishReport> {
  const { env, ledger, plan, handoff } = opts, { session } = env, runId = opts.runId ?? randomUUID();
  check(plan.handoff.manifestSha256 === handoff.manifestSha256, 'plan-handoff-mismatch');
  let phase = 'start';
  const mutations = { datasetCreated: false, objectsUploaded: [] as string[] };
  const verified: PublishReport['verified'] = { objects: [] }, notes: string[] = [];
  const log = (entry: Json) => ledger.append({ runId, phase, ...entry }, [session.token()]);
  const read = async (spec: CallSpec) => { const r = await signedCall(env, spec); log({ kind: 'read', ...r.receipt }); return r; };
  const mutate = async (intent: Json, spec: CallSpec) => {
    log({ kind: 'intent', ...intent });
    const r = await signedCall(env, spec);
    log({ kind: 'outcome', intentId: intent.intentId, ...r.receipt });
    return r;
  };
  const inspectDataset = async (): Promise<DatasetObservation> => {
    const byUrn = await read({ method: 'GET', path: '/catalog/datasets/by-urn', query: { urn: DATASET_URN }, maxBytes: 1 << 20 });
    check(byUrn.outcome === 'succeeded' || byUrn.status === 404, `dataset-inspection-${byUrn.receipt.code ?? byUrn.status}`);
    const listed = await read({ method: 'GET', path: '/catalog/datasets/', query: { query: DATASET_NAME }, maxBytes: 8 << 20 });
    check(listed.outcome === 'succeeded', `dataset-list-${listed.receipt.code ?? listed.outcome}`);
    const items = parseJsonBytes(listed.body, 'dataset-list-json');
    check(Array.isArray(items), 'dataset-list-shape');
    return { byUrnStatus: byUrn.status, dataset: byUrn.status === 200 ? parseJsonBytes(byUrn.body, 'dataset-json') : undefined, listed: items };
  };
  const listObjects = async (): Promise<unknown[]> => {
    const r = await read({ method: 'GET', path: objectsPath(), query: { state: 'all' }, maxBytes: 1 << 20 });
    check(r.outcome === 'succeeded', `object-list-${r.receipt.code ?? r.outcome}`);
    const items = parseJsonBytes(r.body, 'object-list-json');
    check(Array.isArray(items), 'object-list-shape');
    return items;
  };
  const report = (status: PublishReport['status'], code?: string): PublishReport => ({
    status, ...(code ? { code } : {}), phase, runId, planSha256: plan.planSha256, datasetUrn: DATASET_URN, subject: session.subject,
    workroomId: session.workroomId, nativeCalls: env.calls.count, mutations, verified, catalog: handoff.summary, notes,
    ontologyEdgesClaimed: false, modelCalls: 0,
  });

  log({ kind: 'run-start', planSha256: plan.planSha256, manifestSha256: handoff.manifestSha256, subject: session.subject,
    workroomId: session.workroomId, datasetUrn: DATASET_URN });
  try {
    phase = 'inspect-dataset';
    const createIntent = { intentId: datasetIntentId(plan), op: 'create-dataset', method: 'POST', path: plan.datasetCreate.path,
      bodySha256: plan.datasetCreate.bodySha256, datasetUrn: DATASET_URN, storageBackend: 'file', writable: true };
    const createPrior = priorState(ledger.entries, createIntent.intentId);
    const dataset = decideDataset(plan, await inspectDataset(), createPrior, session.workroomId);
    if (dataset.action === 'stop') throw new CheckFailure(dataset.code);
    if (dataset.action === 'create') {
      phase = 'create-dataset';
      const json = JSON.stringify(plan.datasetCreate.body);
      assertDatasetCreateBody(plan.datasetCreate.body);
      check(sha256(json) === plan.datasetCreate.bodySha256, 'plan-body-changed');
      const created = await mutate(createIntent, { method: 'POST', path: plan.datasetCreate.path, json, maxBytes: 8192 });
      check(created.outcome === 'succeeded', `dataset-create-${created.outcome}`);
      check(created.status === 201 && parseJsonBytes(created.body, 'dataset-create-json') === DATASET_URN, 'dataset-create-unexpected-urn');
      mutations.datasetCreated = true;
    } else if (createPrior === 'blocked') log({ kind: 'reconciled', intentId: createIntent.intentId, result: 'dataset-matches-plan' });

    phase = 'confirm-dataset';
    const confirmed = await inspectDataset();
    const confirmation = decideDataset(plan, confirmed, 'succeeded', session.workroomId);
    check(confirmation.action === 'adopt', confirmation.action === 'stop' ? confirmation.code : 'dataset-not-visible-after-create');

    phase = 'inspect-objects';
    const priors = new Map(plan.objects.map(o => [o.logicalPath, priorState(ledger.entries, objectIntentId(o))] as const));
    const objects = decideObjects(plan, await listObjects(), priors);
    if (objects.action === 'stop') throw new CheckFailure(objects.code);
    for (const step of objects.steps) {
      const planned = plan.objects.find(o => o.logicalPath === step.logicalPath)!;
      const file = handoff.uploads.find(f => f.name === step.logicalPath)!;
      const intentId = objectIntentId(planned);
      check(file.size === planned.bytes && sha256(file.bytes) === planned.sha256, 'upload-bytes-changed');
      let item = step.item;
      if (step.action === 'upload') {
        phase = `upload:${planned.logicalPath}`;
        const form = buildObjectForm(file);
        const uploaded = await mutate({ intentId, op: 'upload-object', method: planned.method, path: planned.path, logicalPath: planned.logicalPath,
          contentType: planned.contentType, bytes: planned.bytes, sha256: planned.sha256, multipartFields: MULTIPART_FIELDS },
        { method: 'POST', path: planned.path, form, maxBytes: 64 << 10, timeoutMs: 120_000 });
        check(uploaded.outcome === 'succeeded', `object-upload-${uploaded.outcome}`);
        item = parseJsonBytes(uploaded.body, 'object-upload-json');
        check(uploaded.status === 201 && isObjectItem(item) && item.logical_path === planned.logicalPath && item.size_bytes === planned.bytes
          && item.state === 'live', 'object-upload-response-mismatch');
        mutations.objectsUploaded.push(planned.logicalPath);
      }
      phase = `verify:${planned.logicalPath}`;
      const content = await read({ method: 'GET', path: `${planned.path}/${item!.item_id}/content`, maxBytes: planned.bytes, timeoutMs: 120_000 });
      check(content.outcome === 'succeeded' && content.status === 200, `object-content-${content.receipt.code ?? content.outcome}`);
      const actualSha256 = sha256(content.body!), matches = actualSha256 === planned.sha256 && content.body!.length === planned.bytes;
      const record = { logicalPath: planned.logicalPath, itemId: item!.item_id, bytes: content.body!.length, expectedSha256: planned.sha256,
        actualSha256, etag: item!.etag, etagMatchesSha256: item!.etag === `sha256:${planned.sha256}`, contentVerified: matches, action: step.action };
      log({ kind: 'verification', intentId, ...record });
      check(matches, step.action === 'upload' ? 'uploaded-object-bytes-mismatch' : 'unrelated-object-bytes');
      if (step.action === 'verify' && step.prior === 'blocked') log({ kind: 'reconciled', intentId, result: 'object-bytes-match-plan' });
      if (!record.etagMatchesSha256) notes.push(`etag for ${planned.logicalPath} is not sha256:<content hash>; bytes were verified by content fetch instead`);
      verified.objects.push(record);
    }

    phase = 'final-verify';
    const final = await inspectDataset();
    const finalDecision = decideDataset(plan, final, 'succeeded', session.workroomId);
    check(finalDecision.action === 'adopt', finalDecision.action === 'stop' ? finalDecision.code : 'final-dataset');
    const finalItems = (await listObjects()) as Json[];
    check(finalItems.every(isObjectItem), 'object-item-shape');
    const live = finalItems.filter(i => i.state === 'live');
    check(live.length === finalItems.length && stable(live.map(i => i.logical_path).sort()) === stable(plan.objects.map(o => o.logicalPath).sort()), 'final-object-set');
    for (const i of live) {
      const v = verified.objects.find(o => o.logicalPath === i.logical_path);
      check(v && v.itemId === i.item_id && v.bytes === i.size_bytes, 'final-object-changed');
    }
    const ds = final.dataset as Json;
    verified.dataset = { urn: ds.urn, name: ds.name, platform: ds.platform, environment: ds.environment, writable: ds.writable,
      storageBackend: ds.storage_binding.backend, storageState: ds.storage_binding.state, storageScope: ds.storage_binding.scope,
      workroomScoped: true, contentRevision: ds.content_revision ?? null, propertiesMatchPlan: true };
    const status = mutations.datasetCreated || mutations.objectsUploaded.length ? 'published' : 'already-published';
    log({ kind: 'run-complete', status, mutations, objectsVerified: verified.objects.length, contentRevision: verified.dataset.contentRevision });
    return report(status);
  } catch (error) {
    const code = error instanceof CheckFailure ? error.message : 'publisher-internal-error';
    log({ kind: 'run-stop', code, mutations });
    return report('stopped', code);
  }
}

// ---------------------------------------------------------------------------
// Offline Core double (self-test and tests only; never used by --apply)
// ---------------------------------------------------------------------------

export type Fault = 'throw' | 'commit-then-throw' | number | undefined;
export function createOfflineCore(opts: { subject: string; workroomId: string; token: string; fault?: (method: string, route: string) => Fault }) {
  const apiBase = 'http://core.offline.test/api';
  const signed: Record<string, string> = { 'x-user-id': opts.subject, 'x-user-name': 'offline-owner', 'x-user-roles': 'user',
    'x-workroom-id': opts.workroomId, 'x-user-workroom-role': 'owner', 'x-user-signature': 'offline-signature', 'x-user-signature-ts': '1700000000' };
  const state = { datasets: new Map<string, Json>(), objects: [] as Json[], validations: 0, targets: 0, unsignedTargets: 0,
    mutations: [] as string[], forwarded: [] as { method: string; uri: string }[] };
  let pending: { method: string; uri: string } | null = null, seq = 0;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => new Response(
    body === undefined ? null : body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', 'x-request-id': `offline-${++seq}`, ...headers } });
  const OBJECTS = /^\/api\/catalog\/datasets\/v2\/([^/]+)\/objects(?:\/([0-9a-f-]{36})\/content)?$/;

  async function route(method: string, url: URL, init: RequestInit): Promise<Response> {
    const p = url.pathname;
    if (method === 'GET' && p === '/api/catalog/datasets/by-urn') {
      const ds = state.datasets.get(url.searchParams.get('urn') ?? '');
      return ds ? reply(200, ds) : reply(404, { detail: 'dataset_not_found' });
    }
    if (method === 'GET' && p === '/api/catalog/datasets/')
      return reply(200, [...state.datasets.values()].filter(d => d.name.includes(url.searchParams.get('query') ?? '')));
    if (method === 'POST' && p === '/api/catalog/datasets/') {
      const body = JSON.parse(String(init.body));
      const urn = `urn:li:dataset:(urn:li:dataPlatform:${body.platform},${body.name},${body.environment})`;
      if (state.datasets.has(urn)) return reply(409, { detail: 'exists' });
      const { storage, ...rest } = body;
      state.datasets.set(urn, { ...rest, urn, workroom_id: opts.workroomId, content_revision: 0, storage_binding: { version: 1, binding_id: randomUUID(),
        backend: storage?.backend ?? 'object', scope: 'workroom', workroom_id: opts.workroomId, locator: { root_id: 'managed', relative_path: 'opaque' },
        state: 'ready', created_at: new Date(0).toISOString() } });
      state.mutations.push(`dataset:${urn}`);
      return reply(201, urn);
    }
    const match = OBJECTS.exec(p);
    const ds = match ? state.datasets.get(decodeURIComponent(match[1])) : undefined;
    if (!match || !ds) return reply(404, { detail: 'not_found' });
    const inDataset = state.objects.filter(o => o.urn === ds.urn);
    const view = ({ bytes: _bytes, urn: _urn, ...item }: Json) => item;
    if (method === 'GET' && !match[2]) {
      const which = url.searchParams.get('state') ?? 'live';
      return reply(200, inDataset.filter(o => which === 'all' || o.state === which).map(view));
    }
    if (method === 'GET' && match[2]) {
      const item = inDataset.find(o => o.item_id === match[2] && o.state === 'live');
      return item ? reply(200, item.bytes, { 'content-type': item.content_type, etag: item.etag }) : reply(404, { detail: 'not_found' });
    }
    if (method === 'POST' && !match[2]) {
      const form = init.body;
      if (!(form instanceof FormData) || stable([...form.keys()]) !== stable(MULTIPART_FIELDS)) return reply(422, { detail: 'multipart' });
      const file = form.get('file') as Blob, logicalPath = String(form.get('logical_path'));
      if (inDataset.some(o => o.logical_path === logicalPath && o.state === 'live')) return reply(409, { detail: 'exists' });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const item = { urn: ds.urn, bytes, item_id: randomUUID(), logical_path: logicalPath, item_revision: 1, dataset_revision: ++ds.content_revision,
        etag: `sha256:${sha256(bytes)}`, size_bytes: bytes.length, content_type: file.type || null, state: 'live', created_by: opts.subject };
      state.objects.push(item);
      state.mutations.push(`object:${logicalPath}`);
      return reply(201, view(item));
    }
    return reply(405, { detail: 'method' });
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = (init.headers ?? {}) as Record<string, string>;
    if (url.pathname === '/api/auth/forward/validate') {
      state.validations++;
      if (headers.authorization !== `Bearer ${opts.token}`) return reply(401, { detail: 'unauthenticated' });
      pending = { method: headers['x-forwarded-method'], uri: headers['x-forwarded-uri'] };
      state.forwarded.push(pending);
      return new Response(null, { status: 200, headers: signed });
    }
    state.targets++;
    const fresh = pending;
    pending = null;
    if (!fresh || fresh.method !== method || fresh.uri !== url.pathname + url.search || headers.authorization !== `Bearer ${opts.token}`
      || Object.entries(signed).some(([k, v]) => headers[k] !== v)) { state.unsignedTargets++; return reply(401, { detail: 'unsigned' }); }
    const logical = init.body instanceof FormData ? `:${init.body.get('logical_path')}` : '';
    const fault = opts.fault?.(method, url.pathname.replace(/^\/api/, '') + logical);
    if (fault === 'throw') throw new TypeError('fetch failed');
    if (typeof fault === 'number') return reply(fault, { detail: 'injected' });
    const response = await route(method, url, init);
    if (fault === 'commit-then-throw') { await response.body?.cancel(); throw new TypeError('fetch failed'); }
    return response;
  };

  const env = (cap = CALL_CAP): NativeEnv => ({ fetch: fetchImpl, calls: { count: 0, cap },
    session: { apiBase, apiPrefix: '/api', forwardedHost: FORWARDED_HOST, subject: opts.subject, workroomId: opts.workroomId, token: () => opts.token } });
  return { state, env, fetch: fetchImpl, apiBase };
}

export async function selfTest(): Promise<Json> {
  const handoff = validateHandoff(), plan = buildPlan(handoff, readRegular(path.dirname(OPENAPI_FILE), path.basename(OPENAPI_FILE)));
  assert.equal(buildPlan(handoff, readRegular(path.dirname(OPENAPI_FILE), path.basename(OPENAPI_FILE))).planSha256, plan.planSha256);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-catalog-publisher-')));
  const token = 'offline-session-token-0123456789';
  try {
    const core = createOfflineCore({ subject: randomUUID(), workroomId: randomUUID(), token });
    const run = async () => {
      const ledger = ReceiptLedger.open(path.join(tmp, 'ledger'));
      try { return await publishCatalog({ env: core.env(), ledger, plan, handoff }); } finally { ledger.close(); }
    };
    const first = await run();
    assert.equal(first.status, 'published', first.code);
    assert.equal(core.state.mutations.length, 6);
    const second = await run();
    assert.equal(second.status, 'already-published', second.code);
    assert.equal(core.state.mutations.length, 6);
    assert.equal(core.state.unsignedTargets, 0);
    assert.equal(core.state.validations, core.state.targets);
    assert.ok(!fs.readFileSync(path.join(tmp, 'ledger', 'receipts.jsonl'), 'utf8').includes(token));
    return { selfTest: 'passed', planSha256: plan.planSha256, objectsVerified: second.verified.objects.length, networkCalls: 0, modelCalls: 0 };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCliArgs(args: readonly string[]): { mode: 'plan' | 'apply' | 'self-test'; out?: string } {
  const modes = args.filter(a => ['--plan', '--apply', '--self-test'].includes(a));
  check(modes.length <= 1, 'usage-one-mode');
  const mode = modes[0] === '--apply' ? 'apply' : modes[0] === '--self-test' ? 'self-test' : 'plan';
  const rest = args.filter(a => !modes.includes(a));
  if (rest.length === 0) return { mode };
  check(mode === 'plan' && rest.length === 2 && rest[0] === '--out', 'usage-unknown-argument');
  const out = rest[1];
  check(/^evidence\/[A-Za-z0-9._/-]+\.json$/.test(out) && !out.includes('..') && !out.includes('//'), 'usage-out-path');
  return { mode, out };
}

function writeOnceOrIdentical(file: string, text: string): void {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat) { check(stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(file, 'utf8') === text, 'plan-file-conflict'); return; }
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}

export async function ownerSession(binding: Json) {
  check(isRecord(binding) && typeof binding.apiBase === 'string' && typeof binding.workroom?.id === 'string' && UUID.test(binding.workroom.id), 'binding-shape');
  let token = '', entered = false;
  const core = new KamiwazaClient({ apiBase: binding.apiBase, getToken: () => token, forwardedHost: FORWARDED_HOST, timeoutMs: 15000 });
  let raw = execFileSync('podman', ['machine', 'ssh', 'kamiwaza-harness-poc',
    `sudo k0s kubectl get secret kamiwaza-user-${OWNER_USERNAME} -n kamiwaza -o jsonpath='{.data.password}'`],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
  let password = Buffer.from(raw.trim(), 'base64').toString('utf8');
  raw = '';
  try {
    token = (await core.login({ username: OWNER_USERNAME, password })).data.access_token;
    password = '';
    const result = await core.enterWorkroom(binding.workroom.id);
    entered = true;
    if (result.data.access_token) token = result.data.access_token;
    const me = await core.me();
    check(me.identity.workroomId === binding.workroom.id, 'owner-workroom-scope');
    const session: CoreSession = { apiBase: core.apiBase, apiPrefix: core.apiPrefix, forwardedHost: core.forwardedHost,
      subject: me.identity.userId, workroomId: binding.workroom.id, token: () => token };
    return { session, identity: { subject: me.identity.userId, roles: me.identity.roles, workroomRole: me.identity.workroomRole },
      async close() { try { if (entered) await core.leaveWorkroom(); } finally { token = ''; } } };
  } catch (error) {
    if (entered) try { await core.leaveWorkroom(); } catch { /* token is cleared below */ }
    token = '';
    throw error;
  } finally { password = ''; }
}

async function apply(): Promise<PublishReport | Json> {
  const handoff = validateHandoff();
  const plan = buildPlan(handoff, readRegular(path.dirname(OPENAPI_FILE), path.basename(OPENAPI_FILE)));
  fs.mkdirSync(LEDGER_DIR, { recursive: true, mode: 0o700 });
  check(fs.realpathSync(LEDGER_DIR) === path.resolve(LEDGER_DIR), 'ledger-symlinked-path');
  const lock = path.join(LEDGER_DIR, 'apply.lock');
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch { throw new CheckFailure('publisher-lock-present'); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    writeOnceOrIdentical(path.join(LEDGER_DIR, `plan-${plan.planSha256.slice(0, 16)}.json`), JSON.stringify(plan, null, 2) + '\n');
    const ledger = ReceiptLedger.open(LEDGER_DIR);
    let result: PublishReport | Json;
    try {
      result = await ownerPublish(ledger, plan, handoff);
    } finally { ledger.close(); }
    fs.writeFileSync(path.join(LEDGER_DIR, `run-${stamp}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return result;
  } finally { fs.closeSync(lockFd); fs.rmSync(lock, { force: true }); }
}

async function ownerPublish(ledger: ReceiptLedger, plan: PublishPlan, handoff: VerifiedHandoff): Promise<PublishReport | Json> {
  let owner: Awaited<ReturnType<typeof ownerSession>>;
  try { owner = await ownerSession(JSON.parse(fs.readFileSync('data/kamiwaza-binding.json', 'utf8'))); } catch (error) {
    const code = error instanceof CheckFailure ? error.message : 'owner-login-failed';
    ledger.append({ kind: 'login-failed', code, planSha256: plan.planSha256 });
    return { status: 'stopped', code, phase: 'owner-login', planSha256: plan.planSha256, nativeMutations: 0, modelCalls: 0 };
  }
  let result: PublishReport | undefined;
  try {
    ledger.append({ kind: 'owner-session', subject: owner.identity.subject, roles: owner.identity.roles, workroomRole: owner.identity.workroomRole,
      username: OWNER_USERNAME, adminLogin: false }, [owner.session.token()]);
    result = await publishCatalog({ env: { fetch: (url, init) => fetch(url, init), session: owner.session, calls: { count: 0, cap: CALL_CAP } }, ledger, plan, handoff });
    return result;
  } finally {
    try { await owner.close(); }
    catch {
      ledger.append({ kind: 'owner-session-cleanup-failed', code: 'owner-leave-failed' });
      if (result) {
        result.status = 'stopped'; result.code = 'owner-leave-failed'; result.phase = 'owner-session-cleanup';
        result.notes.push('Publishing receipts retained; leaving the owner workroom session failed. Inspect session state before another native operation.');
      }
    }
  }
}

async function main(args: readonly string[]) {
  const cli = parseCliArgs(args);
  if (cli.mode === 'self-test') return selfTest();
  if (cli.mode === 'apply') return apply();
  const handoff = validateHandoff();
  const plan = buildPlan(handoff, readRegular(path.dirname(OPENAPI_FILE), path.basename(OPENAPI_FILE)));
  if (cli.out) fs.writeFileSync(cli.out, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'planned', planSha256: plan.planSha256, out: cli.out ?? null, plan, networkCalls: 0, modelCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result: Json = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'stopped') process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ status: 'rejected', code: error instanceof CheckFailure ? error.message : 'publisher-internal-error', networkMutations: process.argv.includes('--apply') ? 'inspect-retained-ledger' : 0, modelCalls: 0 }));
    process.exitCode = 1;
  }
}
