/**
 * `POST /mcp`: minimal Streamable-HTTP JSON-RPC surface for Tomo (Kaizen 0.4.1).
 *
 * Transport facts this module is built against (docs/process/tomo-native-contract.md §1):
 *  - Tomo POSTs single JSON-RPC objects and parses the response as one JSON
 *    body; it advertises `text/event-stream` but never consumes it. Answers are
 *    therefore plain `application/json`, never SSE.
 *  - Tomo repeats `initialize` + `notifications/initialized` before every tool
 *    call with a fresh client. There is no session: every request, handshakes
 *    included, is authenticated afresh from its own `Authorization` bearer and
 *    `x-workroom-id` through `McpAuthPort` (no `mcp-session-id` is issued).
 *  - Tomo classifies a tool as `read` only when `annotations.readOnlyHint` is
 *    true; the seven read tools carry it; optional free-watch creation is explicitly a write.
 *
 * Mount point: main should mount this through `createApp({ mountInternal })`
 * so it runs before the `/api` cookie/session middleware and before the
 * static catch-all. Nothing here touches `res.locals.session`, the session
 * store, or navigation state.
 *
 * Errors: auth failures answer with the resolver's HTTP status and a JSON-RPC
 * error whose `data.code` is the typed denial. Tool-level denials (scope, time)
 * are JSON-RPC results with `isError: true`, as the MCP spec expects. Messages
 * are redacted; request bodies and headers are never logged or echoed.
 */
import express from "express";
import { z } from "zod";
import { McpAuthError, type McpAuthPort, type McpPrincipal } from "./mcp-auth.ts";
import { McpService, McpToolError } from "./mcp-service.ts";
import {createMcpWatch,mcpWatchRequestSchema,McpWatchError} from "./mcp-watch-service";
import type { KamiwazaConfig } from "./native-http.ts";
import type { GameService } from "./service.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpRouteOptions {
  service: GameService;
  config: KamiwazaConfig;
  auth: McpAuthPort;
  /** Defaults to a `McpService` over `service`/`config`. */
  tools?: McpService;
  /** Reported as `serverInfo.version`. */
  version?: string;
  /** Defaults to `/mcp`. */
  path?: string;
  /** Body limit for `express.json`. Defaults to 16kb; tool arguments are tiny. */
  bodyLimit?: string;
  /** Explicitly expose one idempotent free-watch write tool. */
  enableWatchTool?: boolean;
}

export const MCP_WATCH_TOOL = {
 name:'create_watch',title:'Create a free exercise watch',
 description:'Delegate a durable free watch in an explicit running fictional exercise you can edit. Reuse the same requestId UUID when retrying. Supported example: Monitor report provenance. This creates a watch for your assigned side, never orders or paid analysis.',
 inputSchema:z.toJSONSchema(mcpWatchRequestSchema),
 annotations:{title:'Create a free exercise watch',readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
};
export const MCP_SERVER_NAME = "replay";
export const MCP_SERVER_TITLE = "REPLAY read tools (fictional exercise data)";
/** Protocol revisions this server will echo back. Anything else is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const INSTRUCTIONS =
  "All data is from a fictional educational strategy exercise (REPLAY on a pinned OpenFront engine). Reports are synthetic; opponents may be scripted or model-driven. Consult per-exercise provenance; the configured baseline does not establish model usage. Every result carries a provenance block: treat `position: historical` as a reconstruction at `cutoffTick`, and `exerciseKind: branch` as informed practice. Read tools run as the calling member; they cannot issue orders, navigate anyone's view, or see another participant's personal coaching.";

// JSON-RPC 2.0 codes plus one server-defined code for platform denials.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const AUTH_ERROR = -32001;

type RpcId = string | number | null;

const idSchema = z.union([z.string().max(256), z.number().finite(), z.null()]);
const requestSchema = z.object({ jsonrpc: z.literal("2.0"), method: z.string().min(1).max(128), params: z.unknown().optional(), id: idSchema.optional() }).strict();
const callParams = z.object({ name: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).optional(), _meta: z.unknown().optional() }).strict();
const initializeParams = z.object({
  protocolVersion: z.string().min(1).max(32),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string().min(1).max(128), version: z.string().max(128), title: z.string().max(128).optional() }).strict(),
  _meta: z.record(z.string(), z.unknown()).optional(),
}).strict();
const emptyParams = z.object({ _meta: z.record(z.string(), z.unknown()).optional() }).strict();

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountMcpRoutes(app: express.IRouter, opts: McpRouteOptions): void {
  if (opts.config.mode !== "kamiwaza") throw new Error("The MCP surface requires native Kamiwaza mode");
  if (opts.auth.workroomId !== opts.config.workroomId) throw new Error("MCP auth workroom differs from the configured workroom");
  const tools = opts.tools ?? new McpService({ service: opts.service, config: opts.config });
  const mountPath = opts.path ?? "/mcp";
  const version = opts.version ?? "0.0.0";
  const catalog=()=>[...tools.tools(),...(opts.enableWatchTool?[MCP_WATCH_TOOL]:[])];

  const send = (res: express.Response, status: number, body: unknown) => {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (body === undefined) return res.end();
    return res.end(JSON.stringify(body));
  };
  const rpcError = (id: RpcId, code: number, message: string, data?: Record<string, unknown>) => ({ jsonrpc: "2.0" as const, id, error: { code, message, ...(data ? { data } : {}) } });
  const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
  // Error text from arbitrary adapters may contain opaque credentials that regexes cannot recognize.
  const authFailure = (res: express.Response, id: RpcId, err: unknown) =>
    send(res, err instanceof McpAuthError ? err.httpStatus : 503, rpcError(id, AUTH_ERROR, "Native authentication denied or unavailable", { code: err instanceof McpAuthError ? err.code : "platform_unavailable" }));

  // Non-POST is refused without touching the platform. No redirects are ever issued.
  app.all(mountPath, (req, res, next) => {
    if (req.method === "POST") return next();
    res.setHeader("Allow", "POST");
    send(res, 405, rpcError(null, INVALID_REQUEST, "The MCP endpoint accepts POST only"));
  });

  const jsonParser = express.json({ limit: opts.bodyLimit ?? "16kb", type: ["application/json", "application/*+json"] });
  const parseFailure: express.ErrorRequestHandler = (err, _req, res, next) => {
    const type = (err as { type?: string })?.type;
    if (type === "entity.parse.failed") return send(res, 400, rpcError(null, PARSE_ERROR, "Request body is not valid JSON"));
    if (type === "entity.too.large") return send(res, 413, rpcError(null, INVALID_REQUEST, "Request body too large"));
    if (type === "charset.unsupported" || type === "encoding.unsupported") return send(res, 415, rpcError(null, INVALID_REQUEST, "Unsupported body encoding"));
    next(err);
  };

  const handler: express.RequestHandler = async (req, res) => {
    // 1. Shape. Batches are refused; Tomo never sends them and a batch would let one bearer fan out.
    const body: unknown = req.body;
    if (Array.isArray(body)) return send(res, 400, rpcError(null, INVALID_REQUEST, "Batch requests are not supported"));
    if (!body || typeof body !== "object") return send(res, 400, rpcError(null, INVALID_REQUEST, "A JSON-RPC 2.0 request object is required"));
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      const rawId = (body as { id?: unknown }).id;
      const id = idSchema.safeParse(rawId).success ? (rawId as RpcId) : null;
      return send(res, 400, rpcError(id, INVALID_REQUEST, "Request is not a JSON-RPC 2.0 request with a string method"));
    }
    const { method, params } = parsed.data;
    const isNotification = parsed.data.id === undefined;
    const id: RpcId = parsed.data.id ?? null;

    // 2. Fresh platform authentication for every request, handshakes and notifications included.
    let principal: McpPrincipal;
    try {
      principal = await opts.auth.resolve(req.headers as Record<string, string | string[] | undefined>);
    } catch (err) {
      return authFailure(res, id, err);
    }

    // 3. Notifications carry no response body.
    if (isNotification) return send(res, 202, undefined);

    // 4. Dispatch.
    try {
      switch (method) {
        case "initialize": {
          const p = initializeParams.safeParse(params);
          if (!p.success) return send(res, 200, rpcError(id, INVALID_PARAMS, "Invalid initialize parameters"));
          const requested = p.data.protocolVersion;
          const protocolVersion = requested && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
          return send(res, 200, rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, title: opts.enableWatchTool?"REPLAY exercise tools":MCP_SERVER_TITLE, version },
            instructions: opts.enableWatchTool?INSTRUCTIONS+" The separate create_watch tool creates a durable free watch with fresh write authorization and a stable requestId; it never enables paid analysis or issues game orders.":INSTRUCTIONS,
          }));
        }
        case "ping":
          if (!emptyParams.safeParse(params ?? {}).success) return send(res, 200, rpcError(id, INVALID_PARAMS, "Invalid ping parameters"));
          return send(res, 200, rpcResult(id, {}));
        case "tools/list":
          if (!emptyParams.safeParse(params ?? {}).success) return send(res, 200, rpcError(id, INVALID_PARAMS, "Invalid tools/list parameters"));
          return send(res, 200, rpcResult(id, { tools: catalog() }));
        case "tools/call": {
          const p = callParams.safeParse(params);
          if (!p.success) return send(res, 200, rpcError(id, INVALID_PARAMS, "tools/call requires { name, arguments? }"));
          if (!catalog().some((t) => t.name === p.data.name)) return send(res, 200, rpcError(id, INVALID_PARAMS, "Unknown tool"));
          let payload: Record<string, unknown>;
          try {
            if(p.data.name===MCP_WATCH_TOOL.name&&opts.enableWatchTool){
              const fresh=await opts.auth.resolve(req.headers);
              if(fresh.identity.subject!==principal.identity.subject||fresh.context.workroomId!==principal.context.workroomId)throw new McpAuthError('subject_mismatch',403,'Caller identity changed before watch creation');
              payload={...createMcpWatch(opts.service,opts.config,fresh,p.data.arguments??{})};
            }else payload = await tools.call(p.data.name, p.data.arguments ?? {}, principal.identity, async () => {
              try {
                const fresh = await opts.auth.resolve(req.headers);
                if (fresh.identity.subject !== principal.identity.subject) throw new McpAuthError("subject_mismatch", 403, "Caller identity changed during the read");
                return fresh.identity;
              } catch (err) {
                if (err instanceof McpAuthError) throw err;
                throw new McpAuthError("platform_unavailable", 503, "Native authentication unavailable");
              }
            });
          } catch (err) {
            if (err instanceof McpAuthError) return authFailure(res, id, err);
            if(err instanceof McpWatchError){
              if(err.code==='invalid_params')return send(res,200,rpcError(id,INVALID_PARAMS,err.message));
              return send(res,200,rpcResult(id,{content:[{type:'text',text:`${err.code}: ${err.message}`}],isError:true}));
            }
            if (err instanceof McpToolError) {
              if (err.code === "invalid_params") return send(res, 200, rpcError(id, INVALID_PARAMS, err.message));
              return send(res, 200, rpcResult(id, { content: [{ type: "text", text: `${err.code}: ${err.message}` }], isError: true }));
            }
            return send(res, 200, rpcResult(id, { content: [{ type: "text", text: "unavailable: the tool could not complete" }], isError: true }));
          }
          return send(res, 200, rpcResult(id, { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false }));
        }
        default:
          return send(res, 200, rpcError(id, METHOD_NOT_FOUND, "Method not supported"));
      }
    } catch (err) {
      return send(res, 500, rpcError(id, INTERNAL_ERROR, "Request failed"));
    }
  };
  app.post(mountPath, jsonParser, parseFailure, handler);
}
