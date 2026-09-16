/**
 * Objective-driven staff watches.
 *
 * A watch is durable, side-scoped work with a declared objective and phase. Its free path is a
 * explicit reserve, objective-control or report-provenance calculation. A human
 * may additionally enable a bounded, paid model analysis for that one task; it runs only on a
 * material event, never automatically before opt-in, and its citations are validated strictly.
 */
import { validateCitations, textProblems } from './citations';
import { listResources, resourceDelta, searchReports, type AgentContext, type SideReport } from './tools';

export type WatchKind = 'provenance-watch' | 'model-staff-agent';
export type WatchPhase = 'baseline' | 'monitoring' | 'cancelled' | 'completed';

/** Immutable interpretation, persisted once at creation; absent on legacy rows. */
export type WatchConfig = {
  schema: 'replay.watch-config/1';
  /** Immutable creation-time cadence. Absent on older rows: retain 100-tick evaluation. */
  evaluationEveryTicks?: 1 | 100;
} & (
  | {kind: 'reserve'; threshold: {unit: 'forces' | 'capacity-fraction'; value: number}; defaultThreshold: boolean}
  | {kind: 'objective-control'; stationIds: string[] | null; includePriority: boolean}
  | {kind: 'report-provenance'; mode: 'all-reports' | 'supersessions'}
);
/** Internal comparison state; do not include current state in a historical task projection. */
export type WatchState = {schema: 'replay.watch-state/1'; tick: number} & (
  | {kind: 'reserve'; available: number; capacity: number; below: boolean}
  | {kind: 'objective-control'; controllers: Record<string, 'blue' | 'red' | null>; priorityId: string}
  | {kind: 'report-provenance'}
);
export const WATCH_EXAMPLES = ['Watch reserves below 30%', 'Watch available forces below 1000', 'Watch objective changes', 'Monitor report provenance', 'Watch supersession'] as const;
export class WatchConfigurationError extends Error {
  constructor(reason = 'This request is unsupported or ambiguous for a free watch') {
    super(`${reason}. Try: ${WATCH_EXAMPLES.map(example => `“${example}”`).join('; ')}. Free watches do not interpret arbitrary objectives.`);
    this.name = 'WatchConfigurationError';
  }
}
export {isWatchRequest} from './watch-request';

export interface WatchTask {
  id: string; owner: string; side: 'blue' | 'red'; title: string; objective: string;
  kind: WatchKind; phase: WatchPhase; status: string;
  /** Paid model analysis explicitly enabled by a human for this task. */
  modelEnabled: boolean;
  /** Creation or last accepted free-update tick (restart cursor; quiet checks do not write). */
  cursor: number; createdTick: number; lastObservedTick: number | null;
  sourceIds: string[]; lastResult: string | null;
  /** Method that produced lastResult. */
  lastMethod: 'deterministic provenance watcher' | 'deterministic objective watcher' | 'model staff agent' | null;
  lastReceiptId: string | null;
  /** Report IDs already accounted for; new IDs are material. */
  seenReportIds: string[];
  baseline: { tick: number; opponentTiles: number; opponentTroops: number } | null;
  /** Tick of the last paid analysis, for debounce. */
  lastModelTick: number | null;
  watchConfig?: WatchConfig;
  interpretation?: string;
  watchState?: WatchState;
}

export const MODEL_DEBOUNCE_TICKS = 100;
const TILE_MATERIAL = 0.1, TROOP_MATERIAL = 0.25;

const CONFIG_SCHEMA = 'replay.watch-config/1' as const;
const STATE_SCHEMA = 'replay.watch-state/1' as const;

function ownReports(ctx: AgentContext) {
  const tick = ctx.engine.game.ticks();
  return ctx.reports().filter(r => r.tick <= tick && (!('side' in r) || r.side === undefined || r.side === ctx.side));
}

/** Deliberately anchored grammar: extra clauses, opposing reserves and predictions are not guessed. */
export function interpretWatch(objective: string, ctx: AgentContext): {watchConfig: WatchConfig; interpretation: string} {
  if (typeof objective !== 'string' || !objective.trim() || objective.length > 500) throw new WatchConfigurationError();
  const text = objective.trim().toLowerCase().replace(/[.!]$/, '').replace(/\s+/g, ' ');
  const reserve = text.match(/^(?:watch|monitor|alert me when) (?:my |our |own )?(?:reserves?|available forces)(?: (?:fall |falls |drop |drops )?(?:below|under) ((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(?:\s*(%|percent(?: of (?:current )?(?:force )?capacity)?|forces?))?)?$/);
  if (reserve) {
    const defaultThreshold = reserve[1] === undefined;
    const fraction = defaultThreshold || reserve[2]?.startsWith('%') || reserve[2]?.startsWith('percent');
    const number = defaultThreshold ? 30 : Number(reserve[1].replaceAll(',', ''));
    if (!Number.isFinite(number) || number <= 0 || (fraction ? number > 100 : !Number.isSafeInteger(number))) throw new WatchConfigurationError('Use a positive whole force count or a percentage above 0 and at most 100');
    const threshold = {unit: fraction ? 'capacity-fraction' as const : 'forces' as const, value: fraction ? number / 100 : number};
    return {watchConfig: {schema: CONFIG_SCHEMA, kind: 'reserve', threshold, defaultThreshold}, interpretation: `${defaultThreshold ? 'Default threshold: ' : 'Threshold: '}${number}${fraction ? '% of current own force capacity' : ' own available forces'}. Report crossings below this threshold and recovery to it; committed forces are excluded. Start from the current baseline; no initial alert.`};
  }
  if (/^(?:watch|monitor) (?:the )?(?:available reports|reports?|report changes|report provenance|source changes|provenance changes)$/.test(text)) {
    return {watchConfig: {schema: CONFIG_SCHEMA, kind: 'report-provenance', mode: 'all-reports'}, interpretation: 'Report new own-side source releases and explicit supersession links after the current baseline. No predictions or opposing private sources.'};
  }
  if (/^(?:watch|monitor) (?:report |source )?supersessions?$/.test(text)) {
    return {watchConfig: {schema: CONFIG_SCHEMA, kind: 'report-provenance', mode: 'supersessions'}, interpretation: 'Report new own-side reports with an explicit supersession link to an available own-side source. No inferred contradictions.'};
  }
  const allObjectives = /^(?:watch|monitor) (?:objectives?|objective changes|objective control(?: changes)?|station control(?: changes)?|control changes)$/.test(text);
  const station = text.match(/^(?:watch|monitor) (?:control (?:of|at) ([a-z][a-z -]*)|([a-z][a-z -]*) control)$/);
  if (allObjectives || station) {
    const board = ctx.objectives?.();
    if (!board || board.tick !== ctx.engine.game.ticks()) throw new WatchConfigurationError('This exercise has no current objective board; use a reserve or report watch');
    const target = station?.[1] ?? station?.[2];
    const matches = target ? board.stations.filter(s => s.id.toLowerCase() === target || s.name.toLowerCase() === target) : [];
    if (target && matches.length !== 1) throw new WatchConfigurationError('Name one station shown on the current objective board');
    return {watchConfig: {schema: CONFIG_SCHEMA, kind: 'objective-control', stationIds: target ? [matches[0].id] : null, includePriority: !target}, interpretation: target ? `Report controller changes at ${matches[0].name} from the current baseline. Partial tile gains and score changes do not trigger this watch.` : 'Report station controller changes and priority-station changes from the current objective board baseline. Partial tile gains and score changes do not trigger this watch.'};
  }
  throw new WatchConfigurationError();
}

function watchSnapshot(config: WatchConfig, ctx: AgentContext): WatchState | null {
  const tick = ctx.engine.game.ticks();
  if (config.schema !== CONFIG_SCHEMA) return null;
  if (config.kind === 'reserve') {
    const player = ctx.engine.player(ctx.side), available = player.troops(), capacity = ctx.engine.game.config().maxTroops(player);
    const threshold = config.threshold.unit === 'forces' ? config.threshold.value : config.threshold.value * capacity;
    return {schema: STATE_SCHEMA, kind: 'reserve', tick, available, capacity, below: available < threshold};
  }
  if (config.kind === 'objective-control') {
    const board = ctx.objectives?.();
    if (!board || board.tick !== tick) return null;
    const stations = board.stations.filter(s => config.stationIds === null || config.stationIds.includes(s.id));
    if (config.stationIds !== null && stations.length !== config.stationIds.length) return null;
    return {schema: STATE_SCHEMA, kind: 'objective-control', tick, controllers: Object.fromEntries(stations.map(s => [s.id, s.controller])), priorityId: board.priorityId};
  }
  return config.kind === 'report-provenance' ? {schema: STATE_SCHEMA, kind: 'report-provenance', tick} : null;
}

export function newWatch(input: { id: string; owner: string; side: 'blue' | 'red'; objective: string; tick: number; ctx: AgentContext }): WatchTask {
  if (input.side !== input.ctx.side || input.tick !== input.ctx.engine.game.ticks()) throw new WatchConfigurationError('Watch context must match the assigned side and current tick');
  const {watchConfig: parsedConfig, interpretation: parsedInterpretation} = interpretWatch(input.objective, input.ctx);
  const watchConfig: WatchConfig = {...parsedConfig, evaluationEveryTicks: parsedConfig.kind === 'report-provenance' ? 100 : 1};
  const interpretation = `${parsedInterpretation} ${watchConfig.evaluationEveryTicks === 1
    ? 'Checked after every committed simulation tick while the exercise is running; changes within a tick may be missed.'
    : 'Checked every 100 simulation ticks and on report release; changes between checks may be missed.'}`;
  const watchState = watchSnapshot(watchConfig, input.ctx);
  if (!watchState) throw new WatchConfigurationError('The requested watch has no current baseline');
  const objective = input.objective.trim();
  return { id: input.id, owner: input.owner, side: input.side, title: objective, objective, kind: 'provenance-watch', phase: 'baseline', status: 'waiting', modelEnabled: false, cursor: input.tick, createdTick: input.tick, lastObservedTick: input.tick, sourceIds: [], lastResult: null, lastMethod: null, lastReceiptId: null, seenReportIds: watchConfig.kind === 'report-provenance' ? ownReports(input.ctx).map(r => r.id) : [], baseline: null, lastModelTick: null, watchConfig, interpretation, watchState };
}

export interface MaterialEvent { newReports: SideReport[]; superseded: SideReport[]; delta: { tiles: number; troops: number } | null; reasons: string[]; watch?: {state: WatchState; summary: string} }

function configuredEvent(task: WatchTask, ctx: AgentContext): MaterialEvent | null {
  const config = task.watchConfig!, before = task.watchState, after = watchSnapshot(config, ctx);
  if (!before || before.schema !== STATE_SCHEMA || !after || before.kind !== after.kind || after.tick < before.tick) return null;
  const event = (summary: string): MaterialEvent => ({newReports: [], superseded: [], delta: null, reasons: [summary], watch: {state: after, summary}});
  if (config.kind === 'reserve' && before.kind === 'reserve' && after.kind === 'reserve') {
    if (before.below === after.below) return null;
    const threshold = config.threshold.unit === 'forces' ? `${config.threshold.value} forces` : `${Number((config.threshold.value * 100).toFixed(6))}% of current capacity`;
    return event(`Own reserve is now ${after.below ? 'below' : 'at or above'} ${threshold}: ${Math.floor(after.available)} available forces${config.threshold.unit === 'capacity-fraction' ? ` of ${Math.round(after.capacity)} capacity` : ''} (tick ${after.tick}).`);
  }
  if (config.kind === 'objective-control' && before.kind === 'objective-control' && after.kind === 'objective-control') {
    const changes = Object.entries(after.controllers).filter(([id, controller]) => Object.hasOwn(before.controllers, id) && controller !== before.controllers[id])
      .map(([id, controller]) => `${id}: ${before.controllers[id] ?? 'uncontrolled'} → ${controller ?? 'uncontrolled'}`);
    if (config.includePriority && after.priorityId !== before.priorityId) changes.push(`priority: ${before.priorityId} → ${after.priorityId}`);
    return changes.length ? event(`Objective change (tick ${after.tick}): ${changes.join('; ')}.`) : null;
  }
  if (config.kind === 'report-provenance') {
    const reports = ownReports(ctx), seen = new Set(task.seenReportIds), byId = new Map(reports.map(r => [r.id, r]));
    const newReports = reports.filter(r => !seen.has(r.id) && (config.mode === 'all-reports' || !!r.supersedes && byId.has(r.supersedes)));
    if (!newReports.length) return null;
    const superseded = [...new Set(newReports.map(r => r.supersedes))].map(id => id ? byId.get(id) : undefined).filter((r): r is SideReport => !!r);
    const details = newReports.slice(0, 3).map(r => {
      const old = r.supersedes ? byId.get(r.supersedes) : undefined;
      const relation=r.evidenceStatus==='disputed'?' · unresolved conflict':r.packet?.sourceRelationship==='derivative'?' · repeated claim, not independent corroboration':'';
      return (old ? `${r.title} (tick ${r.tick}) supersedes ${old.title} (tick ${old.tick})` : `${r.title} (tick ${r.tick}) released`)+relation;
    });
    if (newReports.length > 3) details.push(`${newReports.length - 3} more own-side reports; see linked sources`);
    return {...event(`${details.join('; ')}. ${newReports.some(r=>r.packet)?'These are authored scenario claims, not measured game state. ':''}Sources describe their own observation ticks.`), newReports, superseded};
  }
  return null;
}

/** Deterministic: is there anything new since the cursor worth reporting? Free; no inference. */
export function materialEvent(task: WatchTask, ctx: AgentContext): MaterialEvent | null {
  if (task.side !== ctx.side || ctx.engine.game.ticks() < Math.max(task.createdTick, task.cursor) || task.status === 'cancelled' || task.status === 'completed' || task.phase === 'cancelled' || task.phase === 'completed') return null;
  if (task.watchConfig !== undefined) return configuredEvent(task, ctx);
  // Legacy rows retain the original report/public-total evaluator, never their title's new meaning.
  const reports = ownReports(ctx); const seen = new Set(task.seenReportIds);
  const newReports = reports.filter((r) => !seen.has(r.id));
  const superseded = newReports.map((r) => reports.find((x) => x.id === r.supersedes)).filter((x): x is SideReport => !!x);
  const reasons: string[] = [];
  if (newReports.length) reasons.push(`${newReports.length} new report${newReports.length === 1 ? '' : 's'} released`);
  let delta: MaterialEvent['delta'] = null;
  const opp = listResources(ctx).opponent;
  if (task.baseline && opp) {
    const tiles = opp.tiles - task.baseline.opponentTiles, troops = opp.troops - task.baseline.opponentTroops;
    const tileMove = task.baseline.opponentTiles ? Math.abs(tiles) / task.baseline.opponentTiles : 0;
    const troopMove = task.baseline.opponentTroops ? Math.abs(troops) / task.baseline.opponentTroops : 0;
    if (tileMove >= TILE_MATERIAL || troopMove >= TROOP_MATERIAL) { delta = { tiles, troops }; reasons.push(`opposing public totals moved ${Math.round(tileMove * 100)}% tiles / ${Math.round(troopMove * 100)}% forces since tick ${task.baseline.tick}`); }
  }
  return reasons.length ? { newReports, superseded, delta, reasons } : null;
}

/** Apply a material event deterministically. Returns the update text and the report IDs it rests on. */
export function applyProvenance(task: WatchTask, ev: MaterialEvent, ctx: AgentContext): { text: string; sourceIds: string[] } {
  if (task.side !== ctx.side || ctx.engine.game.ticks() < task.createdTick || ev.watch && ev.watch.state.tick !== ctx.engine.game.ticks()) throw new Error('Watch event does not match the side and observation tick');
  if (ev.watch) {
    const sourceIds = [...new Set([...ev.newReports, ...ev.superseded].map(r => r.id))];
    const tick = ev.watch.state.tick;
    task.watchState = ev.watch.state;
    task.seenReportIds = [...new Set([...task.seenReportIds, ...ev.newReports.map(r => r.id)])];
    task.cursor = tick; task.lastObservedTick = tick; task.phase = 'monitoring'; task.status = 'waiting';
    task.sourceIds = sourceIds; task.lastResult = ev.watch.summary;
    task.lastMethod = ev.watch.state.kind === 'report-provenance' ? 'deterministic provenance watcher' : 'deterministic objective watcher'; task.lastReceiptId = null;
    return {text: task.lastResult, sourceIds};
  }
  const tick = ctx.engine.game.ticks(); const parts: string[] = [`Objective: ${task.objective}.`];
  for (const r of ev.newReports) {
    const old = ev.superseded.find((s) => s.id === r.supersedes);
    parts.push(old ? r.packet?`${r.title} (tick ${r.tick}) corrects ${old.title}. These are authored scenario claims, not measured game state; retained repeats are not independent corroboration.`:`${r.title} (tick ${r.tick}) supersedes ${old.title}; opposing available-force estimate ${Math.round(old.observedTroops ?? 0).toLocaleString()} → ${Math.round(r.observedTroops ?? 0).toLocaleString()}. The earlier estimate remains valid only for its own tick.` : `${r.title} (tick ${r.tick}) released.`);
  }
  if (ev.delta) parts.push(`Shared-map change since baseline tick ${task.baseline!.tick}: opposing tiles ${signed(ev.delta.tiles)}, forces ${signed(Math.round(ev.delta.troops))}.`);
  parts.push('Deterministic provenance calculation; no model inference.');
  const sourceIds = [...ev.newReports.map((r) => r.id), ...ev.superseded.map((r) => r.id)];
  task.seenReportIds = [...new Set([...task.seenReportIds, ...ev.newReports.map((r) => r.id)])];
  task.cursor = tick; task.lastObservedTick = tick; task.phase = 'monitoring'; task.status = 'waiting';
  task.sourceIds = sourceIds; task.lastResult = parts.join(' '); task.lastMethod = 'deterministic provenance watcher'; task.lastReceiptId = null;
  const opp = listResources(ctx).opponent; if (opp) task.baseline = { tick, opponentTiles: opp.tiles, opponentTroops: opp.troops };
  return { text: task.lastResult, sourceIds };
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function staffInstructions(task: WatchTask): string {
  return [
    'You are a bounded staff analyst for one side in a fictional educational strategy exercise.',
    `Task objective: ${task.objective}.`,
    task.interpretation ? `Configured free watch: ${task.interpretation}` : 'This legacy watch retains its original report and public-total monitoring; its title was not reinterpreted.',
    'Use only the supplied observation and read-only tools. You cannot issue orders, create tasks or see the other side\'s staff records.',
    'Return a concise external summary for the human and list in sourceIds only the report or record IDs that were in your input or tool results. Never invent an ID; if nothing supports a claim, say so.',
    'Distinguish observation from uncertainty. No real-world adversary predictions, doctrine or mastery claims.',
  ].join(' ');
}

/** Observation for a model staff pulse: the material event plus deterministic calculations. */
export function staffObservation(task: WatchTask, ev: MaterialEvent, ctx: AgentContext) {
  return { tick: ctx.engine.game.ticks(), objectives:ctx.objectives?.()??null, side: task.side, objective: task.objective, watchConfig: task.watchConfig, interpretation: task.interpretation, phase: task.phase, materialEvent: { reasons: ev.reasons, newReportIds: ev.newReports.map((r) => r.id), delta: ev.delta, watch: ev.watch }, domainKnowledge:ctx.domainKnowledge, organizationContext:ctx.organizationContext, resources: listResources(ctx), reports: searchReports(ctx, '').reports.slice(-6), resourceDelta: resourceDelta(ctx, task.createdTick), lastDeterministicResult: task.lastResult };
}

/** IDs a staff answer may legitimately cite: side reports plus record IDs its tools returned. */
export function citableIds(ctx: AgentContext, toolOutputs: unknown[]): Set<string> {
  const ids = new Set<string>(ctx.reports().map((r) => r.id));
  for(const fact of ctx.domainKnowledge?.facts??[]){if(fact.evidenceEligible===false)continue;if(fact.id)ids.add(fact.id);fact.sourceIds.forEach(id=>ids.add(id));}
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    const value=v as Record<string,unknown>;
    // An unsourced native fact stays supplemental even when a tool returns it directly.
    if(value.evidenceEligible===false)return;
    for(const [key,x] of Object.entries(value)){
      if(key==='organizationContext')continue;
      if(/^(id|reportId|eventId|commandId|orderEventId)$/.test(key)&&typeof x==='string')ids.add(x);
      else walk(x);
    }
  };
  toolOutputs.forEach(walk);
  return ids;
}

export interface StaffVerdict { ok: boolean; errors: string[] }
export function validateStaffOutput(summary: string, sourceIds: string[], citable: Set<string>): StaffVerdict {
  const errors = textProblems(summary);
  if (!summary.trim()) errors.push('empty summary');
  const c = validateCitations(sourceIds, citable);
  for (const u of c.unknown) errors.push(`unknown citation "${u}"`);
  return { ok: errors.length === 0, errors };
}
