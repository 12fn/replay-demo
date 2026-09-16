/**
 * Privacy-preserving diagnostics for Responses API output handling.
 *
 * Everything here is derived by inspection and never retains model text,
 * prompts, reasoning or provider bodies: only counts and closed, enumerated shape
 * classes survive. The goal is to let a
 * later reader distinguish, from the ledger and event record alone:
 *
 *   - refused or incomplete provider responses
 *   - unexpected output item / content part shapes (no text, several messages)
 *   - malformed outer JSON, split into fenced / prose-wrapped / truncated /
 *     trailing-content / otherwise invalid
 *   - well-formed JSON of the wrong top-level kind
 *
 * Decision-level shape problems (valid JSON, wrong decision fields, bad
 * argument strings) are diagnosed in the agent loop, not here.
 */

import type { TextSelectionDiagnostics } from "./response-text.ts";

export type TextShape =
  | "empty"
  | "json_object"
  | "json_array"
  | "json_scalar"
  | "fenced"
  | "leading_prose"
  | "unbalanced_json"
  | "trailing_content"
  | "invalid_json";

export interface OutputDiagnostics {
  /** Selection result, absent on older diagnostic records. Contains counts/enums only. */
  selection?: TextSelectionDiagnostics;
  /** Provider `status` when it belongs to the known status enumeration. */
  providerStatus: string | null;
  /** Provider `incomplete_details.reason` when it is a known reason. */
  incompleteReason: string | null;
  /** Number of entries in `output[]` (0 when absent or not an array). */
  outputItems: number;
  /** Counts of `output[].type` values; unknown or unsafe names are bucketed under `other`. */
  itemTypes: Record<string, number>;
  /** Number of `output[]` items of type `message`. */
  messageItems: number;
  /** First eight message shapes, with only documented phases and no text. */
  messageShapes: {phase:'commentary'|'final_answer'|null;status:string|null;textParts:number;textChars:number;textShape:TextShape|'none'}[];
  /** Counts of content part types inside message items (`output_text`, `refusal`, ...). */
  partTypes: Record<string, number>;
  /** True when any message item carries a `refusal` part. */
  refusal: boolean;
  /** Length in characters of the selected output text, or null when there is none. */
  textChars: number | null;
  /** Shape class of the selected output text; `none` when no text was returned. */
  textShape: TextShape | "none";
  /** Provider-reported output tokens (includes reasoning), when usage was returned. */
  outputTokens: number | null;
}

const TYPE_NAMES=new Set(['message','reasoning','function_call','custom_tool_call','web_search_call','file_search_call','computer_call','output_text','refusal','no_content_array']);
const STATUS_NAMES=new Set(['completed','incomplete','failed','in_progress','queued','cancelled']);
const INCOMPLETE_REASONS=new Set(['max_output_tokens','content_filter']);

function bump(map: Record<string, number>, rawKey: unknown): void {
  const key = typeof rawKey==='string'&&TYPE_NAMES.has(rawKey)?rawKey:'other';
  map[key] = (map[key] ?? 0) + 1;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Index just past the first complete top-level JSON value starting at `text[0]`
 * (which must be `{` or `[`), or -1 when brackets or a string never close.
 * String-aware so braces inside string literals do not count.
 */
export function balancedEnd(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Classify output text without retaining it. `parsed` is set only when the whole text is valid JSON. */
export function classifyText(text: string): { shape: TextShape; parsed?: unknown } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { shape: "empty" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const shape: TextShape = Array.isArray(parsed) ? "json_array" : parsed !== null && typeof parsed === "object" ? "json_object" : "json_scalar";
    return { shape, parsed };
  } catch {
    // fall through to structural classification
  }
  if (trimmed.startsWith("```")) return { shape: "fenced" };
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return { shape: "leading_prose" };
  const end = balancedEnd(trimmed);
  if (end === -1) return { shape: "unbalanced_json" };
  if (trimmed.slice(end).trim().length > 0) return { shape: "trailing_content" };
  return { shape: "invalid_json" };
}

/** Summarize the item/part structure of a Responses body. Pure; retains no text. */
export function summarizeOutput(json: unknown, text: string | null, outputTokens: number | null, selection?: TextSelectionDiagnostics): OutputDiagnostics {
  const root = asRecord(json);
  const itemTypes: Record<string, number> = {};
  const partTypes: Record<string, number> = {};
  let messageItems = 0;
  const messageShapes:OutputDiagnostics['messageShapes']=[];
  let refusal = false;
  const output = Array.isArray(root?.output) ? (root!.output as unknown[]) : [];
  for (const item of output) {
    const rec = asRecord(item);
    bump(itemTypes, rec?.type);
    if (!rec || rec.type !== "message") continue;
    messageItems++;
    if(messageShapes.length<8){
      const texts=Array.isArray(rec.content)?rec.content.filter((p:any)=>p?.type==='output_text'&&typeof p?.text==='string').map((p:any)=>p.text as string):[];
      const joined=texts.join('');
      messageShapes.push({phase:rec.phase==='commentary'||rec.phase==='final_answer'?rec.phase:null,status:typeof rec.status==='string'&&STATUS_NAMES.has(rec.status)?rec.status:null,textParts:texts.length,textChars:joined.length,textShape:texts.length?classifyText(joined).shape:'none'});
    }
    if (!Array.isArray(rec.content)) {
      bump(partTypes, "no_content_array");
      continue;
    }
    for (const part of rec.content) {
      const p = asRecord(part);
      bump(partTypes, p?.type);
      if (p?.type === "refusal") refusal = true;
    }
  }
  const shape: TextShape | "none" = text === null ? "none" : classifyText(text).shape;
  return {
    providerStatus: typeof root?.status==='string'&&STATUS_NAMES.has(root.status)?root.status:null,
    incompleteReason: (()=>{const reason=asRecord(root?.incomplete_details)?.reason;return typeof reason==='string'&&INCOMPLETE_REASONS.has(reason)?reason:null;})(),
    outputItems: output.length,
    itemTypes,
    messageItems,
    messageShapes,
    partTypes,
    refusal,
    textChars: text === null ? null : text.length,
    textShape: shape,
    outputTokens,
    ...(selection ? {selection} : {}),
  };
}

function countList(map: Record<string, number>): string {
  const keys = Object.keys(map);
  return keys.length ? keys.map((k) => `${k}:${map[k]}`).join(",") : "-";
}

/** Short, safe fragment for error messages and logs (tokens and integers only). */
export function describeDiagnostics(d: OutputDiagnostics): string {
  return [
    `shape=${d.textShape}`,
    ...(d.selection ? [`selection=${d.selection.mode}${d.selection.failure ? `/${d.selection.failure}` : ""}`] : []),
    `status=${d.providerStatus ?? "-"}${d.incompleteReason ? `/${d.incompleteReason}` : ""}`,
    `items=${countList(d.itemTypes)}`,
    `parts=${countList(d.partTypes)}`,
    `chars=${d.textChars ?? "-"}`,
    `tokens=${d.outputTokens ?? "-"}`,
  ].join(" ");
}
