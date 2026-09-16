/**
 * Read-only links to one archived catalog graph record:
 *   #catalog-review?graph=<lowercase sha256>&id=<node id>[&clock=<clock>&cutoffTick=<tick>]
 *
 * The graph hash pins the exact projection the record was read from. A link carries nothing else: no credentials,
 * workroom, exercise, source bytes or action. Opening one only selects a record after the server's graph hash matches.
 * Pure module: no DOM access, so the parser and builder are unit-testable.
 */

export const CATALOG_REVIEW_FRAGMENT = 'catalog-review';
/** Upper bound on the whole `#catalog-review…` fragment, in characters. */
export const CATALOG_REVIEW_MAX_HASH = 4096;
export const CATALOG_REVIEW_MAX_ID = 400;
export const CATALOG_REVIEW_MAX_CLOCK = 300;
export const CATALOG_REVIEW_MAX_TICK = 999_999_999;

export interface CatalogReviewView { clock: string; cutoffTick: number }
export interface CatalogReviewLink {
  /** Canonical graph content hash (`artifactSha256`), 64 lowercase hex characters. */
  graph: string;
  id: string;
  /** Released-by-tick review view, or null for the full after-action view. */
  view: CatalogReviewView | null;
}
export type CatalogReviewHash =
  | { kind: 'none' }
  | { kind: 'link'; link: CatalogReviewLink }
  | { kind: 'invalid'; reason: string };

const PREFIX = `#${CATALOG_REVIEW_FRAGMENT}`;
const GRAPH = /^[0-9a-f]{64}$/;
const TICK = /^(0|[1-9]\d{0,8})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const KEYS = new Set(['graph', 'id', 'clock', 'cutoffTick']);

const invalid = (reason: string): CatalogReviewHash => ({ kind: 'invalid', reason });
const validText = (s: string, max: number) => s.length >= 1 && s.length <= max && !CONTROL.test(s);

/** True when a `location.hash` value is addressed to catalog review links, whether or not it is valid. */
export function isCatalogReviewHash(hash: string): boolean {
  return hash === PREFIX || hash.startsWith(`${PREFIX}?`);
}

/**
 * Parses `location.hash` (including the leading `#`). Any other fragment is `none` so unrelated hashes keep working;
 * a fragment addressed to catalog review that is not exactly well formed is `invalid`, never a partial or fallback link.
 */
export function parseCatalogReviewHash(hash: string): CatalogReviewHash {
  if (!isCatalogReviewHash(hash)) return { kind: 'none' };
  if (hash.length > CATALOG_REVIEW_MAX_HASH) return invalid('The review link is too long.');
  const query = hash.slice(PREFIX.length + 1);
  if (!query) return invalid('The review link does not name a graph or record.');
  const values = new Map<string, string>();
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (eq < 0 || !KEYS.has(key)) return invalid('The review link contains an unrecognized or malformed parameter.');
    if (values.has(key)) return invalid('The review link repeats a parameter.');
    // graph and cutoffTick are plain ASCII and must appear unescaped; only text values are percent-decoded, exactly once.
    const raw = part.slice(eq + 1);
    let value = raw;
    if (key === 'id' || key === 'clock') {
      try { value = decodeURIComponent(raw); } catch { return invalid('The review link contains a malformed escape.'); }
    }
    values.set(key, value);
  }
  const graph = values.get('graph'), id = values.get('id'), clock = values.get('clock'), tick = values.get('cutoffTick');
  if (graph === undefined || !GRAPH.test(graph)) return invalid('The review link does not contain a valid graph content hash.');
  if (id === undefined || !validText(id, CATALOG_REVIEW_MAX_ID)) return invalid('The review link does not contain a valid record ID.');
  if ((clock === undefined) !== (tick === undefined)) return invalid('The review link must give both a review timeline and a released-by tick, or neither.');
  if (clock === undefined || tick === undefined) return { kind: 'link', link: { graph, id, view: null } };
  if (!validText(clock, CATALOG_REVIEW_MAX_CLOCK)) return invalid('The review link does not contain a valid review timeline.');
  if (!TICK.test(tick)) return invalid('The review link does not contain a valid released-by tick.');
  return { kind: 'link', link: { graph, id, view: { clock, cutoffTick: Number(tick) } } };
}

/** Canonical fragment (with `#`) for a link, or null if the link could not be parsed back exactly. */
export function catalogReviewFragment(link: CatalogReviewLink): string | null {
  let fragment: string;
  try {
    // encodeURIComponent throws on lone surrogates; String(tick) of a fractional or negative tick fails the parse-back.
    const parts = [`graph=${link.graph}`, `id=${encodeURIComponent(link.id)}`];
    if (link.view) parts.push(`clock=${encodeURIComponent(link.view.clock)}`, `cutoffTick=${String(link.view.cutoffTick)}`);
    fragment = `${PREFIX}?${parts.join('&')}`;
  } catch { return null; }
  const back = parseCatalogReviewHash(fragment);
  return back.kind === 'link' && sameLink(back.link, link) ? fragment : null;
}

/**
 * Absolute hyperlink for a link on the current page: keeps origin and path (so a reverse-proxy prefix survives),
 * drops the current query so incidental parameters are never copied, and uses only the generated fragment.
 * Returns null for a non-http(s) origin, a path that is not a plain absolute path, or an unrepresentable link.
 */
export function catalogReviewHref(link: CatalogReviewLink, page: { origin: string; pathname: string }): string | null {
  let origin: URL;
  try { origin = new URL(page.origin); } catch { return null; }
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.origin !== page.origin) return null;
  const p = page.pathname;
  if (!p.startsWith('/') || p.startsWith('//') || /[?#\\\s]/.test(p) || CONTROL.test(p)) return null;
  const fragment = catalogReviewFragment(link);
  return fragment && `${page.origin}${p}${fragment}`;
}

export function sameReviewView(a: CatalogReviewView | null, b: CatalogReviewView | null): boolean {
  return a === null || b === null ? a === b : a.clock === b.clock && a.cutoffTick === b.cutoffTick;
}

export function sameLink(a: CatalogReviewLink, b: CatalogReviewLink): boolean {
  return a.graph === b.graph && a.id === b.id && sameReviewView(a.view, b.view);
}
