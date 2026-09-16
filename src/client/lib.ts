import type { ExerciseKind, ExerciseSummary, GameState, PlayerState, Report, Role, Side, TimelineEvent } from './api';

export const TICKS_PER_SECOND = 10;

export function tileToXY(tile: number, width: number): { x: number; y: number } {
  return { x: tile % width, y: Math.floor(tile / width) };
}

export function xyToTile(x: number, y: number, width: number): number {
  return y * width + x;
}

export function isValidTile(tile: number | null, state: Pick<GameState, 'width' | 'height'>): tile is number {
  return tile !== null && Number.isInteger(tile) && tile >= 0 && tile < state.width * state.height;
}

export function tickClock(tick: number): string {
  const total = Math.max(0, Math.floor(tick / TICKS_PER_SECOND));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Reports current at that moment; later supersession cannot erase earlier availability. */
export function currentReportsAt<T extends {id:string;tick:number;supersedes?:string}>(reports:T[],tick:number):T[]{
  const released=reports.filter(r=>r.tick<=tick);
  const replaced=new Set(released.map(r=>r.supersedes).filter(Boolean));
  return released.filter(r=>!replaced.has(r.id));
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function shortHash(h: string | undefined, len = 8): string {
  return h ? h.slice(0, len) : '—';
}

export function kindLabel(kind: ExerciseKind): string {
  return kind === 'live' ? 'Live' : kind === 'recorded' ? 'Recorded' : 'Branch';
}

export function sideLabel(side: Side): string {
  return side === 'blue' ? 'Blue' : 'Red';
}

export function otherSide(side: Side): Side {
  return side === 'blue' ? 'red' : 'blue';
}

export function playerBySide(state: GameState, side: Side): PlayerState | undefined {
  return state.players.find((p) => p.side === side);
}

export function ownerSide(state: GameState, tile: number): Side | null {
  const id = state.owners[tile];
  if (!id) return null;
  return state.players.find((p) => p.smallId === id)?.side ?? null;
}

/** UI adjacency hint. The engine still validates diplomacy, terrain and resources. */
export function hasLandBorder(state: GameState, side: Side, target: Side | null): boolean {
  const owner = playerBySide(state, side)?.smallId;
  const targetId = target === null ? 0 : playerBySide(state, target)?.smallId;
  if (owner === undefined || targetId === undefined) return false;
  const {width, height, owners, land} = state;
  for (let i = 0; i < width * height; i++) {
    if (owners[i] !== owner) continue;
    const x = i % width;
    const neighbours = [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width];
    if (neighbours.some(n => n >= 0 && n < width * height && land[n] === 1 && owners[n] === targetId)) return true;
  }
  return false;
}

/** RGBA palette used for the operational map. */
export const MAP_RGBA = {
  water: [12, 24, 44, 255],
  land: [72, 80, 92, 255],
  blue: [44, 132, 176, 255],
  red: [214, 96, 84, 255],
  unknownOwner: [150, 140, 120, 255],
} as const;

/**
 * Fills `out` (width*height*4 bytes) with terrain/ownership colours from the backend arrays.
 * Owner ids are engine smallIds; 0 means unowned.
 */
export function paintMap(state: GameState, out: Uint8ClampedArray): void {
  const { owners, land, width, height, players } = state;
  const sideOf = new Map<number, Side>();
  for (const p of players) sideOf.set(p.smallId, p.side);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const owner = owners[i] ?? 0;
    let c: readonly number[];
    if (owner) {
      const side = sideOf.get(owner);
      c = side === 'blue' ? MAP_RGBA.blue : side === 'red' ? MAP_RGBA.red : MAP_RGBA.unknownOwner;
    } else {
      c = land[i] ? MAP_RGBA.land : MAP_RGBA.water;
    }
    const o = i * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = c[3];
  }
}

/** Fit a width×height image into a box, preserving aspect ratio. Returns the drawn rect. */
export function fitRect(imgW: number, imgH: number, boxW: number, boxH: number) {
  if (imgW <= 0 || imgH <= 0 || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: 0, h: 0, scale: 0 };
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h, scale };
}

export function hasMapData(state: GameState | undefined): state is GameState {
  return (
    !!state &&
    state.width > 0 &&
    state.height > 0 &&
    Array.isArray(state.owners) &&
    Array.isArray(state.land) &&
    state.owners.length === state.width * state.height &&
    state.land.length === state.width * state.height
  );
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/* ---------- Authority, lineage and evidence (pure; mirrors backend rules) ---------- */

export interface CommandAuthority {
  allowed: boolean;
  /** Plain-language reason orders are unavailable, or null when allowed. */
  reason: string | null;
}

/**
 * Whether this session may issue orders right now. Mirrors the backend checks so the UI
 * explains a refusal before the request is made; the backend remains the authority.
 */
export function commandAuthority(input: {
  role: Role;
  playbackTick: number | null;
  exercise: Pick<ExerciseSummary, 'kind' | 'status'> | undefined;
}): CommandAuthority {
  const { role, playbackTick, exercise } = input;
  if (!exercise) return { allowed: false, reason: 'No active exercise.' };
  if (role === 'intelligence') {
    return { allowed: false, reason: 'The intelligence seat publishes assessments. Orders need command delegation.' };
  }
  if (playbackTick !== null) {
    return { allowed: false, reason: 'A historical state is displayed. Return to live or branch from here to issue orders.' };
  }
  if (exercise.kind === 'recorded') {
    return { allowed: false, reason: 'This is a recorded exercise and cannot change. Branch from a tick to continue play.' };
  }
  if (exercise.status !== 'running') {
    return { allowed: false, reason: `The exercise is ${exercise.status}; no new orders are accepted.` };
  }
  return { allowed: true, reason: null };
}

export interface Lineage {
  active: ExerciseSummary;
  /** Source exercise when the active one is a branch and the source is still known. */
  source: ExerciseSummary | undefined;
  forkTick: number | null;
  /** Branches created from the active exercise. */
  branches: ExerciseSummary[];
}

export function lineage(exercises: ExerciseSummary[], activeId: string): Lineage | null {
  const active = exercises.find((e) => e.id === activeId);
  if (!active) return null;
  const source = active.parentId ? exercises.find((e) => e.id === active.parentId) : undefined;
  return {
    active,
    source,
    forkTick: active.kind === 'branch' && typeof active.forkTick === 'number' ? active.forkTick : null,
    branches: exercises.filter((e) => e.parentId === activeId),
  };
}

export interface EvidenceRef {
  id: string;
  kind: 'event' | 'report' | 'unknown';
  tick: number | null;
  /** Short human label, never the raw id when a record is found. */
  label: string;
}

/** Resolves an evidence id to the record it names, so links read as content rather than identifiers. */
export function resolveEvidence(
  data: { timeline: Pick<TimelineEvent, 'id' | 'tick' | 'summary' | 'kind'>[]; reports: Pick<Report, 'id' | 'tick' | 'title' | 'parentSourceId'>[] },
  id: string,
): EvidenceRef {
  const ev = data.timeline.find((t) => t.id === id);
  if (ev) return { id, kind: 'event', tick: ev.tick, label: truncate(ev.summary, 60) };
  const rep = data.reports.find((r) => r.id === id || r.parentSourceId === id);
  if (rep) return { id, kind: 'report', tick: rep.tick, label: truncate(rep.title, 60) };
  return { id, kind: 'unknown', tick: null, label: `record ${id.slice(0, 8)}` };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface DetailEntry {
  key: string;
  value: string;
}

const SKIP_DETAIL_KEYS = new Set(['observation', 'receipt', 'output', 'calls']);

function summarisePlayer(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Partial<PlayerState>;
  if (typeof p.troops !== 'number') return null;
  const parts = [`${fmtInt(p.troops)} troops`];
  if (typeof p.gold === 'number') parts.push(`${fmtInt(p.gold)} gold`);
  if (typeof p.tiles === 'number') parts.push(`${fmtInt(p.tiles)} tiles`);
  return parts.join(' · ');
}

function summariseIntent(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const i = v as { type?: string; troops?: number; targetID?: string | null; unit?: string; attackID?: string; dst?: number; unitId?: number; unitID?: number; unitIds?: number[]; tile?: number };
  if (typeof i.type !== 'string') return null;
  switch (i.type) {
    case 'attack':
      return `${i.targetID ? 'attack opponent' : 'expand'} with ${fmtInt(i.troops ?? 0)} troops`;
    case 'build_unit':
      return `build ${i.unit ?? 'structure'}`;
    case 'cancel_attack':
      return 'cancel attack';
    case 'upgrade_structure':
      return `upgrade ${i.unit ?? 'structure'} #${i.unitId ?? '?'}`;
    case 'cancel_boat':
      return `recall transport #${i.unitID ?? '?'}`;
    case 'move_warship':
      return `move warship ${(i.unitIds ?? []).map(id => `#${id}`).join(', ')} to tile ${i.tile ?? '?'}`;
    case 'boat':
      return `boat ${fmtInt(i.troops ?? 0)} troops`;
    default:
      return i.type.replaceAll('_', ' ');
  }
}

/**
 * Turns a timeline event's structured details into short readable rows. Large sub-records
 * (model observations, receipts) are noted as recorded rather than dumped.
 */
export function detailEntries(details: unknown): DetailEntry[] {
  if (details === null || details === undefined) return [];
  if (typeof details !== 'object') return [{ key: 'detail', value: String(details) }];
  if (Array.isArray(details)) return details.length ? [{ key: 'items', value: truncate(JSON.stringify(details), 120) }] : [];
  const out: DetailEntry[] = [];
  for (const [key, raw] of Object.entries(details as Record<string, unknown>)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (key === 'observation' && typeof raw === 'object' && (raw as {basis?:string}).basis==='app-snapshot-returned-with-order') {
      const o=raw as {tick?:number;fingerprint?:string;player?:unknown};
      out.push({key:'Client snapshot',value:`tick ${o.tick} · ${summarisePlayer(o.player)} · ${shortHash(o.fingerprint??'',12)}`});
      continue;
    }
    if (SKIP_DETAIL_KEYS.has(key)) {
      out.push({ key, value: 'recorded (see backend record)' });
      continue;
    }
    if (key === 'before' || key === 'after') {
      const s = summarisePlayer(raw);
      if (s) {
        out.push({ key, value: s });
        continue;
      }
    }
    if (key === 'observationBasis') {
      out.push({key:'Observation evidence',value:raw==='app-snapshot-returned-with-order'?'Application snapshot returned with order; human attention unverified':'Server admission only; displayed state unknown'});
      continue;
    }
    if (key === 'intent') {
      const s = summariseIntent(raw);
      if (s) {
        out.push({ key, value: s });
        continue;
      }
    }
    if (key === 'fingerprint' || key === 'originalFingerprint') {
      out.push({ key, value: shortHash(String(raw), 12) });
      continue;
    }
    if (typeof raw === 'object') {
      out.push({ key, value: truncate(JSON.stringify(raw), 120) });
      continue;
    }
    out.push({ key, value: String(raw) });
  }
  return out;
}

/** Share committed relative to the returned snapshot, falling back to admission for older records. */
export function commitmentRatio(details: unknown): number {
  if (!details || typeof details !== 'object') return 0;
  const d = details as { observation?: {player?:{troops?:number}}; before?: { troops?: number }; intent?: { troops?: number } };
  const before = d.observation?.player?.troops??d.before?.troops;
  const amount = d.intent?.troops;
  if (typeof before !== 'number' || typeof amount !== 'number' || before <= 0) return 0;
  return clamp(amount / before, 0, 1);
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Ended';
    case 'fault':
      return 'Stopped (fault)';
    default:
      return status;
  }
}
