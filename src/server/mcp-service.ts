import {catalogFor} from './catalog-store';
/**
 * Read-only MCP tool catalog over the REPLAY game service.
 *
 * Every tool takes an explicit exercise id (and optional tick) and runs under a
 * principal the route layer resolved from a platform-validated bearer. Nothing
 * here reads or writes a browser session, navigation state, or any store row;
 * the only engine work is the existing historical reconstruction that the
 * `/api/replay` seek path already performs.
 *
 * Scoping reuses the exact rules of the HTTP app:
 *  - visibility: `exerciseScope(config, identity, teams.includes)`;
 *  - side privacy: opposing-side records open only for the instructor seat or
 *    a completed exercise (`canBoth`), the same rule as `GameService.overview`;
 *  - time: records after the requested tick are unavailable; `tick` beyond the
 *    exercise's recorded turns is refused, never clamped;
 *  - personal records: model traces (`model_decision`, `tool_result`, ...) and
 *    generated debriefs are never emitted; key moments never carry `excluded`.
 *
 * Every result carries a `provenance` block naming the fiction, the exercise
 * kind (live / recorded / branch), the position (live / historical) and the
 * cutoff tick so a downstream model cannot present it as fact or as current.
 */
import { z } from "zod";
import { redactSecrets } from "../platform/index";
import { selectKeyMoments } from "../learning/key-moments";
import { UPSTREAM_COMMIT } from "../engine/engine";
import { controllerLabel, recordedScenario } from "../scenarios/catalog";
import { networkAt } from "./network-store";
import {practiceHistory,practiceHistoryDetails} from './practice-history';
import {ServiceError} from './service';
import { exerciseScope, type ExerciseScope, type KamiwazaConfig } from "./native-http";
import type { GameService, Identity } from "./service";
import type { ExerciseRow } from "./store";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpToolErrorCode = "invalid_params" | "exercise_not_found" | "tick_unavailable" | "unavailable";
/** The HTTP layer supplies a fresh native identity after asynchronous engine reconstruction. */
export type McpReauthorize = () => Promise<Identity>;

/** Tool-level failure. Message is safe to show to the caller; it names no other subject's data. */
export class McpToolError extends Error {
  constructor(readonly code: McpToolErrorCode, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/** JSON Schema (2020-12 subset) for a tool's arguments. Always a closed object. */
export interface McpInputSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: McpInputSchema;
  annotations: { title: string; readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false };
}

export interface McpProvenance {
  fiction: true;
  notice: string;
  exerciseId: string;
  exerciseKind: ExerciseRow["kind"];
  status: string;
  /** `live`: current engine state. `historical`: reconstructed at `cutoffTick`. */
  position: "live" | "historical";
  cutoffTick: number;
  /** Engine fingerprint at the cutoff when the tool reconstructed state; null for record-only reads. */
  fingerprint: string | null;
  viewerSide: "blue" | "red";
  bothSidesVisible: boolean;
  generatedAt: string;
}

export interface McpServiceOptions {
  service: GameService;
  config: KamiwazaConfig;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const MAX_LISTED_EXERCISES = 100;
export const MAX_LISTED_REPORTS = 50;
export const MAX_LISTED_ASSESSMENTS = 100;
export const MAX_KEY_MOMENTS = 12;
export const MAX_TEXT_CHARS = 2_000;
export const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;

const FICTION_NOTICE = "Fictional educational strategy exercise on a pinned OpenFront engine. Synthetic reports; opponents may be scripted or model-driven. Consult per-exercise provenance. Not real-world data; no training-efficacy claim.";

// ---------------------------------------------------------------------------
// Argument schemas (zod for validation, JSON Schema for tools/list)
// ---------------------------------------------------------------------------

const exerciseIdPattern = "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
const exerciseId = z.string().regex(new RegExp(exerciseIdPattern), "exerciseId must be a REPLAY exercise UUID");
const tick = z.number().int().min(0).max(1_000_000).nullable().optional();
const noArgs = z.object({}).strict();
const exerciseArgs = z.object({ exerciseId, tick }).strict();
const momentsArgs = z.object({ exerciseId, tick, limit: z.number().int().min(1).max(MAX_KEY_MOMENTS).optional() }).strict();

const jsonExerciseId = { type: "string", pattern: exerciseIdPattern, description: "REPLAY exercise id from list_exercises." };
const jsonTick = { type: ["integer", "null"], minimum: 0, maximum: 1_000_000, description: "Optional cutoff tick. Omit or null for the live position. Records after this tick are not returned; a tick beyond the recorded history is an error, never clamped." };

function schema(properties: Record<string, unknown>, required: string[]): McpInputSchema {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class McpService {
  private readonly service: GameService;
  private readonly config: KamiwazaConfig;
  private readonly now: () => Date;

  constructor(opts: McpServiceOptions) {
    if (opts.config.mode !== "kamiwaza") throw new McpToolError("unavailable", "The MCP surface runs only under native Kamiwaza identity");
    this.service = opts.service;
    this.config = opts.config;
    this.now = opts.now ?? (() => new Date());
  }

  /** Static catalog. Every tool is read-only; there are no write tools on this surface. */
  tools(): McpToolDescriptor[] {
    const t = (name: string, title: string, description: string, inputSchema: McpInputSchema): McpToolDescriptor => ({
      name,
      title,
      description,
      inputSchema,
      annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    return [
      t('search_catalog','Search regional preset references','Search the preloaded synthetic training library: regional personas, authored cases, reports, source chains, assets, glossary, lessons and public historical references. These are shared presets, NOT this caller’s real history, current intelligence, engine state or inferred personality. Returns up to5 summaries; use get_catalog_record for linked detail. No model call.',schema({query:{type:'string',maxLength:120},aorId:{type:'string',enum:['taiwan','caribbean','hormuz']},kind:{type:'string',enum:['persona','report','case','event','asset','glossary','historical','lesson','organization','red-profile']},role:{type:'string',enum:['commander','intelligence','instructor']},personaId:{type:'string',maxLength:200},caseId:{type:'string',maxLength:200},cutoffTick:{type:'integer',minimum:0,maximum:1000000},offset:{type:'integer',minimum:0,maximum:50000},limit:{type:'integer',minimum:1,maximum:5,default:5}},[])),
      t('get_catalog_record','Read a preset reference','Read one synthetic library record and bounded relationship references. Persona records do not grant access or describe the current human. Historical sources are original summaries and links, not approved doctrine or ingested full documents.',schema({recordId:{type:'string',maxLength:200},cutoffTick:{type:'integer',minimum:0,maximum:1000000}},['recordId'])),
      t("list_exercises", "List visible REPLAY exercises", "Fictional exercises assigned to you in this workroom (owned, enrolled, or all for the instructor seat). Returns ids for the other tools. No map data.", schema({}, [])),
      t("get_exercise_state", "Exercise state at live or tick", "Public shared-map summary for one exercise: tick, fingerprint, both players' forces and holdings. No tile map. Historical when tick is given.", schema({ exerciseId: jsonExerciseId, tick: jsonTick }, ["exerciseId"])),
      t("get_station_objectives", "Station objectives board", "Deterministic station-control and reserve scoring for objective scenarios at live or tick. Game points, never a learning score. available=false for scenarios without objectives.", schema({ exerciseId: jsonExerciseId, tick: jsonTick }, ["exerciseId"])),
      t("get_team_assessments", "Team assessment entries", "Intelligence-seat assessment entries shared with your side, recorded at or before the cutoff. Opposing-side entries appear only after completion or for the instructor. No debriefs or personal coaching.", schema({ exerciseId: jsonExerciseId, tick: jsonTick }, ["exerciseId"])),
      t("get_key_moments", "Evidence-based key moments", "Moments selected for evidence distinctness up to the cutoff. Your own acts only (instructor: shared scope). Ordering aid; not a quality judgment.", schema({ exerciseId: jsonExerciseId, tick: jsonTick, limit: { type: "integer", minimum: 1, maximum: MAX_KEY_MOMENTS, description: "How many moments, default 6." } }, ["exerciseId"])),
      t("get_replay_provenance", "Replay provenance and released sources", "Engine pin, scenario, lineage (branch parent and fork tick), attribution, record integrity references, and the synthetic reports released to your side at or before the cutoff with their supersession chain.", schema({ exerciseId: jsonExerciseId, tick: jsonTick }, ["exerciseId"])),
      t('search_practice_history','Search retained practice actions','Search your attributed actions in completed exercises. Instructor-only workroom scope includes participant actions. Scenario versions, original/branch labels and evidence IDs retained. Page counts are descriptive, not personality or mastery scores. No live exercise or private model-coaching trace.',schema({scope:{type:'string',enum:['mine','workroom'],default:'mine'},query:{type:'string',maxLength:120},scenarioId:{type:'string',minLength:1,maxLength:200},beforeSequence:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},limit:{type:'integer',minimum:1,maximum:50,default:20}},[])),
      t('search_practice_details','Review decision reasons and source changes','Search your written decision reasons and cited-source status in completed exercises. Returns recorded statement timing, source status at the observed tick versus completion, exact event IDs and informed-branch labels. Instructor-only workroom scope. At most6000characters; follow nextBeforeSequence for more. Counts describe the returned page, never mastery or personality. No model call.',schema({scope:{type:'string',enum:['mine','workroom'],default:'mine'},query:{type:'string',maxLength:120},scenarioId:{type:'string',minLength:1,maxLength:200},beforeSequence:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},limit:{type:'integer',minimum:1,maximum:10,default:5}},[])),
    ];
  }

  /** Dispatch by tool name. Unknown names and malformed arguments are `invalid_params`. */
  async call(name: string, args: unknown, identity: Identity, reauthorize?: McpReauthorize): Promise<Record<string, unknown>> {
    const result = await this.dispatch(name, args, identity, reauthorize);
    const encoded = JSON.stringify(result, (_key, value) => typeof value === "string" ? redactSecrets(value).replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]") : value);
    if (Buffer.byteLength(encoded, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
      throw new McpToolError("unavailable", "Tool output exceeds the response limit; request an earlier cutoff or a smaller selection");
    }
    return JSON.parse(encoded);
  }

  private async dispatch(name: string, args: unknown, identity: Identity, reauthorize?: McpReauthorize): Promise<Record<string, unknown>> {
    switch (name) {
      case 'search_catalog':
      case 'get_catalog_record':
        try{
          this.scopeOf(identity);
          const catalog=catalogFor(this.service.store.db);
          if(name==='search_catalog')return catalog.toolSearch(args) as unknown as Record<string,unknown>;
          const a=z.object({recordId:z.string().max(200),cutoffTick:z.number().int().min(0).max(1000000).optional()}).strict().parse(args);
          const d=catalog.detail(a.recordId,a.cutoffTick);if(!d)throw new McpToolError('unavailable','Preset reference not available');
          const ref=(x:{relation:string;record:{id:string;title:string;kind:string}})=>({relation:x.relation,id:x.record.id,title:x.record.title,kind:x.record.kind});
          return {...d,links:d.links.slice(0,12).map(ref),backlinks:d.backlinks.slice(0,12).map(ref),relationshipLimit:12,scope:'shared preset reference; never actual user behavior'};
        }catch(e){if(e instanceof z.ZodError)throw new McpToolError('invalid_params','Invalid catalog query');throw e;}
      case 'search_practice_history':
      case 'search_practice_details':
        try{return (name==='search_practice_details'?practiceHistoryDetails:practiceHistory)(this.service,this.config,identity,args) as unknown as Record<string,unknown>;}
        catch(e){if(e instanceof z.ZodError)throw new McpToolError('invalid_params','Invalid practice search');if(e instanceof ServiceError)throw new McpToolError('unavailable',e.message);throw e;}
      case "list_exercises":
        parse(noArgs, args);
        return this.listExercises(identity);
      case "get_exercise_state": {
        const a = parse(exerciseArgs, args);
        return this.exerciseState(identity, a.exerciseId, a.tick ?? null, reauthorize);
      }
      case "get_station_objectives": {
        const a = parse(exerciseArgs, args);
        return this.stationObjectives(identity, a.exerciseId, a.tick ?? null, reauthorize);
      }
      case "get_team_assessments": {
        const a = parse(exerciseArgs, args);
        return this.teamAssessments(identity, a.exerciseId, a.tick ?? null);
      }
      case "get_key_moments": {
        const a = parse(momentsArgs, args);
        return this.keyMoments(identity, a.exerciseId, a.tick ?? null, a.limit ?? 6);
      }
      case "get_replay_provenance": {
        const a = parse(exerciseArgs, args);
        return this.replayProvenance(identity, a.exerciseId, a.tick ?? null);
      }
      default:
        throw new McpToolError("invalid_params", "Unknown tool");
    }
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  listExercises(identity: Identity) {
    const scope = this.scopeOf(identity);
    const rows = this.service.store.exercises().filter((r) => this.service.worlds.has(r.id) && scope.visible(r));
    const exercises = rows.slice(0, MAX_LISTED_EXERCISES).map((r) => {
      const w = this.service.world(r.id);
      return {
        id: r.id,
        name: clip(r.name),
        kind: r.kind,
        status: r.status,
        humanSide: r.humanSide,
        currentTick: w.engine.game.ticks(),
        parentId: this.visibleParent(identity, r)?.id ?? null,
        forkTick: r.forkTick ?? null,
        createdAt: r.createdAt,
        attribution: scope.attribution(r),
        scenarioId: typeof r.options?.scenarioId === "string" ? r.options.scenarioId : null,
        participantCount: this.service.teams.participants(r).filter((p) => p.active).length,
      };
    });
    return {
      fiction: true as const,
      notice: FICTION_NOTICE,
      workroomId: this.config.workroomId,
      viewer: { role: identity.role, bothSidesVisibleByRole: identity.role === "instructor" },
      exercises,
      truncated: rows.length > exercises.length,
      generatedAt: this.now().toISOString(),
    };
  }

  async exerciseState(identity: Identity, id: string, tick: number | null, reauthorize?: McpReauthorize) {
    let row = this.visibleRow(identity, id);
    const { engine, position } = await this.engineAt(row, tick);
    identity = await this.recheckIdentity(identity, reauthorize);
    row = this.visibleRow(identity, id);
    const state = engine.state(false);
    const players = state.players.map((p) => {
      const unitCounts: Record<string, number> = {};
      for (const u of p.units) unitCounts[u.type] = (unitCounts[u.type] ?? 0) + 1;
      return { side: p.side, name: p.name, alive: p.alive, tiles: p.tiles, troops: Math.round(p.troops), maxTroops: Math.round(p.maxTroops), gold: Math.round(p.gold), outgoingAttacks: p.attacks.length, committedTroops: Math.round(p.attacks.reduce((s, a) => s + a.troops, 0)), unitCounts };
    });
    return {
      provenance: this.provenance(row, identity, position, state.tick, state.fingerprint),
      exercise: { id: row.id, name: clip(row.name), humanSide: row.humanSide, yourSide: row.humanSide },
      state: { tick: state.tick, fingerprint: state.fingerprint, spawning: state.spawning, map: state.map, width: state.width, height: state.height, simulationId: state.simulationId, players },
      omitted: ["tile ownership map", "unit positions", "attack targets"],
    };
  }

  async stationObjectives(identity: Identity, id: string, tick: number | null, reauthorize?: McpReauthorize) {
    let row = this.visibleRow(identity, id);
    const { engine, position } = await this.engineAt(row, tick);
    identity = await this.recheckIdentity(identity, reauthorize);
    row = this.visibleRow(identity, id);
    const w = this.service.world(row.id);
    const provenance = this.provenance(row, identity, position, engine.game.ticks(), engine.state().fingerprint);
    const view = networkAt(this.service.store, row, engine, w.campaign);
    if (!view) return { provenance, available: false as const, reason: "This scenario has no station objectives; victory follows the last-side-standing rule." };
    return {
      provenance,
      available: true as const,
      rulesId: view.rules.id,
      description: view.description,
      tick: view.tick,
      scores: view.scores,
      stations: view.stations.map((s) => ({ id: s.id, name: s.name, controller: s.controller, held: s.held, totalTiles: s.total, priority: s.priority })),
      reserve: view.reserve,
      priorityId: view.priorityId,
      nextAwardTick: view.nextAwardTick,
      nextPriorityTick: view.nextPriorityTick,
      lastAwardTick: view.lastAwardTick,
      inheritedFromParent: view.inherited,
      basis: "Deterministic game rules over canonical engine state. Points describe game outcomes, never learning mastery.",
    };
  }

  teamAssessments(identity: Identity, id: string, tick: number | null) {
    const row = this.visibleRow(identity, id);
    const { asOf, position } = this.cutoffOf(row, tick);
    const canBoth = this.canBoth(identity, row);
    const sourceIds = new Set(this.service.store.reports(row.id, asOf).filter((r) => canBoth || r.side === row.humanSide).map((r) => r.id));
    const events = this.service.store.events(row.id, asOf).filter((e) => e.kind === "assessment_log" && (canBoth || !e.side || e.side === row.humanSide));
    const entries = events.slice(-MAX_LISTED_ASSESSMENTS).map((e) => ({
      id: e.id,
      tick: e.tick,
      observedTick: typeof e.details?.observedTick === "number" ? e.details.observedTick : e.tick,
      side: e.side ?? null,
      timing: e.details?.timing === "post-hoc" ? "post-hoc" : "contemporaneous",
      author: { subject: e.actor, name: typeof e.details?.authorName === "string" ? e.details.authorName : null, role: typeof e.details?.authorRole === "string" ? e.details.authorRole : null },
      text: clip(typeof e.details?.text === "string" ? e.details.text : e.summary),
      sourceIds: Array.isArray(e.details?.sourceIds) ? e.details.sourceIds.filter((s: unknown): s is string => typeof s === "string" && sourceIds.has(s)).slice(0, 20) : [],
      recordedAt: typeof e.details?.recordedAt === "string" ? e.details.recordedAt : e.recordedAt,
    }));
    return {
      provenance: this.provenance(row, identity, position, asOf, null),
      entries,
      truncated: events.length > entries.length,
      excludedKinds: ["instructor judgments", "generated debriefs", "decision statements", "model traces"],
      basis: "Human-authored assessment entries recorded in the exercise timeline; timing is labelled at recording time and never re-derived.",
    };
  }

  keyMoments(identity: Identity, id: string, tick: number | null, limit: number) {
    const row = this.visibleRow(identity, id);
    const { asOf, position } = this.cutoffOf(row, tick);
    const canBoth = this.canBoth(identity, row);
    const record = this.service.learningRecord(row.id);
    const reports = this.service.store.reports(row.id, asOf).filter((r) => canBoth || r.side === row.humanSide);
    const reportById = new Map(reports.map((r) => [r.id, r]));
    const sourceVisible = (id: unknown, at: number) => typeof id === "string" && (reportById.get(id)?.tick ?? Infinity) <= at;
    // The shared selector also supports team staff records. This MCP tool promises
    // own participant acts, so narrow its input before candidate counts and prose exist.
    const events = record.events.filter((e) => e.tick <= asOf && (canBoth || !e.side || e.side === row.humanSide))
      .filter((e) => identity.role === "instructor" || !["staff_update", "task_created", "decision_log"].includes(e.kind) || e.actor === identity.subject)
      .filter((e) => e.kind !== "report" || (sourceVisible(e.details?.reportId, e.tick) && (!e.details?.supersedes || sourceVisible(e.details.supersedes, e.tick))))
      .map((e) => Array.isArray(e.details?.sourceIds) ? { ...e, details: { ...e.details, sourceIds: e.details.sourceIds.filter((id: unknown) => sourceVisible(id, e.tick)) } } : e);
    const selection = selectKeyMoments({
      record: { ...record, events, reports },
      scope: identity.role === "instructor" ? { kind: "shared" } : { kind: "own", subject: identity.subject },
      cutoff: { tick: asOf },
      viewerSide: row.humanSide,
      bothSidesVisible: canBoth,
      limit,
    });
    // Never expose the selector's diagnostic exclusions: those can name future or other-side records.
    return {
      provenance: this.provenance(row, identity, position, asOf, null),
      schema: selection.schema,
      scope: selection.scope,
      cutoff: selection.cutoff,
      selected: selection.selected.map((m) => ({ ...m, title: clip(m.title), reasons: m.reasons.map(clip), interpretation: clip(m.interpretation) })),
      candidateCount: selection.candidates.length,
      limitations: selection.limitations,
    };
  }

  replayProvenance(identity: Identity, id: string, tick: number | null) {
    const row = this.visibleRow(identity, id);
    const { asOf, position } = this.cutoffOf(row, tick);
    const canBoth = this.canBoth(identity, row);
    const turns = this.service.store.turns(row.id).filter((t) => t.tick <= asOf);
    const latest = turns.at(-1) ?? null;
    const atCutoff = turns.find((t) => t.tick === asOf) ?? null;
    const scenario = recordedScenario(row.options ?? {});
    const reports = this.service.store.reports(row.id, asOf).filter((r) => canBoth || r.side === row.humanSide);
    const reportIds = new Set(reports.map((r) => r.id));
    const parent = this.visibleParent(identity, row);
    const parentReportIds = new Set(parent ? this.service.store.reports(parent.id, Math.min(asOf, row.forkTick ?? asOf)).filter((r) => this.canBoth(identity, parent) || r.side === parent.humanSide).map((r) => r.id) : []);
    const released = reports.slice(-MAX_LISTED_REPORTS).map((r) => ({
      id: r.id,
      tick: r.tick,
      side: r.side,
      title: clip(r.title),
      source: typeof r.source === "string" ? clip(r.source) : null,
      confidence: typeof r.confidence === "string" ? clip(r.confidence) : null,
      supersedes: r.supersedes && reportIds.has(r.supersedes) ? r.supersedes : null,
      inheritedFromParentReport: r.parentSourceId && parentReportIds.has(r.parentSourceId) ? r.parentSourceId : null,
      synthetic: r.synthetic === true,
      ...(r.packet?{packet:r.packet,evidenceStatus:r.evidenceStatus,supersededBy:r.supersededBy??null,disputedWith:r.disputedWith??[]}:{}),
    }));
    const scope = this.scopeOf(identity);
    return {
      provenance: this.provenance(row, identity, position, asOf, atCutoff?.fingerprint ?? null),
      exercise: { id: row.id, name: clip(row.name), kind: row.kind, status: row.status, humanSide: row.humanSide, createdAt: row.createdAt },
      lineage: { parentId: parent?.id ?? null, forkTick: row.forkTick ?? null, interpretation: row.parentId ? "Branch: informed practice continued from the parent's recorded state" : "Independent exercise" },
      attribution: { label: scope.attribution(row), assistance: typeof row.options?.assistance === "string" ? row.options.assistance : "unknown", curriculumVersion: typeof row.options?.curriculumVersion === "string" ? row.options.curriculumVersion : null },
      scenario: { id: typeof row.options?.scenarioId === "string" ? row.options.scenarioId : null, catalogId: scenario?.id ?? null, baselineController: controllerLabel(row.options ?? {}), controllerHistory: "Configured baseline only; model-driven play may also be present. This read does not summarize model usage or expose model traces.", victory: scenario?.victory ?? "last-side-standing/1" },
      engine: { upstreamCommit: UPSTREAM_COMMIT, simulationProfile: typeof row.options?.simulationProfile === "string" ? row.options.simulationProfile : null },
      record: { recordedTurns: turns.length, latestTick: latest?.tick ?? null, latestFingerprint: latest?.fingerprint ?? null, cutoffFingerprint: atCutoff?.fingerprint ?? null, integrityNote: "SHA256 fingerprints are integrity references, not proof against administrator modification." },
      releasedReports: released,
      truncated: reports.length > released.length,
      basis: "Reports are synthetic engine observations or explicitly labelled fictional scenario claims. Authored claims are not measured game state. Releases and relationships are evaluated at the cutoff; correction never deletes history and repeated claims are not independent corroboration.",
    };
  }

  // -------------------------------------------------------------------------
  // Scope and cutoff helpers
  // -------------------------------------------------------------------------

  private scopeOf(identity: Identity): ExerciseScope {
    return exerciseScope(this.config, identity, (row) => this.service.teams.includes(row, identity.subject));
  }

  /** Rows outside scope and rows without a loaded world are indistinguishable from unknown ids to a stranger. */
  private visibleRow(identity: Identity, id: string): ExerciseRow {
    const row = this.service.store.exercise(id);
    if (!row || !this.service.worlds.has(row.id) || !this.scopeOf(identity).visible(row)) throw new McpToolError("exercise_not_found", "Exercise not found");
    return row;
  }

  private visibleParent(identity: Identity, row: ExerciseRow): ExerciseRow | null {
    if (!row.parentId) return null;
    const parent = this.service.store.exercise(row.parentId);
    return parent && this.scopeOf(identity).visible(parent) ? parent : null;
  }

  private async recheckIdentity(identity: Identity, reauthorize?: McpReauthorize): Promise<Identity> {
    if (!reauthorize) return identity;
    const fresh = await reauthorize();
    if (fresh.subject !== identity.subject || fresh.mode !== "kamiwaza") throw new McpToolError("unavailable", "Caller identity changed during the read");
    return fresh;
  }

  private canBoth(identity: Identity, row: ExerciseRow): boolean {
    return identity.role === "instructor" || row.status === "completed";
  }

  private cutoffOf(row: ExerciseRow, tick: number | null): { asOf: number; position: "live" | "historical" } {
    const current = this.service.world(row.id).engine.game.ticks();
    if (tick === null) return { asOf: current, position: "live" };
    if (tick > current) throw new McpToolError("tick_unavailable", `Tick ${tick} is beyond the recorded history (current tick ${current})`);
    return { asOf: tick, position: "historical" };
  }

  private async engineAt(row: ExerciseRow, tick: number | null) {
    const w = this.service.world(row.id);
    const { asOf, position } = this.cutoffOf(row, tick);
    if (position === "live") return { engine: w.engine, position, asOf };
    try {
      return { engine: await this.service.historical(row.id, asOf), position, asOf };
    } catch (e) {
      throw new McpToolError("tick_unavailable", /replay tick/i.test(String((e as Error)?.message)) ? `Tick ${asOf} cannot be reconstructed from the recorded history` : "Historical reconstruction is unavailable for this exercise");
    }
  }

  private provenance(row: ExerciseRow, identity: Identity, position: "live" | "historical", cutoffTick: number, fingerprint: string | null): McpProvenance {
    return {
      fiction: true,
      notice: FICTION_NOTICE,
      exerciseId: row.id,
      exerciseKind: row.kind,
      status: row.status,
      position,
      cutoffTick,
      fingerprint,
      viewerSide: row.humanSide,
      bothSidesVisible: this.canBoth(identity, row),
      generatedAt: this.now().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse<T>(s: z.ZodType<T>, args: unknown): T {
  const r = s.safeParse(args);
  if (!r.success) throw new McpToolError("invalid_params", "Arguments did not match the tool schema");
  return r.data;
}

function clip(s: string): string {
  return s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS - 1)}…` : s;
}
