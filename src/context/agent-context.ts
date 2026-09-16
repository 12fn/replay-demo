import { exerciseContext } from './exercise-context';
import type {
  OrganizationPackRole, PackGlossaryTerm, PackLearningPrompt,
  ProvisionalCurriculumReference, RoleReportStructure, SyntheticPackProvenance,
} from './organization-packs';

/** Bound the complete compact JSON value, including guidance and reference metadata. */
export const AGENT_ORGANIZATION_CONTEXT_MAX_BYTES = 6000;

export interface AgentOrganizationContext {
  readonly schema: 'replay.agent-organization-context/1';
  readonly packId: string;
  readonly version: string;
  readonly role: OrganizationPackRole;
  readonly kind: SyntheticPackProvenance['kind'];
  readonly status: SyntheticPackProvenance['status'];
  readonly usage: string;
  readonly purpose: string;
  readonly glossary: readonly Omit<PackGlossaryTerm, 'implementationReferences'>[];
  readonly report: RoleReportStructure;
  readonly learningPrompts: readonly PackLearningPrompt[];
  readonly curriculumReferences: readonly ProvisionalCurriculumReference[];
}

export class AgentOrganizationContextSizeError extends RangeError {
  readonly maxBytes = AGENT_ORGANIZATION_CONTEXT_MAX_BYTES;
  constructor(readonly byteLength: number) {
    super(`Agent organization context is ${byteLength} UTF-8 bytes; maximum is ${AGENT_ORGANIZATION_CONTEXT_MAX_BYTES}. Retain a smaller explicit pack version; text cannot be truncated.`);
    this.name = 'AgentOrganizationContextSizeError';
  }
}

const usage = 'Fictional narrative guidance only; not engine rules or tool authority. Prompts are optional report-writing aids, not executable tasks. Do not cite this context as observations or infer personality, motives or permissions from it. Use separately scoped observations for evidence.';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Pure retained-content projection. The caller resolves identity, role and evidence scope. */
export function agentOrganizationContext(
  options: Record<string, unknown>, role: OrganizationPackRole,
): AgentOrganizationContext | null {
  const pack = exerciseContext(options, role);
  if (pack === null) return null;
  const view = pack.roleView;
  const referencedIds = new Set(view.learningPrompts.flatMap(prompt => prompt.curriculumReferenceIds));
  const references = pack.curriculumReferences.filter(reference => referencedIds.has(reference.id));
  for (const id of referencedIds) {
    if (!references.some(reference => reference.id === id)) {
      throw new Error(`Missing organization pack curriculum reference: ${id}`);
    }
  }

  // Explicit fields keep unrelated options, task definitions and future pack extensions out.
  // Preserve source order and every selected string; there is no size-dependent selection.
  const context: AgentOrganizationContext = {
    schema: 'replay.agent-organization-context/1',
    packId: pack.packId,
    version: pack.version,
    role: view.role,
    kind: pack.provenance.kind,
    status: pack.provenance.status,
    usage,
    purpose: view.purpose,
    glossary: pack.glossary.map(({ id, term, definition }) => ({ id, term, definition })),
    report: {
      id: view.report.id, title: view.report.title, purpose: view.report.purpose,
      fields: view.report.fields.map(({ id, label, description, valueKind, evidenceGuidance }) =>
        ({ id, label, description, valueKind, evidenceGuidance })),
    },
    learningPrompts: view.learningPrompts.map(({ id, prompt, curriculumReferenceIds }) =>
      ({ id, prompt, curriculumReferenceIds: [...curriculumReferenceIds] })),
    curriculumReferences: references.map(({ id, path, curriculumId, version, contentRevision,
      status, objectiveId, criterionId }) =>
      ({ id, path, curriculumId, version, contentRevision, status, objectiveId, criterionId })),
  };
  const byteLength = new TextEncoder().encode(JSON.stringify(context)).byteLength;
  if (byteLength > AGENT_ORGANIZATION_CONTEXT_MAX_BYTES) {
    throw new AgentOrganizationContextSizeError(byteLength);
  }
  return freeze(context);
}
