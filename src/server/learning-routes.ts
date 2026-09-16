/**
 * Learning routes: dossier, decision/assessment logs and the paid, cached debrief.
 *
 * Mounted by main after the app's session middleware, which sets `res.locals.session`
 * (server-held; the browser never supplies a role) and, under native Kamiwaza identity,
 * `res.locals.native` with the platform-verified context. Writes under native identity
 * require `native.context.canEdit`; the browser's claims are never consulted.
 *
 * Route errors are answered here with the status the service assigned (404/403/409/422/
 * 429/503) so a rejected model output is never presented as a success and no error carries
 * provider detail beyond a short code and receipt id.
 */
import type express from 'express';
import { z } from 'zod';
import { GameService, ServiceError, type Session } from './service';

const idSchema = z.string().min(1).max(200);
const sourceIdsSchema = z.array(z.string().min(1).max(200)).max(20).optional();

interface NativeLocals { identity?: { subject?: string }; context?: { canEdit?: boolean; readOnlyReason?: string | null } }

function sessionOf(res: express.Response): Session {
  const s = res.locals.session as Session | undefined;
  if (!s || !s.identity || !s.activeId) throw new ServiceError(401, 'No exercise session');
  const native = res.locals.native as NativeLocals | undefined;
  if (native?.identity?.subject && native.identity.subject !== s.identity.subject) throw new ServiceError(403, 'Native identity does not match the exercise session');
  return s;
}

/** Writes under native identity are gated by the platform's fresh `can_edit`, not by anything the browser sent. */
function requireWrite(res: express.Response): Session {
  const s = sessionOf(res);
  if (s.identity.mode === 'kamiwaza') {
    const native = res.locals.native as NativeLocals | undefined;
    if (!native?.context) throw new ServiceError(403, 'Native workroom context is required for writes');
    if (native.context.canEdit !== true) throw new ServiceError(403, `Native workroom context does not permit writes${native.context.readOnlyReason ? ` (${native.context.readOnlyReason})` : ''}`);
  }
  return s;
}

function send(res: express.Response, err: unknown) {
  if (err instanceof ServiceError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Request did not match the expected schema' });
  const message = String((err as Error)?.message ?? 'Request failed').replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
  if (/not found|not a human order/i.test(message)) return res.status(404).json({ error: message });
  return res.status(400).json({ error: message });
}

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;
const wrap = (h: Handler): express.RequestHandler => async (req, res) => { try { await h(req, res); } catch (e) { send(res, e); } };

export function mountLearningRoutes(app: express.Router, service: GameService) {
  app.get('/api/learning/dossier', wrap((_req, res) => {
    const session = sessionOf(res);
    const r = service.dossier(session);
    res.json({ attributed: r.attributed, reason: r.reason, dossier: r.dossier ?? null, exerciseId: session.activeId, budget: budgetOf(service) });
  }));

  app.get('/api/learning/dossier.md', wrap((_req, res) => {
    const session = sessionOf(res);
    const r = service.dossier(session);
    if (!r.attributed || !r.markdown) throw new ServiceError(409, r.reason);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="replay-dossier-${session.activeId.slice(0, 8)}.md"`);
    res.send(r.markdown);
  }));

  app.post('/api/learning/decision-log', wrap((req, res) => {
    const session = requireWrite(res);
    const body = z.object({ eventId: idSchema, text: z.string().min(1).max(2000), sourceIds: sourceIdsSchema }).parse(req.body);
    res.status(201).json(service.decisionLog(session, body));
  }));

  app.post('/api/learning/assessment', wrap((req, res) => {
    const session = requireWrite(res);
    const body = z.object({ text: z.string().min(1).max(2000), sourceIds: sourceIdsSchema, exerciseId:idSchema.optional() }).parse(req.body);
    res.status(201).json(service.assessmentLog(session, body));
  }));

  app.get('/api/learning/intake',wrap((_req,res)=>{res.json(service.noteIntakeHistory(sessionOf(res)));}));
  app.get('/api/learning/intake/:sha256',wrap((req,res)=>{res.json(service.intakeSource(sessionOf(res),z.string().parse(req.params.sha256)));}));
  app.post('/api/learning/intake',wrap((req,res)=>{const body=z.object({exerciseId:idSchema,filename:z.string().max(150),text:z.string().max(100000)}).strict().parse(req.body);res.status(201).json(service.intakeNotes(requireWrite(res),body));}));

  app.get('/api/learning/retrieval/:eventId', wrap((req,res)=>{res.json(service.decisionRetrieval(sessionOf(res),idSchema.parse(req.params.eventId)));}));

  app.get('/api/learning/debrief/:eventId', wrap((req, res) => {
    const session = sessionOf(res);
    const eventId = idSchema.parse(req.params.eventId);
    const cached = service.cachedDebrief(session, eventId);
    if (!cached) return void res.status(404).json({ error: 'No debrief has been generated for this order', eventId });
    res.json({ ...cached, budget: budgetOf(service) });
  }));

  app.post('/api/learning/debrief', wrap(async (req, res) => {
    const session = requireWrite(res);
    const body = z.object({ eventId: idSchema }).parse(req.body);
    const result = await service.debrief(session, body.eventId,res.locals.resolveAgentAuthority);
    res.status(result.status === 'generated' ? 201 : 200).json({ ...result, budget: budgetOf(service) });
  }));
}

function budgetOf(service: GameService) {
  const s = service.ledger.summary();
  return { allowance:s.allowance,requestsUsed: s.requestsUsed, maxRequests: s.maxRequests, committedUsd: s.committedUsd, maxUsd: s.maxUsd };
}
