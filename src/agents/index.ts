/** REPLAY agent harness: typed tool catalog, bounded loop, durable memory, player policy, staff watches. No I/O at import. */
export { TOOL_CATALOG, UNAVAILABLE_CAPABILITIES, INTENT_SHAPES, toolsForScope, toolSpec, executeTool, parseArgs, listLegalActions, observe, inspectTile } from './tools';
export type { AgentContext, ToolSpec, ToolCall, ToolResult, ToolScope, ToolKind, SideReport, SideEvent } from './tools';
export { runPulse, readDecision, decisionSchema, DEFAULT_BUDGET } from './loop';
export type { PulseOptions, PulseResult, PulseBudget, Completion, Decision, InferenceLike } from './loop';
export { AgentMemory, noteFor, MEMORY_LIMIT } from './memory';
export type { MemoryEntry, MemoryAction } from './memory';
export { validateCitations, textProblems } from './citations';
export type { CitationVerdict } from './citations';
export { playstyleFor, playerInstructions, playerObservation, PLAYSTYLES } from './player';
export type { Playstyle } from './player';
export { newWatch, materialEvent, applyProvenance, staffInstructions, staffObservation, citableIds, validateStaffOutput, MODEL_DEBOUNCE_TICKS } from './staff';
export type { WatchTask, WatchKind, WatchPhase, MaterialEvent, StaffVerdict } from './staff';
