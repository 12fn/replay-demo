/**
 * Strict citation validation. A model may only cite IDs that were actually in the context it was
 * given (reports released to its side, its own tool results, its own side's records). Anything else
 * is rejected as a whole rather than silently dropped, so a fabricated source never reaches a human.
 */
export interface CitationVerdict { ok: boolean; unknown: string[]; cited: string[] }

export function validateCitations(sourceIds: unknown, available: Iterable<string>): CitationVerdict {
  const allowed = new Set(available);
  const ids = Array.isArray(sourceIds) ? [...new Set(sourceIds.filter((s): s is string => typeof s === 'string' && s.length > 0))] : [];
  const unknown = ids.filter((id) => !allowed.has(id));
  return { ok: unknown.length === 0, unknown, cited: ids };
}

const REAL_WORLD = /\b(real[- ]world|real[- ]life|actual (forces|adversary|enemy|nation)|national (intelligence|dossier)|classified)\b/i;
const HIDDEN_REASONING = /\b(chain of thought|my reasoning was|I secretly)\b/i;

/** Text-level guardrails shared by staff outputs: no real-world adversary claims, no hidden reasoning narration. */
export function textProblems(text: string): string[] {
  const problems: string[] = [];
  if (REAL_WORLD.test(text)) problems.push('real-world adversary or national intelligence framing is out of scope');
  if (HIDDEN_REASONING.test(text)) problems.push('narrates hidden reasoning instead of external observations');
  return problems;
}
