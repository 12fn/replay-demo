// Client contract for /api/catalog*. Mirrors docs/process/preset-catalog-contract.md. The catalog is a
// read-only reference library: nothing here changes the signed-in identity, grants permissions or reads
// engine/practice data. Synthetic personas and case events are authored teaching material.
import { ApiError } from './api';
import type {
  CatalogAor, CatalogKind, CatalogPage, CatalogQuery, CatalogRecord, CatalogRole, CatalogSource,
} from '../catalog/types';

export type { CatalogAor, CatalogAorId, CatalogKind, CatalogPage, CatalogQuery, CatalogRecord, CatalogRole, CatalogSource } from '../catalog/types';

export interface CatalogSummary {
  schema: 'replay.catalog-summary/1';
  version: string;
  seed: string;
  notice: string;
  aors: CatalogAor[];
  sources: CatalogSource[];
  total: number;
  counts: Record<CatalogKind, number>;
  currentRole: CatalogRole;
}

export interface CatalogRelated { relation: string; record: CatalogRecord }

export interface CatalogRecordDetail {
  record: CatalogRecord;
  links: CatalogRelated[];
  backlinks: CatalogRelated[];
  sources: CatalogSource[];
  notice: string;
}

export const CATALOG_PAGE_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 100;

export const KIND_ORDER: CatalogKind[] = ['persona', 'case', 'event', 'report', 'red-profile', 'organization', 'asset', 'historical', 'lesson', 'glossary'];
export const KIND_LABELS: Record<CatalogKind, string> = {
  persona: 'Personas', report: 'Reports', case: 'Cases', event: 'Case events', asset: 'Assets', glossary: 'Glossary',
  historical: 'Historical', lesson: 'Lessons', organization: 'Organizations', 'red-profile': 'Red profiles',
};
export const KIND_SINGULAR: Record<CatalogKind, string> = {
  persona: 'Persona', report: 'Report', case: 'Case', event: 'Case event', asset: 'Asset', glossary: 'Glossary term',
  historical: 'Historical reference', lesson: 'Lesson', organization: 'Organization', 'red-profile': 'Red profile',
};
export const ROLE_LABELS: Record<CatalogRole, string> = { commander: 'Commander', intelligence: 'Intelligence', instructor: 'Instructor' };

const OUTGOING: Record<string, string> = {
  'belongs-to': 'Belongs to', 'authored-by': 'Authored by', cites: 'Cites', 'derived-from': 'Derived from', supersedes: 'Supersedes',
  disputes: 'Disputes', reviews: 'Reviews', precedes: 'Precedes', uses: 'Uses', 'contrasts-with': 'Contrasts with',
};
const INCOMING: Record<string, string> = {
  'belongs-to': 'Includes', 'authored-by': 'Authored', cites: 'Cited by', 'derived-from': 'Derivatives', supersedes: 'Superseded by',
  disputes: 'Disputed by', reviews: 'Reviewed by', precedes: 'Preceded by', uses: 'Used by', 'contrasts-with': 'Contrasted by',
};

export function relationLabel(relation: string, direction: 'out' | 'in'): string {
  return (direction === 'out' ? OUTGOING : INCOMING)[relation] ?? humanize(relation);
}

export function kindLabel(kind: string): string {
  return (KIND_SINGULAR as Record<string, string>)[kind] ?? humanize(kind);
}

/** "practiceFocus" / "practice_focus" / "practice-focus" -> "Practice focus". */
export function humanize(key: string): string {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

export type FieldDisplay = { kind: 'text'; text: string } | { kind: 'list'; items: string[] };

/** Renders only primitives and string arrays; anything else (objects, nested arrays) is omitted rather than dumped. */
export function formatFieldValue(value: unknown): FieldDisplay | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() ? { kind: 'text', text: value } : null;
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'text', text: String(value) } : null;
  if (typeof value === 'boolean') return { kind: 'text', text: value ? 'Yes' : 'No' };
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return items.length ? { kind: 'list', items } : null;
  }
  return null;
}

/** Only absolute https URLs become anchors; everything else is shown as text. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Authored case events in scenario order: observed tick, then release tick, then id for stability. */
export function sortCaseEvents(items: CatalogRecord[]): CatalogRecord[] {
  const tick = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : Number.POSITIVE_INFINITY);
  return [...items].sort((a, b) =>
    tick(a.observedTick) - tick(b.observedTick) || tick(a.availableAtTick) - tick(b.availableAtTick) || a.id.localeCompare(b.id));
}

export function catalogSearchUrl(q: CatalogQuery): string {
  const params = new URLSearchParams();
  const text = (key: string, v: string | undefined) => { if (v && v.trim()) params.set(key, v.trim()); };
  text('query', q.query);
  text('aorId', q.aorId);
  text('kind', q.kind);
  text('role', q.role);
  text('personaId', q.personaId);
  text('caseId', q.caseId);
  if (typeof q.cutoffTick === 'number' && Number.isFinite(q.cutoffTick) && q.cutoffTick >= 0) params.set('cutoffTick', String(Math.floor(q.cutoffTick)));
  const offset = Math.max(0, Math.floor(Number.isFinite(q.offset) ? (q.offset as number) : 0));
  const limit = Math.min(CATALOG_MAX_LIMIT, Math.max(1, Math.floor(Number.isFinite(q.limit) ? (q.limit as number) : CATALOG_PAGE_LIMIT)));
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  return `/api/catalog/search?${params.toString()}`;
}

export function catalogRecordUrl(id: string, cutoffTick?: number): string {
  return `/api/catalog/records/${encodeURIComponent(id)}${cutoffTick === undefined ? '' : `?cutoffTick=${encodeURIComponent(cutoffTick)}`}`;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function catalogErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Sign in again to browse the scenario library.';
    if (err.status === 403) return 'This session cannot read the scenario library.';
    if (err.status === 404) return 'That catalog record was not found.';
    return err.status ? `Catalog request failed (${err.status}): ${err.message}` : err.message;
  }
  return err instanceof Error ? err.message : 'Catalog request failed';
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const msg = parsed.error ?? parsed.message;
    if (typeof msg === 'string') return msg;
  } catch {
    /* plain text */
  }
  return text.slice(0, 300);
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'Backend unreachable');
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

export const catalogApi = {
  summary: (signal?: AbortSignal) => request<CatalogSummary>('/api/catalog', signal),
  search: (q: CatalogQuery, signal?: AbortSignal) => request<CatalogPage>(catalogSearchUrl(q), signal),
  record: (id: string, signal?: AbortSignal, cutoffTick?: number) => request<CatalogRecordDetail>(catalogRecordUrl(id, cutoffTick), signal),
};
