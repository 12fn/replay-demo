/**
 * Durable external action memory for an agent actor. Stored in the application settings table so
 * it survives restarts and is scoped to (exercise, actor). Entries hold external summaries, tool
 * outcomes and engine command receipt IDs only.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface MemoryAction { tool: string; ok: boolean; note: string; commandId?: string; taskId?: string }
export interface MemoryEntry { tick: number; at: string; receiptIds: string[]; summary: string; actions: MemoryAction[]; stopped: string }

export const MEMORY_LIMIT = 12;

export class AgentMemory {
  constructor(private readonly db: DatabaseSync, private readonly exerciseId: string, private readonly actor: string) {}
  private get key() { return `agent.memory:${this.exerciseId}:${this.actor}`; }
  load(): MemoryEntry[] {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(this.key) as unknown as { value: string } | undefined;
    if (!row) return [];
    try { const v = JSON.parse(row.value); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  append(entry: MemoryEntry): MemoryEntry[] {
    const next = [...this.load(), entry].slice(-MEMORY_LIMIT);
    this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key, JSON.stringify(next));
    return next;
  }
  clear() { this.db.prepare('DELETE FROM settings WHERE key=?').run(this.key); }
}

/** One-line external note for a tool result, safe to persist and show. */
export function noteFor(tool: string, ok: boolean, output: unknown, reason?: string): MemoryAction {
  const o = (output ?? {}) as Record<string, unknown>;
  const base: MemoryAction = { tool, ok, note: ok ? 'completed' : `rejected: ${reason ?? 'unknown'}` };
  if (ok && tool === 'submit_order' && typeof o.id === 'string') return { ...base, note: `order queued (${String(o.status)})`, commandId: o.id };
  if (ok && tool === 'delegate_watch' && typeof o.taskId === 'string') return { ...base, note: 'watch created', taskId: o.taskId };
  if (ok && tool === 'list_legal_actions' && Array.isArray(o.actions)) return { ...base, note: `${o.actions.length} legal actions listed` };
  return base;
}
