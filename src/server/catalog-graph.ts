/**
 * Read-only explorer routes over the exported catalog ontology artifact (`resources/catalog-ontology/graph.json`).
 *
 * The artifact is an app-maintained typed projection of the authored preset catalog and completed offline
 * model-vs-model trials, NOT native Graphiti facts; the native workroom graph stays in the ontology routes.
 * It is loaded once at mount, schema/size/count checked, then re-verified with `checkGraphIntegrity`.
 * Any failure leaves every route answering 503; nothing is synthesized. The raw file is never served.
 */
import type express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {NativePlatformAdapter} from '../platform';
import {extractVerifiedSource} from './catalog-source-archive';
import {
  ENTITY_TYPES, GRAPH_SCHEMA, MAX_SUMMARY_CHARS, MAX_TEXT_PROPERTY_CHARS, PROJECTION_ID, RELATION_TYPES,
  checkGraphIntegrity, graphAtCutoff, type DataClass, type EntityType, type OntologyEdge, type OntologyGraph, type OntologyNode, type RelationType,
} from '../ontology/catalog-projection';

export const DEFAULT_CATALOG_GRAPH_PATH = path.join(process.cwd(), 'resources', 'catalog-ontology', 'graph.json');
export const GRAPH_LIMITS = Object.freeze({maxBytes: 32 * 1024 * 1024, maxNodes: 20_000, maxEdges: 80_000, maxObservations: 2_000, maxInputs: 64});
export const SEARCH_MAX_QUERY = 120, SEARCH_MAX_LIMIT = 20, NODE_MAX_RELATIONS = 16;
export const CATALOG_GRAPH_SCOPE =
  'App-maintained typed projection of the preset catalog and completed offline model trials. Not native Kamiwaza Graphiti facts and not ingested; the native workroom graph is shown separately. After-action view, not a current-player feed.';

export const DATA_CLASSES = ['actual-recorded', 'derived-observation', 'authored-synthetic', 'public-reference'] as const satisfies readonly DataClass[];
/** Search/relation ordering: the recorded model-game path first, then authored and public reference data. */
export const TYPE_ORDER: readonly EntityType[] = [
  'ActualTrial', 'ModelSeat', 'RecordedModelDecision', 'BehaviorObservation', 'ActualRound', 'ObservedOutcome', 'SourceArtifact',
  'AOR', 'SyntheticPersona', 'AuthoredCase', 'AuthoredDecision', 'AuthoredReview', 'SyntheticReport', 'Lesson', 'RedProfile',
  'Organization', 'Asset', 'GlossaryTerm', 'HistoricalReference', 'Source',
];
const ENTITY_KEYS = Object.keys(ENTITY_TYPES) as [EntityType, ...EntityType[]];
const RELATION_KEYS = Object.keys(RELATION_TYPES) as [RelationType, ...RelationType[]];
const rank = (t: string) => { const i = TYPE_ORDER.indexOf(t as EntityType); return i < 0 ? TYPE_ORDER.length : i; };

// ---------------------------------------------------------------- artifact schema

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const text = (max: number) => z.string().max(max);
const properties = z.record(text(120), z.union([text(MAX_TEXT_PROPERTY_CHARS), z.number(), z.boolean(), z.null(), z.array(text(MAX_TEXT_PROPERTY_CHARS)).max(200), z.array(z.number()).max(200)]))
  .refine((o) => Object.keys(o).length <= 200, 'too many properties');
const nodeSchema = z.object({
  id: text(400).min(1), type: z.enum(ENTITY_KEYS), dataClass: z.enum(DATA_CLASSES), label: text(200), summary: text(MAX_SUMMARY_CHARS), properties,
  provenance: z.object({origin: z.enum(['preset-catalog', 'dual-model-trial', 'projection']), sourceRef: text(600), sourceSha256: hex.nullable()}).strict(),
  time: z.object({clock: text(300).min(1), observedTick: z.number().nullable(), releasedTick: z.number()}).strict().nullable(),
  hindsight: z.boolean(), contentSha256: hex,
}).strict();
const edgeSchema = z.object({
  id: text(400).min(1), type: z.enum(RELATION_KEYS), source: text(400), target: text(400), dataClass: z.enum(DATA_CLASSES),
  fact: text(MAX_SUMMARY_CHARS), properties, contentSha256: hex,
}).strict();
const inputSchema = z.union([
  z.object({kind: z.literal('preset-catalog'), schema: text(200), version: text(200), seed: text(200), sha256: hex, records: z.number().int().nonnegative()}).strict(),
  z.object({kind: z.literal('dual-model-trial'), name: text(200), gameId: text(200), files: z.number().int().nonnegative(), totalBytes: z.number().int().nonnegative(),
    manifestSha256: hex, summarySha256: hex, engineReceipt: z.object({path: text(600), sha256: hex}).strict().nullable()}).strict(),
]);
const graphSchema = z.object({
  schema: z.literal(GRAPH_SCHEMA), projection: z.object({id: z.literal(PROJECTION_ID), version: text(40)}).strict(), notice: text(4000),
  inputs: z.array(inputSchema).max(GRAPH_LIMITS.maxInputs), nodes: z.array(nodeSchema).min(1).max(GRAPH_LIMITS.maxNodes),
  edges: z.array(edgeSchema).max(GRAPH_LIMITS.maxEdges), observations: z.array(z.object({id: text(400)}).passthrough()).max(GRAPH_LIMITS.maxObservations), graphSha256: hex,
}).strict();

// ---------------------------------------------------------------- loading and views

interface GraphView { graph: OntologyGraph; byId: Map<string, OntologyNode>; adjacent: Map<string, OntologyEdge[]>; ordered: OntologyNode[] }
interface ReviewContext { trialName:string; trialId:string; seat:'blue'|'red'|null; roundIndex:number|null; releasedTick:number }

/** Presentation metadata from records already present in this review view. Never changes graph hashes. */
function reviewContextFor(node:OntologyNode, view:GraphView):ReviewContext|null {
  if (!node.time?.clock.startsWith('trial:')) return null;
  const trial=view.byId.get(node.time.clock), name=trial?.properties.trialName;
  if (trial?.type!=='ActualTrial'||typeof name!=='string') return null;
  const p=node.properties, source=node.type==='SourceArtifact'&&typeof p.path==='string' ? /^(?:rounds|results)\/(\d{2})(?:\/(blue|red))?\//.exec(p.path) : null;
  const seat=p.seat==='blue'||p.seat==='red' ? p.seat : source?.[2]==='blue'||source?.[2]==='red' ? source[2] : null;
  const round=typeof p.round==='number' ? p.round : source ? Number(source[1]) : null;
  return {trialName:name,trialId:trial.id,seat,roundIndex:round!==null&&Number.isSafeInteger(round)&&round>=0 ? round : null,releasedTick:node.time.releasedTick};
}
interface ClockInfo { clock: string; maxReleasedTick: number; nodes: number }
export type LoadedCatalogGraph = {ok: true; full: GraphView; clocks: ClockInfo[]; haystack: Map<string, string>} | {ok: false; reason: string};

function indexView(graph: OntologyGraph): GraphView {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const)), adjacent = new Map<string, OntologyEdge[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) throw new Error(`edge ${e.id} has an unresolved endpoint`);
    for (const end of new Set([e.source, e.target])) { const list = adjacent.get(end); if (list) list.push(e); else adjacent.set(end, [e]); }
  }
  const ordered = [...graph.nodes].sort((a, b) => rank(a.type) - rank(b.type) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {graph, byId, adjacent, ordered};
}

/** Reads and verifies an artifact. Never throws; a refusal carries a server-side reason only. */
export function loadCatalogGraph(file: string): LoadedCatalogGraph {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || !file.endsWith('.json')) return {ok: false, reason: 'artifact is not a JSON file'};
    if (stat.size > GRAPH_LIMITS.maxBytes) return {ok: false, reason: `artifact exceeds ${GRAPH_LIMITS.maxBytes} bytes`};
    const parsed = graphSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) return {ok: false, reason: `artifact schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`};
    const graph = parsed.data as unknown as OntologyGraph;
    const problems = checkGraphIntegrity(graph);
    if (problems.length) return {ok: false, reason: `artifact integrity: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3})` : ''}`};
    const full = indexView(graph), clocks = new Map<string, ClockInfo>();
    for (const n of graph.nodes) if (n.time) {
      const c = clocks.get(n.time.clock) ?? {clock: n.time.clock, maxReleasedTick: 0, nodes: 0};
      c.maxReleasedTick = Math.max(c.maxReleasedTick, n.time.releasedTick); c.nodes++; clocks.set(n.time.clock, c);
    }
    const haystack = new Map(graph.nodes.map((n) => [n.id, `${n.id}\n${n.type}\n${n.label}\n${n.summary}\n${reviewContextFor(n,full)?.trialName??''}`.toLowerCase()] as const));
    return {ok: true, full, clocks: [...clocks.values()].sort((a, b) => (a.clock < b.clock ? -1 : 1)), haystack};
  } catch (e) {
    return {ok: false, reason: e instanceof Error ? e.message.slice(0, 300) : 'artifact unreadable'};
  }
}

// ---------------------------------------------------------------- queries

const count = (max: number) => z.string().regex(/^\d{1,9}$/).transform(Number).refine((n) => n <= max, 'out of range');
const viewQuery = {clock: text(300).optional(), cutoffTick: count(1_000_000_000).optional()};
const summaryQuery = z.object(viewQuery).strict();
const searchQuery = z.object({
  ...viewQuery, q: text(SEARCH_MAX_QUERY).optional(), type: z.enum(ENTITY_KEYS).optional(), dataClass: z.enum(DATA_CLASSES).optional(),
  offset: count(GRAPH_LIMITS.maxNodes).optional(), limit: count(SEARCH_MAX_LIMIT).refine((n) => n >= 1, 'limit must be positive').optional(),
}).strict();
const nodeQuery = z.object({...viewQuery, id: text(400).min(1), edgeOffset: count(GRAPH_LIMITS.maxEdges).optional()}).strict();
const sourceQuery = z.object({...viewQuery, id: text(400).min(1)}).strict();
const SOURCE_ROLES: Record<string, RegExp> = {
  'seat-snapshot': /^rounds\/\d{2}\/(blue|red)\/snapshot\.json$/,
  'seat-prompt': /^rounds\/\d{2}\/(blue|red)\/prompt\.md$/,
  'decision-record': /^results\/\d{2}\/(blue|red)\/decision\.json$/,
  'saved-reply': /^results\/\d{2}\/(blue|red)\/response\.raw\.json$/,
  'round-state': /^rounds\/\d{2}\/round\.json$/,
  'round-outcome': /^results\/\d{2}\/outcome\.json$/,
};

function loadSourceBinding(file: string, graphSha256: string, graphFileSha256: string) {
  try {
    if (fs.statSync(file).size > 64 * 1024) return null;
    const raw = fs.readFileSync(file), manifest = z.object({graphSha256:hex, nativeIngestion:z.literal(false),
      files:z.array(z.object({name:text(100),bytes:z.number().int().nonnegative(),sha256:hex})).max(16)}).parse(JSON.parse(raw.toString('utf8')));
    const graph = manifest.files.filter(f => f.name === 'graph.json'), archive = manifest.files.filter(f => f.name === 'trial-records.tar.gz');
    if (manifest.graphSha256 !== graphSha256 || graph.length !== 1 || graph[0].sha256 !== graphFileSha256 || archive.length !== 1 ||
        archive[0].bytes < 1 || archive[0].bytes > 8 * 1024 * 1024) return null;
    return {manifestSha256:createHash('sha256').update(raw).digest('hex'), archive:archive[0]};
  } catch { return null; }
}

class QueryError extends Error {}
class NotFound extends Error {}

export interface CatalogGraphOptions { graphPath?: string; manifestPath?: string }

export function mountCatalogGraphRoutes(app: express.Express, options: CatalogGraphOptions = {}) {
  const requireFreshRead: express.RequestHandler | undefined = app.locals.guards?.requireFreshRead;
  if (!requireFreshRead) throw new Error('Catalog graph routes require the fresh-read authorization guard');
  const loaded = loadCatalogGraph(options.graphPath ?? DEFAULT_CATALOG_GRAPH_PATH);
  if (!loaded.ok) console.warn(`[catalog-graph] unavailable: ${loaded.reason}`);
  const fileSha256 = loaded.ok ? createHash('sha256').update(fs.readFileSync(options.graphPath ?? DEFAULT_CATALOG_GRAPH_PATH)).digest('hex') : null;
  const cutoffViews = new Map<string, GraphView>();
  const sourceBinding = loaded.ok ? loadSourceBinding(options.manifestPath ?? path.join(path.dirname(options.graphPath ?? DEFAULT_CATALOG_GRAPH_PATH),'manifest.json'), loaded.full.graph.graphSha256, fileSha256!) : null;
  let sourceReads = 0;

  app.get('/api/catalog/graph/source', (_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();}, requireFreshRead, async(req,res,next)=>{
    if (!loaded.ok) return res.status(503).json({error:'Catalog graph unavailable'});
    let node:OntologyNode, cutoff:{clock:string;cutoffTick:number}|null;
    try {
      const q = sourceQuery.parse(req.query), selected = viewFor(q,loaded), candidate = selected.view.byId.get(q.id);
      if (!candidate || candidate.type !== 'SourceArtifact') throw new NotFound();
      node = candidate; cutoff = selected.cutoff;
      const p = node.properties, trial = loaded.full.graph.inputs.find(i => i.kind === 'dual-model-trial' && node.time?.clock === `trial:${i.gameId}`);
      if (!trial || trial.kind !== 'dual-model-trial' || !/^[a-zA-Z0-9_-]+$/.test(trial.name) ||
          typeof p.role !== 'string' || typeof p.path !== 'string' || !SOURCE_ROLES[p.role]?.test(p.path) ||
          p.repoPath !== `evidence/dual-model-trial/${trial.name}/${p.path}` || p.repoPath !== node.provenance.sourceRef ||
          p.sha256 !== node.provenance.sourceSha256 || typeof p.bytes !== 'number' || !Number.isSafeInteger(p.bytes) || p.bytes < 1 || p.bytes > 256*1024)
        throw new NotFound();
    } catch (error) {
      if (error instanceof NotFound) return res.status(404).json({error:'Saved source is not available in this review view'});
      return res.status(400).json({error:'Invalid catalog source query'});
    }
    if (!sourceBinding) return res.status(503).json({error:'Source archive binding unavailable'});
    const native=res.locals.native, client=native?.platformClient as NativePlatformAdapter|undefined, room=native?.context?.workroomId, subject=res.locals.identity?.subject;
    if (!client?.catalogDataset || !client.catalogObjects || !client.catalogObjectContent || typeof room !== 'string' || typeof subject !== 'string')
      return res.status(409).json({error:'Native workroom session required'});
    if (sourceReads >= 2) return res.status(429).json({error:'Source reader busy; try again shortly'});
    sourceReads++;
    try {
      const urn=`urn:li:dataset:(urn:li:dataPlatform:kamiwaza,replay-model-evidence-${loaded.full.graph.graphSha256.slice(0,16)},DEV)`;
      const ds=await client.catalogDataset(urn,room);
      if (ds.data.urn!==urn || ds.data.workroom_id!==room || ds.data.properties?.['replay.graph_sha256']!==loaded.full.graph.graphSha256 ||
          ds.data.properties?.['replay.manifest_sha256']!==sourceBinding.manifestSha256)
        return res.status(409).json({error:'Native source dataset binding mismatch'});
      const objects=await client.catalogObjects(urn,room);
      if (!Array.isArray(objects.data) || objects.data.length>100) throw new Error('Object metadata invalid');
      const match=(name:string,sha:string,bytes?:number)=>{
        const rows=objects.data.filter(o=>o.logical_path===name&&o.state==='live');
        return rows.length===1&&rows[0].etag===`sha256:${sha}`&&(bytes===undefined||rows[0].size_bytes===bytes) ? rows[0] : null;
      };
      const archive=match('trial-records.tar.gz',sourceBinding.archive.sha256,sourceBinding.archive.bytes);
      if (!match('graph.json',fileSha256!) || !match('manifest.json',sourceBinding.manifestSha256) ||
          !archive?.item_id || !/^[0-9a-fA-F-]{36}$/.test(archive.item_id))
        return res.status(409).json({error:'Native source object binding mismatch'});
      const content=await client.catalogObjectContent(urn,archive.item_id,room,sourceBinding.archive.bytes);
      if (content.identity.userId!==subject || content.identity.workroomId!==room) return res.status(403).json({error:'Native source identity mismatch'});
      if (content.data.byteLength!==sourceBinding.archive.bytes) throw new Error('Archive size mismatch');
      const source=extractVerifiedSource(content.data,{archiveSha256:sourceBinding.archive.sha256,path:node.properties.repoPath as string,
        sha256:node.provenance.sourceSha256!,bytes:node.properties.bytes as number});
      // Only this allowlisted text leaves the archive; never return other members, credentials or native headers.
      res.locals.catalogSource={subject,room,body:{nodeId:node.id,path:node.properties.repoPath,...source,view:cutoff,
        archive:{datasetUrn:urn,objectId:archive.item_id,sha256:sourceBinding.archive.sha256},receipts:[ds.receipt,objects.receipt,content.receipt]}};
    } catch(error) {
      const status=(error as {httpStatus?:number}).httpStatus;
      return res.status(status===401||status===403?status:502).json({error:'Native saved source read or verification failed'});
    } finally { sourceReads--; }
    next();
  }, requireFreshRead, (_req,res)=>{
    const source=res.locals.catalogSource;
    if (source.subject!==res.locals.identity?.subject || source.room!==res.locals.native?.context?.workroomId)
      return res.status(403).json({error:'Source session changed during read'});
    return res.json(source.body);
  });

  app.get('/api/catalog/graph/storage', (_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();}, requireFreshRead, async(_req,res)=>{
    if(!loaded.ok)return res.status(503).json({error:'Catalog graph unavailable'});
    const native=res.locals.native,client=native?.platformClient as NativePlatformAdapter|undefined,workroomId=native?.context?.workroomId;
    if(!client?.catalogDataset||!client.catalogObjects||typeof workroomId!=='string')return res.status(409).json({error:'Native workroom session required'});
    const name=`replay-model-evidence-${loaded.full.graph.graphSha256.slice(0,16)}`,urn=`urn:li:dataset:(urn:li:dataPlatform:kamiwaza,${name},DEV)`;
    try{
      const ds=await client.catalogDataset(urn,workroomId);
      if(ds.data.urn!==urn||ds.data.workroom_id!==workroomId||ds.data.properties?.['replay.graph_sha256']!==loaded.full.graph.graphSha256)
        return res.status(409).json({error:'Native dataset does not match this graph and workroom'});
      const objects=await client.catalogObjects(urn,workroomId);
      if(!Array.isArray(objects.data)||objects.data.length>100)return res.status(502).json({error:'Native object metadata unavailable'});
      const graphObjects=objects.data.filter((o:any)=>o.logical_path==='graph.json'&&o.state==='live');
      if(graphObjects.length!==1||graphObjects[0].etag!==`sha256:${fileSha256}`)return res.status(409).json({error:'Native graph object metadata differs from this build'});
      return res.json({status:'matched',name,urn,workroomId,contentRevision:ds.data.content_revision??null,objects:objects.data.length,graphFileSha256:fileSha256,metadataOnly:true,nativeGraphIngested:false,receipts:[ds.receipt,objects.receipt]});
    }catch(e){const status=(e as {httpStatus?:number}).httpStatus;return res.status(status===401||status===403?status:502).json({error:'Native archive metadata read failed'});}
  });

  function viewFor(q: {clock?: string; cutoffTick?: number}, g: Extract<LoadedCatalogGraph, {ok: true}>) {
    if (q.clock === undefined && q.cutoffTick === undefined) return {view: g.full, cutoff: null};
    if (q.clock === undefined || q.cutoffTick === undefined) throw new QueryError('clock and cutoffTick must be supplied together');
    if (!g.clocks.some((c) => c.clock === q.clock)) throw new QueryError('unknown clock');
    const key = `${q.cutoffTick}@${q.clock}`;
    let view = cutoffViews.get(key);
    if (view) cutoffViews.delete(key);
    else view = indexView(graphAtCutoff(g.full.graph, q.clock, q.cutoffTick));
    cutoffViews.set(key, view);
    if (cutoffViews.size > 16) cutoffViews.delete(cutoffViews.keys().next().value!);
    return {view, cutoff: {clock: q.clock, cutoffTick: q.cutoffTick}};
  }

  const route = (url: string, handle: (req: express.Request, g: Extract<LoadedCatalogGraph, {ok: true}>) => unknown) =>
    app.get(url, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); }, requireFreshRead, (req, res) => {
      if (!loaded.ok) return res.status(503).json({error: 'Catalog graph unavailable'});
      try { return res.json(handle(req, loaded)); } catch (e) {
        if (e instanceof z.ZodError || e instanceof QueryError) return res.status(400).json({error: 'Invalid catalog graph query'});
        if (e instanceof NotFound) return res.status(404).json({error: 'Catalog graph node not available'});
        return res.status(500).json({error: 'Catalog graph unavailable'});
      }
    });

  route('/api/catalog/graph', (req, g) => {
    const {view, cutoff} = viewFor(summaryQuery.parse(req.query), g);
    const byType: Record<string, number> = {}, byDataClass: Record<string, number> = {};
    for (const n of view.graph.nodes) { byType[n.type] = (byType[n.type] ?? 0) + 1; byDataClass[n.dataClass] = (byDataClass[n.dataClass] ?? 0) + 1; }
    return {
      scope: CATALOG_GRAPH_SCOPE, notice: view.graph.notice, schema: view.graph.schema, projection: view.graph.projection,
      artifactSha256: g.full.graph.graphSha256, viewSha256: view.graph.graphSha256, view: cutoff,
      counts: {nodes: view.graph.nodes.length, edges: view.graph.edges.length, byType, byDataClass},
      types: TYPE_ORDER.filter((t) => g.full.ordered.some((n) => n.type === t)), dataClasses: DATA_CLASSES.filter((d) => g.full.ordered.some((n) => n.dataClass === d)),
      clocks: g.clocks,
      inputs: g.full.graph.inputs.map((i) => (i.kind === 'preset-catalog' ? {kind: i.kind, label: `${i.schema} ${i.version}`, sha256: i.sha256} : {kind: i.kind, label: i.name, sha256: i.manifestSha256})),
    };
  });

  route('/api/catalog/graph/search', (req, g) => {
    const q = searchQuery.parse(req.query), {view, cutoff} = viewFor(q, g);
    const terms = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = view.ordered.filter((n) => (!q.type || n.type === q.type) && (!q.dataClass || n.dataClass === q.dataClass) && terms.every((t) => g.haystack.get(n.id)!.includes(t)));
    const offset = q.offset ?? 0, limit = q.limit ?? SEARCH_MAX_LIMIT;
    const items = hits.slice(offset, offset + limit).map(n => ({id:n.id,type:n.type,dataClass:n.dataClass,label:n.label,summary:n.summary,
      ...(reviewContextFor(n,view) ? {reviewContext:reviewContextFor(n,view)} : {})}));
    return {view: cutoff, total: hits.length, offset, limit, nextOffset: offset + items.length < hits.length ? offset + items.length : null, items};
  });

  route('/api/catalog/graph/node', (req, g) => {
    const q = nodeQuery.parse(req.query), {view, cutoff} = viewFor(q, g), node = view.byId.get(q.id);
    if (!node) throw new NotFound();
    const other = (e: OntologyEdge) => view.byId.get(e.source === node.id ? e.target : e.source)!;
    const reviewRank=(e:OntologyEdge)=>{
      if (node.type!=='RecordedModelDecision') return 0;
      const end=other(e);
      if(end.id===node.properties.snapshotArtifactId) return 0;
      if(end.id===node.properties.savedReplyArtifactId) return 1;
      if(e.type==='FOLLOWED_BY') return 2;
      if(e.type==='IN_ROUND') return 3;
      if(end.type==='ModelSeat') return 4;
      if(end.type==='SourceArtifact') return 5;
      return 6;
    };
    // Put a decision's source and round evidence before the many aggregate behavior observations.
    const all = [...(view.adjacent.get(node.id) ?? [])].sort((a, b) => reviewRank(a)-reviewRank(b) || rank(other(a).type) - rank(other(b).type) || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.id < b.id ? -1 : 1));
    const offset = q.edgeOffset ?? 0, page = all.slice(offset, offset + NODE_MAX_RELATIONS);
    const relations = page.map((e) => {
      const end = other(e);
      return {
        direction: e.source === node.id ? 'out' : 'in', statement: RELATION_TYPES[e.type].statement,
        edge: {id: e.id, type: e.type, dataClass: e.dataClass, fact: e.fact, properties: e.properties, contentSha256: e.contentSha256},
        endpoint: {id: end.id, type: end.type, dataClass: end.dataClass, label: end.label,...(reviewContextFor(end,view)?{reviewContext:reviewContextFor(end,view)}:{})},
      };
    });
    return {view: cutoff, node, ...(reviewContextFor(node,view)?{reviewContext:reviewContextFor(node,view)}:{}), relations: {total: all.length, offset, limit: NODE_MAX_RELATIONS, truncated: offset + page.length < all.length, items: relations}};
  });
}
