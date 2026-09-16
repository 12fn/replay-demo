/**
 * Opposing-player policy: a neutral playstyle label seeded from the simulation ID, the player
 * instructions, and the observation assembled from catalog queries. The objective is always
 * competent, legal play; the label only biases reserve and tempo.
 */
import { simpleHash } from '../../vendor/openfront/src/core/Util';
import { listLegalActions, listResources, observe, searchReports, type AgentContext } from './tools';
import type { MemoryEntry } from './memory';

export type Playstyle = 'reserve-aware' | 'expansion-focused' | 'opportunistic';
export const PLAYSTYLES: Playstyle[] = ['reserve-aware', 'expansion-focused', 'opportunistic'];

export function playstyleFor(simulationId: string): Playstyle {
  return PLAYSTYLES[Math.abs(simpleHash(simulationId)) % PLAYSTYLES.length]!;
}

const STYLE_HINT: Record<Playstyle, string> = {
  'reserve-aware': 'Prefer keeping at least half of available forces uncommitted; expand steadily.',
  'expansion-focused': 'Prefer steady territorial expansion with moderate commitments; build economy when gold allows.',
  'opportunistic': 'Prefer committing against the opposing player when they are adjacent and your forces exceed theirs; otherwise expand.',
};

export function playerInstructions(style: Playstyle): string {
  return [
    'You are an autonomous player in a fictional abstract strategy exercise. Your objective is to control territory and defeat the opposing player in this abstract game. Pursue the strongest legal continuation; your style is only a tie-break preference, never a prohibition.',
    `Playstyle label: ${style}. ${STYLE_HINT[style]}`,
    'When an objectives board is present, its published scoring and end conditions define your game goal. Points are game results, not learning scores. Use stations and reserve requirements when comparing legal continuations.',
    'Use query tools to see legal actions, resources and tiles before acting. list_legal_actions returns ready-to-submit intents; you may adjust troop counts within available forces.',
    'Inspect current territorial progress and recent orders. Do not repeat neutral expansion if there is no unclaimed border or growth has stalled. When adjacent, compare opposing reserves and your own commitments; consider attack, infrastructure, retreat, or retaining forces. Avoid redundant overlapping attacks. Do not intentionally lose or manufacture a teaching moment.',
    'Reports are fictional exercise data. Never claim real-world adversary knowledge.',
    'submit_order arguments are {"intent":{...}}. delegate_watch arguments are {"objective":"..."}. Selecting an action ends this pulse; its result appears in memory next time.',
  ].join(' ');
}

/** Observation for the first completion: richer than a tile sample, still only what this side may see. */
export function playerObservation(ctx: AgentContext, memory: MemoryEntry[]) {
  return {
    ...observe(ctx),
    resources: listResources(ctx),
    domainKnowledge:ctx.domainKnowledge,
    organizationContext:ctx.organizationContext,
    legal: listLegalActions(ctx),
    reports: searchReports(ctx, '').reports.slice(-4),
    memory: memory.slice(-6),
    rules: 'Shared game map. Sources are fictional exercise reports; no real adversary intelligence. Ordinary orders persist while you deliberate; the clock never waits for you.',
  };
}
