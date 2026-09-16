/**
 * Idempotent free-watch creation for a later MCP write tool.
 *
 * One bounded mutation: a platform-authenticated caller asks for a deterministic watch on an
 * exercise it can see. Everything else is derived, never accepted from the request:
 *  - side is the exercise's `humanSide` (no side override);
 *  - tick is the live engine tick (no tick override);
 *  - the owner is the resolved native subject;
 *  - paid analysis stays off (`modelEnabled:false`); no orders, no model enablement.
 *
 * Authorization intersects the native context with app scope: a fresh, active, editable context for
 * the configured workroom, a `kamiwaza` identity, and `exerciseScope(...).visible` for the row.
 * Invisible and unknown exercises are indistinguishable.
 *
 * Idempotency is anchored in one persisted `mcp_watch_request` event whose primary id is derived
 * from (exercise, subject, requestId), so the events table's UNIQUE id rejects duplicates across
 * restarts and concurrent callers. The event carries a fingerprint of the normalized payload: an
 * identical retry returns the original task, a different payload under the same requestId is a
 * conflict. `GameService.createTask` and the receipt commit in one transaction.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { exerciseScope, type KamiwazaConfig } from "./native-http";
import type { McpPrincipal } from "./mcp-auth";
import { ServiceError, type GameService } from "./service";

export const MCP_WATCH_EVENT_KIND = "mcp_watch_request";
/** A principal is resolved per MCP call; anything older than this is not a current authorization. */
export const MCP_WATCH_MAX_CONTEXT_AGE_MS = 120_000;

export const mcpWatchRequestSchema = z.strictObject({
  exerciseId: z.uuid(),
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(500),
});
export type McpWatchRequest = z.infer<typeof mcpWatchRequestSchema>;

export type McpWatchErrorCode = "invalid_params" | "write_denied" | "stale_context" | "workroom_mismatch" | "exercise_not_found" | "exercise_not_running" | "unsupported_watch" | "idempotency_conflict";

export class McpWatchError extends Error {
  constructor(readonly code: McpWatchErrorCode, readonly httpStatus: 400 | 403 | 404 | 409 | 422, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "McpWatchError";
  }
}

export interface McpWatchReceipt {
  task: { id: string; kind: string; phase: string; /** False at creation; a replay reports the current value. */ modelEnabled: boolean; side: "blue" | "red"; title: string; interpretation: string | null; createdTick: number };
  receipt: { requestId: string; eventId: string; fingerprint: string; replayed: boolean };
  provenance: { exerciseId: string; exerciseKind: string; taskCreatedEventId: string | null; fiction: "Fictional abstract exercise"; paidInference: "off-at-creation" };
}

interface ReceiptDetails { requestId: string; fingerprint: string; taskId: string; taskCreatedEventId: string | null }

const deny = (message: string) => new McpWatchError("write_denied", 403, message);

export function createMcpWatch(service: GameService, config: KamiwazaConfig, principal: McpPrincipal, input: unknown, now: () => number = Date.now): McpWatchReceipt {
  const parsed = mcpWatchRequestSchema.safeParse(input);
  if (!parsed.success) throw new McpWatchError("invalid_params", 400, "Invalid watch request");
  const request = parsed.data;
  const { identity, context } = principal;

  if (config.mode !== "kamiwaza" || identity.mode !== "kamiwaza" || !identity.subject) throw deny("Watch creation requires a native workroom identity");
  if (context.workroomId !== config.workroomId) throw new McpWatchError("workroom_mismatch", 403, "Native context names a different workroom");
  const validatedAt = Date.parse(context.validatedAt);
  if (context.fresh !== true || !Number.isFinite(validatedAt) || (now() - validatedAt > MCP_WATCH_MAX_CONTEXT_AGE_MS || validatedAt > now()+5000)) throw new McpWatchError("stale_context", 403, "Native context is not current; re-authorize and retry");
  if (context.canEdit !== true || context.accessState !== "active") throw deny("Your workroom access does not permit changes");

  const row = service.store.exercise(request.exerciseId);
  const scope = exerciseScope(config, identity, (r) => service.teams.includes(r, identity.subject));
  if (!row || !service.worlds.has(row.id) || !scope.visible(row)) throw new McpWatchError("exercise_not_found", 404, "Exercise not found");

  const fingerprint = digest(JSON.stringify(["replay.mcp-watch/1", request.exerciseId, request.title]));
  const eventId = receiptEventId(request.exerciseId, identity.subject, request.requestId);
  const existing = readReceipt(service, eventId);
  if (existing) return replay(service, row.id, existing, request.requestId, eventId, fingerprint);

  const world = service.world(row.id);
  if (world.row.status !== "running") throw new McpWatchError("exercise_not_running", 409, "Create a watch in a running exercise");
  const side = world.row.humanSide;

  const store = service.store;
  let result: McpWatchReceipt | undefined;
  try {
    store.transaction(() => {
      // Re-check inside the write lock so a concurrent identical request replays instead of duplicating.
      const raced = readReceipt(service, eventId);
      if (raced) { result = replay(service, row.id, raced, request.requestId, eventId, fingerprint); return; }
      // Store uses a nested savepoint; no shared method replacement is necessary.
      const task = service.createTask(row.id, identity, request.title, side);
      const created = store.db.prepare("SELECT id FROM events WHERE exercise_id=? AND kind='task_created' AND json_extract(details,'$.taskId')=? ORDER BY sequence DESC LIMIT 1").get(row.id, task.id) as { id: string } | undefined;
      const details: ReceiptDetails = { requestId: request.requestId, fingerprint, taskId: task.id, taskCreatedEventId: created?.id ?? null };
      store.db.prepare("INSERT INTO events(id,exercise_id,tick,kind,actor,side,summary,details,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(eventId, row.id, task.createdTick, MCP_WATCH_EVENT_KIND, identity.subject, side, `Watch requested through workroom assistant: ${task.title}`, JSON.stringify(details), new Date(now()).toISOString());
      result = receiptFor(service, row.id, task, { ...details, eventId, replayed: false });
    });
  } catch (error) {
    if (error instanceof McpWatchError) throw error;
    if (error instanceof ServiceError && error.extra.code === "unsupported_watch") throw new McpWatchError("unsupported_watch", 422, error.message, { examples: error.extra.examples });
    if (error instanceof ServiceError && error.status === 409) throw new McpWatchError("exercise_not_running", 409, error.message);
    throw error;
  }
  return result!;
}

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }

/** Deterministic UUID-shaped id (version nibble 8) so the events table's UNIQUE id enforces one receipt. */
function receiptEventId(exerciseId: string, subject: string, requestId: string) {
  const h = digest(JSON.stringify(["replay.mcp-watch-receipt/1", exerciseId, subject, requestId]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function readReceipt(service: GameService, eventId: string): ReceiptDetails | null {
  const r = service.store.db.prepare("SELECT details FROM events WHERE id=? AND kind=?").get(eventId, MCP_WATCH_EVENT_KIND) as { details: string } | undefined;
  return r ? JSON.parse(r.details) as ReceiptDetails : null;
}

function replay(service: GameService, exerciseId: string, prior: ReceiptDetails, requestId: string, eventId: string, fingerprint: string): McpWatchReceipt {
  if (prior.fingerprint !== fingerprint) throw new McpWatchError("idempotency_conflict", 409, "requestId was already used with a different watch request");
  const task = service.store.tasks(exerciseId).find((t) => t.id === prior.taskId);
  if (!task) throw new McpWatchError("idempotency_conflict", 409, "The watch recorded for this requestId is no longer available");
  return receiptFor(service, exerciseId, task, { ...prior, requestId, eventId, replayed: true });
}

function receiptFor(service: GameService, exerciseId: string, task: any, r: ReceiptDetails & { eventId: string; replayed: boolean }): McpWatchReceipt {
  return {
    task: { id: task.id, kind: task.kind, phase: task.phase, modelEnabled: task.modelEnabled === true, side: task.side, title: task.title, interpretation: task.interpretation ?? null, createdTick: task.createdTick },
    receipt: { requestId: r.requestId, eventId: r.eventId, fingerprint: r.fingerprint, replayed: r.replayed },
    provenance: { exerciseId, exerciseKind: service.store.exercise(exerciseId)?.kind ?? "live", taskCreatedEventId: r.taskCreatedEventId, fiction: "Fictional abstract exercise", paidInference: "off-at-creation" },
  };
}
