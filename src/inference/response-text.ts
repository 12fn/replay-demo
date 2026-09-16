/** Select a completed answer without repairing JSON or retaining intermediate content. */
export type SelectionFailure = 'unknown_phase' | 'missing_final_answer' | 'multiple_final_answers' | 'unfinished_message' | 'unexpected_message_role';
export interface TextSelectionDiagnostics {
  mode: 'final_answer' | 'legacy' | 'none' | 'rejected';
  selectedMessages: number;
  ignoredMessages: number;
  failure: SelectionFailure | null;
}
export interface TextSelection { text: string | null; diagnostics: TextSelectionDiagnostics; }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Explicit final_answer is authoritative when phases are present. Commentary alone is not
 * a final result. Ambiguous/unknown phases fail rather than guessing which action to run.
 * Unphased compatible routes retain the previous message/part concatenation behavior.
 * Selection inspects ALL messages, independently of the bounded diagnostic shape samples.
 */
export function selectOutputText(json: unknown): TextSelection {
  const output = record(json)?.output;
  const messages = (Array.isArray(output) ? output : []).map(record).filter((m): m is Record<string, unknown> => m?.type === 'message');
  const reject = (failure: SelectionFailure): TextSelection => ({text:null,diagnostics:{mode:'rejected',selectedMessages:0,ignoredMessages:messages.length,failure}});
  if (!messages.length) return {text:null,diagnostics:{mode:'none',selectedMessages:0,ignoredMessages:0,failure:null}};
  if (messages.some(m => m.role !== undefined && m.role !== 'assistant')) return reject('unexpected_message_role');
  if (messages.some(m => m.phase != null && m.phase !== 'commentary' && m.phase !== 'final_answer')) return reject('unknown_phase');
  const phased = messages.some(m => m.phase != null);
  const finals = messages.filter(m => m.phase === 'final_answer');
  if (phased && !finals.length) return reject('missing_final_answer');
  if (finals.length > 1) return reject('multiple_final_answers');
  const selected = phased ? finals : messages;
  if (selected.some(m => m.status !== undefined && m.status !== 'completed')) return reject('unfinished_message');
  const parts: string[] = [];
  for (const message of selected) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const p = record(part);
      if (p?.type === 'output_text' && typeof p.text === 'string') parts.push(p.text);
    }
  }
  return {text:parts.length ? parts.join('') : null,diagnostics:{mode:phased?'final_answer':'legacy',selectedMessages:selected.length,ignoredMessages:messages.length-selected.length,failure:null}};
}
