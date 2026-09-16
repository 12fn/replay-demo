import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALL_CAP, DATASET_URN, EXPECTED_MANIFEST_SHA256, HANDOFF_DIR, OPENAPI_FILE, ReceiptLedger,
  assertDatasetCreateBody, assertMultipartFields, assertNativeCatalogSupport, buildObjectForm, buildPlan, createOfflineCore,
  datasetIntentId, decideDataset, decideObjects, objectIntentId, objectsPath, parseCliArgs, priorState, publishCatalog,
  selfTest, signedCall, validateHandoff, type Fault, type NativeEnv, type Prior, type PublishPlan,
} from '../../scripts/platform/publish-preset-catalog';

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
// Independently authored contract fixture; no installed/private platform document is read.
const openapiBytes = fs.readFileSync('tests/fixtures/synthetic-catalog-openapi.json');
const handoff = validateHandoff();
const plan = buildPlan(handoff, openapiBytes);
const TOKEN = 'offline-session-token-0123456789';
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-publisher-test-'))); temps.push(dir); return dir; };

function copyHandoff(): string {
  const dir = path.join(tempDir(), 'handoff');
  fs.mkdirSync(dir);
  for (const name of fs.readdirSync(HANDOFF_DIR)) fs.copyFileSync(path.join(HANDOFF_DIR, name), path.join(dir, name));
  return dir;
}
/** Re-exports a mutated catalog the way scripts/export-preset-catalog.ts does and returns the new manifest hash. */
function reexport(dir: string, mutate: (catalog: any) => void, derive = true): string {
  const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
  mutate(catalog);
  const files: Record<string, string> = { 'catalog.json': JSON.stringify(catalog, null, 2) + '\n' };
  if (derive) {
    files['records.jsonl'] = catalog.records.map((r: any) => JSON.stringify(r)).join('\n') + '\n';
    files['relationships.jsonl'] = catalog.records.flatMap((r: any) => r.links.map((l: any) => JSON.stringify({ from: r.id, relation: l.relation, to: l.targetId, aorId: r.aorId }))).join('\n') + '\n';
    files['sources.json'] = JSON.stringify(catalog.sources, null, 2) + '\n';
  }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return rewriteManifest(dir, m => m);
}
function rewriteManifest(dir: string, mutate: (manifest: any) => any): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.files = manifest.files.map((f: any) => {
    const bytes = fs.readFileSync(path.join(dir, f.name));
    return { name: f.name, bytes: bytes.length, sha256: sha(bytes) };
  });
  const text = JSON.stringify(mutate(manifest), null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'manifest.json'), text);
  return sha(text);
}
const failure = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as Error).message; } return 'no-error'; };

describe('immutable handoff validation', () => {
  it('accepts the pinned public synthetic export and records schema, provenance and counts', () => {
    expect(handoff.manifestSha256).toBe(EXPECTED_MANIFEST_SHA256);
    expect(handoff.summary).toMatchObject({ schema: 'replay.preset-catalog/1', version: 'preset-catalog/1', records: 1752, relationships: 6801,
      provenance: { synthetic: 1749, 'public-reference': 3 }, aors: ['taiwan', 'caribbean', 'hormuz'], sources: 4 });
    expect(handoff.summary.counts).toMatchObject({ report: 648, event: 864, persona: 36 });
    expect(handoff.uploads.map(f => f.name)).toEqual(['catalog.json', 'records.jsonl', 'relationships.jsonl', 'sources.json', 'manifest.json']);
    for (const f of handoff.uploads) expect(sha(fs.readFileSync(path.join(HANDOFF_DIR, f.name)))).toBe(f.sha256);
  });

  it('rejects a same-length byte flip in a hashed file', () => {
    const dir = copyHandoff(), file = path.join(dir, 'records.jsonl'), bytes = fs.readFileSync(file);
    bytes[10] = bytes[10] === 0x61 ? 0x62 : 0x61;
    fs.writeFileSync(file, bytes);
    expect(failure(() => validateHandoff(dir))).toBe('manifest-hash-mismatch:records.jsonl');
  });

  it('rejects a manifest that is not the pinned trust anchor', () => {
    const dir = copyHandoff();
    rewriteManifest(dir, m => ({ ...m, total: m.total }));
    fs.appendFileSync(path.join(dir, 'manifest.json'), ' ');
    expect(failure(() => validateHandoff(dir))).toBe('manifest-sha256-mismatch');
  });

  it('rejects extra entries, symlinked files and symlinked directories', () => {
    const extra = copyHandoff();
    fs.writeFileSync(path.join(extra, 'notes.txt'), 'x');
    expect(failure(() => validateHandoff(extra))).toBe('handoff-unexpected-entries');

    const linked = copyHandoff(), outside = path.join(path.dirname(linked), 'outside.json');
    fs.renameSync(path.join(linked, 'sources.json'), outside);
    fs.symlinkSync(outside, path.join(linked, 'sources.json'));
    expect(failure(() => validateHandoff(linked))).toBe('symlink-or-special-file');

    const real = copyHandoff(), alias = path.join(tempDir(), 'alias');
    fs.symlinkSync(real, alias);
    expect(failure(() => validateHandoff(alias))).toBe('handoff-directory');
    const viaLink = path.join(tempDir(), 'link');
    fs.symlinkSync(path.dirname(real), viaLink);
    expect(failure(() => validateHandoff(path.join(viaLink, 'handoff')))).toBe('handoff-symlinked-path');
  });

  it('rejects traversal names and unexpected fields in the manifest', () => {
    const traversal = copyHandoff();
    const pinned = rewriteManifest(traversal, m => ({ ...m, files: m.files.map((f: any) => f.name === 'sources.json' ? { ...f, name: '../sources.json' } : f) }));
    expect(failure(() => validateHandoff(traversal, pinned))).toBe('manifest-unsafe-file-name');

    const extraField = copyHandoff();
    const pinned2 = rewriteManifest(extraField, m => ({ ...m, uploadPath: '/var/data' }));
    expect(failure(() => validateHandoff(extraField, pinned2))).toBe('manifest-keys');
  });

  it('rejects the wrong schema version even when every hash is consistent', () => {
    const dir = copyHandoff();
    const pinned = reexport(dir, c => { c.schema = 'replay.preset-catalog/2'; });
    expect(failure(() => validateHandoff(dir, pinned))).toBe('catalog-schema-version');
  });

  it('rejects derived files that disagree with catalog.json and dangling links', () => {
    const drift = copyHandoff();
    const pinned = reexport(drift, c => { c.records[0].title = 'Changed only in catalog.json'; }, false);
    expect(failure(() => validateHandoff(drift, pinned))).toBe('records-jsonl-mismatch');

    const dangling = copyHandoff();
    const pinned2 = reexport(dangling, c => { c.records.find((r: any) => r.links.length).links[0].targetId = 'taiwan/asset/missing'; });
    expect(failure(() => validateHandoff(dangling, pinned2))).toBe('catalog-link-target');
  });
});

describe('native plan against a synthetic catalog schema (not an installation qualification)', () => {
  it('is deterministic and registers exactly one writable DEV dataset with platform-managed file storage', () => {
    expect(buildPlan(validateHandoff(), openapiBytes).planSha256).toBe(plan.planSha256);
    const body = plan.datasetCreate.body;
    expect(Object.keys(body).sort()).toEqual(['dataset_schema', 'description', 'environment', 'name', 'platform', 'properties', 'storage', 'tags', 'writable']);
    expect(body).toMatchObject({ name: 'replay-preset-catalog-1', platform: 'kamiwaza', environment: 'DEV', writable: true, storage: { backend: 'file' } });
    expect(body.properties).toMatchObject({ 'replay.classification': 'PUBLIC SYNTHETIC', 'replay.records': '1752', 'replay.relationships': '6801',
      'replay.manifest_sha256': EXPECTED_MANIFEST_SHA256, 'replay.relationships_are_ontology_edges': 'false', 'replay.llm_ingestion': 'false' });
    expect(Object.values(body.properties).every(v => typeof v === 'string')).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/locator|relative_path|root_id|container_urn|gate/);
    expect(plan.datasetCreate.bodySha256).toBe(sha(JSON.stringify(body)));
    expect(plan.native.storageBackendsAdvertised).toContain('file');
    expect(plan.objects.map(o => o.path)).toEqual(Array(5).fill(`/catalog/datasets/v2/${encodeURIComponent(DATASET_URN)}/objects`));
    expect(plan.requestSequence.join('\n')).not.toMatch(/\b(PUT|PATCH|DELETE)\b/);
    expect(plan.guarantees).toMatchObject({ retryUncertainPost: false, adminElevation: false, ontologyEdges: false, modelCalls: 0 });
  });

  it('reports unsupported native schema explicitly', () => {
    const openapi = JSON.parse(openapiBytes.toString('utf8'));
    const noFile = structuredClone(openapi);
    noFile.components.schemas.DatasetStorageRequest.properties.backend.anyOf[0].enum = ['object'];
    expect(failure(() => assertNativeCatalogSupport(noFile))).toBe('unsupported-storage-backend-file');
    const noContent = structuredClone(openapi);
    delete noContent.paths['/catalog/datasets/v2/{dataset_urn}/objects/{item_id}/content'];
    expect(failure(() => assertNativeCatalogSupport(noContent))).toBe('unsupported-native-endpoint:GET /catalog/datasets/v2/{dataset_urn}/objects/{item_id}/content');
    const extraMultipart = structuredClone(openapi);
    extraMultipart.components.schemas.Body_create_dataset_object_v2_catalog_datasets_v2__dataset_urn__objects_post.properties.storage_path = { type: 'string' };
    expect(failure(() => assertNativeCatalogSupport(extraMultipart))).toBe('unsupported-object-multipart-fields');
  });

  it('rejects extra or unsafe DatasetCreate fields', () => {
    const body = plan.datasetCreate.body;
    expect(failure(() => assertDatasetCreateBody({ ...body, container_urn: 'urn:x' }))).toBe('dataset-create-unexpected-fields');
    expect(failure(() => assertDatasetCreateBody({ ...body, storage: { backend: 'file', locator: { relative_path: '../x' } } }))).toBe('dataset-create-storage-fields');
    expect(failure(() => assertDatasetCreateBody({ ...body, storage: { backend: 'object' } }))).toBe('dataset-create-storage-backend');
    expect(failure(() => assertDatasetCreateBody({ ...body, writable: false }))).toBe('dataset-create-not-writable');
    expect(failure(() => assertDatasetCreateBody({ ...body, properties: { nested: { x: 1 } } }))).toBe('dataset-create-properties');
  });

  it('builds multipart uploads with only file and logical_path from verified bytes', async () => {
    const file = handoff.uploads[3];
    const form = buildObjectForm(file);
    expect([...form.keys()]).toEqual(['file', 'logical_path']);
    expect(form.get('logical_path')).toBe('sources.json');
    expect(sha(new Uint8Array(await (form.get('file') as Blob).arrayBuffer()))).toBe(file.sha256);
    form.set('storage_path', '/tmp');
    expect(failure(() => assertMultipartFields(form))).toBe('multipart-unexpected-fields');
    const tampered = { ...file, bytes: Buffer.from(file.bytes) };
    tampered.bytes[0] ^= 1;
    expect(failure(() => buildObjectForm(tampered))).toBe('upload-bytes-changed');
    expect(failure(() => buildObjectForm({ ...file, name: '../sources.json' }))).toBe('multipart-logical-path');
  });

  it('accepts only plan, apply or self-test and constrains --out', () => {
    expect(parseCliArgs([])).toEqual({ mode: 'plan' });
    expect(parseCliArgs(['--apply'])).toEqual({ mode: 'apply' });
    expect(parseCliArgs(['--plan', '--out', 'evidence/platform/catalog-plan.json'])).toEqual({ mode: 'plan', out: 'evidence/platform/catalog-plan.json' });
    expect(failure(() => parseCliArgs(['--plan', '--apply']))).toBe('usage-one-mode');
    expect(failure(() => parseCliArgs(['--apply', '--out', 'evidence/x.json']))).toBe('usage-unknown-argument');
    expect(failure(() => parseCliArgs(['--out', 'evidence/../data/x.json']))).toBe('usage-out-path');
    expect(failure(() => parseCliArgs(['--force']))).toBe('usage-unknown-argument');
  });
});

const WORKROOM = randomUUID();
function nativeDataset(overrides: Record<string, unknown> = {}) {
  return { urn: DATASET_URN, name: 'replay-preset-catalog-1', platform: 'kamiwaza', environment: 'DEV', writable: true,
    properties: { ...plan.datasetCreate.body.properties }, workroom_id: WORKROOM,
    storage_binding: { backend: 'file', state: 'ready', scope: 'workroom', workroom_id: WORKROOM }, ...overrides };
}
const objectItem = (logicalPath: string, bytes: number, state = 'live') =>
  ({ item_id: randomUUID(), logical_path: logicalPath, size_bytes: bytes, state, etag: 'sha256:x', item_revision: 1, dataset_revision: 1 });

describe('resume decisions', () => {
  it('creates only when absent, never after an unresolved attempt, and adopts only the exact dataset', () => {
    const absent = { byUrnStatus: 404, listed: [] };
    expect(decideDataset(plan, absent, 'none', WORKROOM)).toEqual({ action: 'create' });
    expect(decideDataset(plan, absent, 'blocked', WORKROOM)).toEqual({ action: 'stop', code: 'prior-dataset-create-unresolved' });
    expect(decideDataset(plan, absent, 'succeeded', WORKROOM)).toEqual({ action: 'stop', code: 'dataset-missing-after-create' });
    expect(decideDataset(plan, { byUrnStatus: 404, listed: [{ name: 'replay-preset-catalog-1', urn: 'urn:other' }] }, 'none', WORKROOM).action).toBe('stop');
    expect(decideDataset(plan, { byUrnStatus: 403, listed: [] }, 'none', WORKROOM)).toEqual({ action: 'stop', code: 'dataset-inspection-403' });
    const present = (dataset: unknown) => decideDataset(plan, { byUrnStatus: 200, dataset, listed: [] }, 'blocked', WORKROOM);
    expect(present(nativeDataset())).toEqual({ action: 'adopt' });
    expect(present(nativeDataset({ platform: 'urn:li:dataPlatform:kamiwaza' }))).toEqual({ action: 'adopt' });
    expect(present(nativeDataset({ properties: { 'replay.manifest_sha256': 'other' } }))).toEqual({ action: 'stop', code: 'unrelated-dataset' });
    expect(present(nativeDataset({ environment: 'PROD' }))).toEqual({ action: 'stop', code: 'dataset-identity-mismatch' });
    expect(present(nativeDataset({ writable: false }))).toEqual({ action: 'stop', code: 'dataset-not-writable' });
    expect(present(nativeDataset({ storage_binding: { backend: 'object', state: 'ready', scope: 'workroom', workroom_id: WORKROOM } }))).toEqual({ action: 'stop', code: 'dataset-storage-backend' });
    expect(present(nativeDataset({ workroom_id: randomUUID() }))).toEqual({ action: 'stop', code: 'dataset-workroom-scope' });
  });

  it('uploads absent objects, verifies same-size ones and refuses unrelated, tombstoned or unresolved paths', () => {
    const priors = (entries: [string, Prior][] = []) => new Map(entries);
    const sizes = Object.fromEntries(plan.objects.map(o => [o.logicalPath, o.bytes]));
    const steps = decideObjects(plan, [objectItem('catalog.json', sizes['catalog.json'])], priors());
    expect(steps.action === 'proceed' && steps.steps.map(s => `${s.logicalPath}:${s.action}`)).toEqual(
      ['catalog.json:verify', 'records.jsonl:upload', 'relationships.jsonl:upload', 'sources.json:upload', 'manifest.json:upload']);
    expect(decideObjects(plan, [objectItem('catalog.json', 1)], priors())).toEqual({ action: 'stop', code: 'unrelated-object' });
    expect(decideObjects(plan, [objectItem('notes.txt', 1)], priors())).toEqual({ action: 'stop', code: 'unexpected-dataset-object' });
    expect(decideObjects(plan, [objectItem('sources.json', sizes['sources.json'], 'tombstoned')], priors())).toEqual({ action: 'stop', code: 'tombstoned-object-at-path' });
    expect(decideObjects(plan, [objectItem('sources.json', 1), objectItem('sources.json', 1)], priors())).toEqual({ action: 'stop', code: 'object-state-ambiguous' });
    expect(decideObjects(plan, [], priors([['records.jsonl', 'blocked']]))).toEqual({ action: 'stop', code: 'prior-object-upload-unresolved' });
    expect(decideObjects(plan, [{ item_id: '../x', logical_path: 'catalog.json' }], priors())).toEqual({ action: 'stop', code: 'object-item-shape' });
  });

  it('treats a crash after intent, uncertain outcomes and conflicts as unresolved; refusals and 4xx as uncommitted', () => {
    const id = 'intent-1';
    expect(priorState([], id)).toBe('none');
    expect(priorState([{ kind: 'intent', intentId: id }], id)).toBe('blocked');
    for (const outcome of ['not-sent', 'rejected']) expect(priorState([{ kind: 'intent', intentId: id }, { kind: 'outcome', intentId: id, outcome }], id)).toBe('none');
    for (const outcome of ['uncertain', 'conflict']) expect(priorState([{ kind: 'intent', intentId: id }, { kind: 'outcome', intentId: id, outcome }], id)).toBe('blocked');
    expect(priorState([{ kind: 'intent', intentId: id }, { kind: 'outcome', intentId: id, outcome: 'succeeded' }], id)).toBe('succeeded');
    expect(priorState([{ kind: 'intent', intentId: id }, { kind: 'reconciled', intentId: id }], id)).toBe('reconciled');
    expect(datasetIntentId(plan)).toBe(datasetIntentId(buildPlan(validateHandoff(), openapiBytes)));
    expect(new Set(plan.objects.map(objectIntentId)).size).toBe(5);
  });
});

describe('append-only receipts', () => {
  it('hash-chains entries, reopens for resume and refuses tampering, torn writes and secrets', () => {
    const dir = path.join(tempDir(), 'ledger');
    const ledger = ReceiptLedger.open(dir);
    ledger.append({ kind: 'intent', intentId: 'a' });
    ledger.append({ kind: 'outcome', intentId: 'a', outcome: 'uncertain' });
    expect(failure(() => ledger.append({ kind: 'read', note: `Bearer ${TOKEN}` }, [TOKEN]))).toBe('secret-in-receipt');
    expect(failure(() => ledger.append({ seq: 9 }))).toBe('ledger-reserved-field');
    ledger.close();
    const reopened = ReceiptLedger.open(dir);
    expect(reopened.entries.map(e => e.seq)).toEqual([1, 2]);
    expect(priorState(reopened.entries, 'a')).toBe('blocked');
    reopened.close();

    const file = path.join(dir, 'receipts.jsonl');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('"intentId":"a"', '"intentId":"b"'));
    expect(failure(() => ReceiptLedger.open(dir))).toBe('ledger-chain-broken');
    fs.writeFileSync(file, original + '{"seq":3');
    expect(failure(() => ReceiptLedger.open(dir))).toBe('ledger-torn-write');
  });
});

describe('signed Core transport', () => {
  const SIGNED = { 'x-user-id': 'user-1', 'x-user-signature': 'sig-value', 'x-user-signature-ts': '42', 'x-workroom-id': WORKROOM, 'x-user-roles': 'user', 'x-user-workroom-role': 'owner' };
  function env(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, calls: { url: URL; init: RequestInit }[] = []): NativeEnv {
    return { calls: { count: 0, cap: 5 }, fetch: async (input, init) => { const url = new URL(input); calls.push({ url, init }); return handler(url, init); },
      session: { apiBase: 'http://core.test/api', apiPrefix: '/api', forwardedHost: 'kamiwaza-harness.localhost', subject: 'user-1', workroomId: WORKROOM, token: () => TOKEN } };
  }
  const validate = (url: URL) => url.pathname === '/api/auth/forward/validate' ? new Response(null, { status: 200, headers: SIGNED }) : null;

  it('validates the exact target URI and forwards bearer plus every signed identity header unchanged', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const result = await signedCall(env(url => validate(url) ?? new Response('[]', { status: 200, headers: { 'x-request-id': 'req-9' } }), calls),
      { method: 'GET', path: objectsPath(), query: { state: 'all' }, maxBytes: 100 });
    expect(result.outcome).toBe('succeeded');
    const auth = calls[0].init.headers as Record<string, string>, target = calls[1].init.headers as Record<string, string>;
    expect(auth['x-forwarded-uri']).toBe(`/api${objectsPath()}?state=all`);
    expect(auth['x-forwarded-uri']).toBe(calls[1].url.pathname + calls[1].url.search);
    expect(auth['x-forwarded-method']).toBe('GET');
    expect(target.authorization).toBe(`Bearer ${TOKEN}`);
    for (const [k, v] of Object.entries(SIGNED)) expect(target[k]).toBe(v);
    expect(result.receipt).toMatchObject({ requestId: 'req-9', status: 200, signatureTs: '42' });
    expect(JSON.stringify(result.receipt)).not.toMatch(/sig-value|offline-session-token/);
  });

  it('never sends the target when ForwardAuth refuses or signs a different scope', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const denied = await signedCall(env(url => url.pathname.endsWith('/validate') ? new Response(null, { status: 403 }) : new Response('{}'), calls),
      { method: 'POST', path: '/catalog/datasets/', json: '{}', maxBytes: 100 });
    expect(denied).toMatchObject({ outcome: 'not-sent', receipt: { code: 'forward-auth-403' } });
    const other = await signedCall(env(url => url.pathname.endsWith('/validate') ? new Response(null, { status: 200, headers: { ...SIGNED, 'x-workroom-id': randomUUID() } }) : new Response('{}'), calls),
      { method: 'POST', path: '/catalog/datasets/', json: '{}', maxBytes: 100 });
    expect(other).toMatchObject({ outcome: 'not-sent', receipt: { code: 'signed-identity-scope' } });
    expect(calls.every(c => c.url.pathname.endsWith('/validate'))).toBe(true);
  });

  it('classifies lost responses and server errors as uncertain and conflicts as definitive', async () => {
    const spec = { method: 'POST' as const, path: '/catalog/datasets/', json: '{}', maxBytes: 100 };
    expect((await signedCall(env(url => { const v = validate(url); if (v) return v; throw new TypeError('socket'); }), spec)).outcome).toBe('uncertain');
    expect((await signedCall(env(url => validate(url) ?? new Response('{}', { status: 503 })), spec)).outcome).toBe('uncertain');
    expect((await signedCall(env(url => validate(url) ?? new Response('{}', { status: 408 })), spec)).outcome).toBe('uncertain');
    expect((await signedCall(env(url => validate(url) ?? new Response('{}', { status: 422 })), spec)).outcome).toBe('rejected');
    expect((await signedCall(env(url => validate(url) ?? new Response('{}', { status: 409 })), spec)).outcome).toBe('conflict');
    expect((await signedCall(env(url => validate(url) ?? new Response('x'.repeat(200), { status: 201 })), spec))).toMatchObject({ outcome: 'uncertain', receipt: { code: 'response-too-large' } });
    await expect(signedCall(env(() => new Response()), { ...spec, path: '/catalog/../admin' })).rejects.toThrow('unsafe-target-path');
  });
});

describe('publisher against the offline Core double', () => {
  const setup = (fault?: (method: string, route: string) => Fault) => {
    const core = createOfflineCore({ subject: randomUUID(), workroomId: WORKROOM, token: TOKEN, fault });
    const dir = path.join(tempDir(), 'ledger');
    const run = async (p: PublishPlan = plan) => {
      const ledger = ReceiptLedger.open(dir);
      try { return await publishCatalog({ env: core.env(), ledger, plan: p, handoff }); } finally { ledger.close(); }
    };
    const receipts = () => fs.readFileSync(path.join(dir, 'receipts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    return { core, run, receipts };
  };

  it('publishes once with intents persisted before each POST, verifies bytes, then resumes as a no-op', async () => {
    const { core, run, receipts } = setup();
    const first = await run();
    expect(first).toMatchObject({ status: 'published', mutations: { datasetCreated: true } });
    expect(first.mutations.objectsUploaded).toHaveLength(5);
    expect(first.verified.objects.every(o => o.contentVerified && o.actualSha256 === o.expectedSha256)).toBe(true);
    expect(first.verified.dataset).toMatchObject({ storageBackend: 'file', writable: true, environment: 'DEV' });
    expect(first.nativeCalls).toBeLessThanOrEqual(CALL_CAP);
    expect(core.state.unsignedTargets).toBe(0);
    expect(core.state.validations).toBe(core.state.targets);
    const log = receipts();
    for (const outcome of log.filter(e => e.kind === 'outcome')) {
      const intentIndex = log.findIndex(e => e.kind === 'intent' && e.intentId === outcome.intentId);
      expect(intentIndex).toBeGreaterThanOrEqual(0);
      expect(intentIndex).toBeLessThan(log.indexOf(outcome));
      expect(outcome.requestId).toMatch(/^offline-/);
    }
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    expect(JSON.stringify(log)).not.toContain('offline-signature');

    const second = await run();
    expect(second).toMatchObject({ status: 'already-published', mutations: { datasetCreated: false, objectsUploaded: [] } });
    expect(core.state.mutations).toHaveLength(6);
  });

  it('does not retry an uncertain dataset POST and adopts it only after exact inspection', async () => {
    let failOnce = true;
    const { core, run, receipts } = setup((method, route) => {
      if (method === 'POST' && route === '/catalog/datasets/' && failOnce) { failOnce = false; return 'commit-then-throw'; }
    });
    expect(await run()).toMatchObject({ status: 'stopped', code: 'dataset-create-uncertain' });
    const resumed = await run();
    expect(resumed.status).toBe('published');
    expect(core.state.mutations.filter(m => m.startsWith('dataset:'))).toHaveLength(1);
    expect(receipts().some(e => e.kind === 'reconciled' && e.result === 'dataset-matches-plan')).toBe(true);
    expect(receipts().filter(e => e.kind === 'intent' && e.op === 'create-dataset')).toHaveLength(1);
  });

  it('stops permanently on an uncertain object POST that left nothing behind', async () => {
    const { core, run } = setup((method, route) => method === 'POST' && route.endsWith(':relationships.jsonl') ? 'throw' : undefined);
    expect(await run()).toMatchObject({ status: 'stopped', code: 'object-upload-uncertain', phase: 'upload:relationships.jsonl' });
    const posts = core.state.targets;
    expect(await run()).toMatchObject({ status: 'stopped', code: 'prior-object-upload-unresolved' });
    expect(core.state.mutations.filter(m => m === 'object:relationships.jsonl')).toHaveLength(0);
    expect(core.state.targets - posts).toBeLessThanOrEqual(6);
  });

  it('allows a later run after ForwardAuth refused before any target was sent', async () => {
    let refuse = true;
    const { core } = setup();
    const env = core.env();
    const refusing: NativeEnv = { ...env, fetch: async (url, init) => {
      if (refuse && url.endsWith('/auth/forward/validate') && (init.headers as Record<string, string>)['x-forwarded-method'] === 'POST') { refuse = false; return new Response(null, { status: 503 }); }
      return env.fetch(url, init);
    } };
    const dir = path.join(tempDir(), 'ledger');
    const ledger = ReceiptLedger.open(dir);
    const stopped = await publishCatalog({ env: refusing, ledger, plan, handoff }).finally(() => ledger.close());
    expect(stopped).toMatchObject({ status: 'stopped', code: 'dataset-create-not-sent' });
    expect(core.state.mutations).toHaveLength(0);
    const again = ReceiptLedger.open(dir);
    const resumed = await publishCatalog({ env: core.env(), ledger: again, plan, handoff }).finally(() => again.close());
    expect(resumed.status).toBe('published');
  });

  it('may resend only after a definitive 4xx rejection, never after 409', async () => {
    let reject = true;
    const rejected = setup((method, route) => {
      if (method === 'POST' && route === '/catalog/datasets/' && reject) { reject = false; return 422; }
    });
    expect(await rejected.run()).toMatchObject({ status: 'stopped', code: 'dataset-create-rejected' });
    expect((await rejected.run()).status).toBe('published');

    const conflict = setup((method, route) => method === 'POST' && route === '/catalog/datasets/' ? 409 : undefined);
    expect(await conflict.run()).toMatchObject({ status: 'stopped', code: 'dataset-create-conflict' });
    expect(await conflict.run()).toMatchObject({ status: 'stopped', code: 'prior-dataset-create-unresolved' });
    expect(conflict.receipts().filter(e => e.kind === 'intent')).toHaveLength(1);
  });

  it('never touches an unrelated dataset or object', async () => {
    const unrelated = setup();
    unrelated.core.state.datasets.set(DATASET_URN, nativeDataset({ properties: { owner: 'someone else' } }));
    expect(await unrelated.run()).toMatchObject({ status: 'stopped', code: 'unrelated-dataset' });
    expect(unrelated.core.state.mutations).toHaveLength(0);

    const sameSize = setup();
    sameSize.core.state.datasets.set(DATASET_URN, nativeDataset({ content_revision: 1 }));
    const sources = handoff.uploads.find(f => f.name === 'sources.json')!;
    const other = Buffer.from(sources.bytes);
    other[5] ^= 1;
    sameSize.core.state.objects.push({ ...objectItem('sources.json', other.length), urn: DATASET_URN, bytes: new Uint8Array(other) });
    expect(await sameSize.run()).toMatchObject({ status: 'stopped', code: 'unrelated-object-bytes', phase: 'verify:sources.json' });
    expect(sameSize.core.state.mutations).toEqual(['object:catalog.json', 'object:records.jsonl', 'object:relationships.jsonl']);
  });

  it('passes the script offline self-test from an isolated synthetic installation directory', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, path.dirname(OPENAPI_FILE)), {recursive:true});
    fs.writeFileSync(path.join(dir, OPENAPI_FILE), openapiBytes);
    fs.mkdirSync(path.join(dir, path.dirname(HANDOFF_DIR)), {recursive:true});
    fs.cpSync(HANDOFF_DIR, path.join(dir, HANDOFF_DIR), {recursive:true});
    // Explicit --self-test selects only the in-process offline Core double, never --apply.
    const output = execFileSync(process.execPath, ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'),
      path.resolve('scripts/platform/publish-preset-catalog.ts'), '--self-test'], {cwd:dir, encoding:'utf8', timeout:30_000});
    expect(JSON.parse(output)).toMatchObject({selfTest:'passed', objectsVerified:5, networkCalls:0, modelCalls:0});
  });
});
