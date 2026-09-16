/**
 * Agent routes: auth-scoped tool catalog, per-task paid staff opt-in, and a task trace.
 *
 * Mounted by main after the app's session middleware (`res.locals.session`, and under native
 * Kamiwaza identity `res.locals.native`). Same conventions as learning-routes: the browser never
 * supplies a role; writes under native identity need a fresh `can_edit`, and enabling paid staff
 * analysis additionally needs a fresh `can_run_agents`.
 */
import type express from 'express';
import {taskView} from './task-view';
import { z } from 'zod';
import { GameService, ServiceError, type Session } from './service';

const idSchema = z.string().min(1).max(200);
const sideSchema = z.enum(['blue', 'red']);

interface NativeLocals { identity?: { subject?: string }; context?: { canEdit?: boolean; canRunAgents?: boolean; fresh?: boolean; readOnlyReason?: string | null } }

function sessionOf(res: express.Response): Session {
  const s = res.locals.session as Session | undefined;
  if (!s || !s.identity || !s.activeId) throw new ServiceError(401, 'No exercise session');
  const native = res.locals.native as NativeLocals | undefined;
  if (native?.identity?.subject && native.identity.subject !== s.identity.subject) throw new ServiceError(403, 'Native identity does not match the exercise session');
  return s;
}

function nativeContext(res: express.Response, s: Session) {
  if (s.identity.mode !== 'kamiwaza') return null;
  const native = res.locals.native as NativeLocals | undefined;
  if (!native?.context) throw new ServiceError(403, 'Native workroom context is required for writes');
  if (native.context.fresh === false) throw new ServiceError(403, 'Native workroom context is stale; sign in again');
  return native.context;
}

function requireWrite(res: express.Response): Session {
  const s = sessionOf(res);
  const ctx = nativeContext(res, s);
  if (ctx && ctx.canEdit !== true) throw new ServiceError(403, `Native workroom context does not permit writes${ctx.readOnlyReason ? ` (${ctx.readOnlyReason})` : ''}`);
  return s;
}

/** Paid staff analysis is agent control: fresh native `can_run_agents`, never a browser claim. */
function requireAgents(res: express.Response): Session {
  const s = requireWrite(res);
  const ctx = nativeContext(res, s);
  if (ctx && ctx.canRunAgents !== true) throw new ServiceError(403, 'Native workroom context does not permit running agents');
  return s;
}

function send(res: express.Response, err: unknown) {
  if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Request did not match the expected schema' });
  const message = String((err as Error)?.message ?? 'Request failed').replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
  if (/not found/i.test(message)) return res.status(404).json({ error: message });
  return res.status(400).json({ error: message });
}

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (h: Handler): express.RequestHandler => async (req, res) => { try { await h(req, res); } catch (e) { send(res, e); } };

const TRACE_KINDS = new Set(['task_created', 'task_model_changed', 'staff_update', 'staff_model_decision', 'staff_tool_result', 'staff_rejected', 'staff_model_error', 'staff_result_discarded']);

export function mountAgentRoutes(app: express.Router, service: GameService) {
  /** Tools the caller's seat may use for a side, plus what is deliberately unavailable. */
  app.get('/api/agents/tools', wrap((req, res) => {
    const session = sessionOf(res);
    const side = sideSchema.optional().parse(typeof req.query.side === 'string' ? req.query.side : undefined) ?? service.world(session.activeId).row.humanSide;
    res.json(service.availableTools(session, side));
  }));

  /** Enable or disable bounded paid staff analysis for one task. Disabling never cancels the deterministic watch. */
  app.post('/api/agents/tasks/:id/model', wrap((req, res) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const session = body.enabled ? requireAgents(res) : requireWrite(res);
    const task = service.setTaskModel(session, idSchema.parse(req.params.id), body.enabled);
    const s = service.ledger.summary();
    res.json({ task, budget: { allowance:s.allowance,requestsUsed: s.requestsUsed, maxRequests: s.maxRequests, committedUsd: s.committedUsd, maxUsd: s.maxUsd } });
  }));

  /** Task with its external trace (updates, model decisions, tool receipts, rejections). Own side only unless instructor or completed. */
  app.get('/api/agents/tasks/:id', wrap((req, res) => {
    const session = sessionOf(res);
    const id = idSchema.parse(req.params.id);
    const w = service.world(session.activeId);
    const task = service.store.tasks(w.row.id).find((t) => t.id === id);
    if (!task || session.playbackTick!==null&&task.createdTick>session.playbackTick) throw new ServiceError(404, 'Task not found');
    const canBoth = session.identity.role === 'instructor' || w.row.status === 'completed';
    if (task.side !== w.row.humanSide && !canBoth) throw new ServiceError(403, 'Task belongs to the opposing side');
    const events=service.store.events(w.row.id,session.playbackTick??undefined);
    const trace = events.filter((e) => TRACE_KINDS.has(e.kind) && e.details?.taskId === id).map((e) => ({ id: e.id, tick: e.tick, kind: e.kind, summary: e.summary, receiptId: e.details?.receiptId ?? e.details?.receipt?.id ?? null, method: e.details?.method ?? null, errors: e.details?.errors ?? null, recordedAt: e.recordedAt }));
    res.json({ task:taskView(task,events,session.playbackTick), trace });
  }));
}
