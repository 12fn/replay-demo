// Client contract for the native Kamiwaza session endpoints. Kept apart from api.ts so the
// exercise contract stays unchanged. The browser only ever holds an opaque HttpOnly cookie;
// nothing here sees a platform token.

import { ApiError, type Overview, type Role } from './api';

export type NativeMode = 'local-demo' | 'kamiwaza';

/** Public, non-secret view of the native runtime context that authorized the session. */
export interface NativeContextView {
  workroomId: string;
  workroomName: string | null;
  /** Native `effective_workroom_role`, verbatim. */
  nativeRole: string;
  /** Seat derived from the native role before any operator profile. */
  mappedRole: Role;
  profileApplied: boolean;
  accessState: string;
  interactionMode: string;
  lifecycleState: string;
  canEdit: boolean;
  canRunAgents: boolean;
  canShare: boolean;
  readOnlyReason: string | null;
  statusBanner: string | null;
  fresh: boolean;
  validatedAt: string;
}

export interface NativeMetadata {
  signedIn: boolean;
  subject: string | null;
  username: string | null;
  workroomId: string;
  accessExpiresAt: string | null;
  refreshable: boolean;
  binding: 'session' | 'claim' | 'none' | null;
  createdAt: string | null;
}

export interface NativeReceipt {
  clientRequestId: string;
  requestId: string | null;
  target: { method: string; path: string };
  status: number;
  durationMs: number;
  validatedAt: string;
}

export interface NativeDenial {
  code: string;
  httpStatus: number;
  message: string;
}

export interface NativeStatus {
  operatorFileImport?:boolean;
  platformSso?:boolean;
  platformSessionAvailable?:boolean;
  platformLoginUrl?:string;
  mode: NativeMode;
  signedIn: boolean;
  workroomId: string | null;
  identity: { subject: string; name: string; role: Role; organization: string; mode: 'kamiwaza' } | null;
  context: NativeContextView | null;
  metadata: NativeMetadata | null;
  denial: NativeDenial | null;
}

export interface NativeLoginResult {
  signedIn: true;
  identity: NativeStatus['identity'];
  context: NativeContextView;
  metadata: NativeMetadata;
  receipts: NativeReceipt[];
}

/** Native block the backend adds to `overview.platform` when the session is a resolved Kamiwaza identity. */
export interface NativePlatformBlock {
  workroomId: string;
  context: NativeContextView;
  metadata: NativeMetadata;
  receipts: NativeReceipt[];
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `${res.status} ${res.statusText}`.trim();
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* plain text */
  }
  return text.slice(0, 300);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: 'no-store', headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Backend unreachable');
  }
  if (!res.ok) throw new ApiError(res.status, await readError(res));
  return (await res.json()) as T;
}

export const nativeApi = {
  platformSession: () => request<NativeLoginResult>('/api/native/platform-session', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),
  status: (signal?: AbortSignal) => request<NativeStatus>('/api/native/status', { signal }),
  /** Credentials travel once to the REPLAY server, which validates them with the platform and keeps only an encrypted session. */
  login: (username: string, password: string) =>
    request<NativeLoginResult>('/api/native/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }),
  logout: () => request<{ signedIn: false }>('/api/native/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
};

/** Native block from an overview, if the backend resolved a Kamiwaza identity for this request. */
export function nativeOf(ov: Overview | undefined): NativePlatformBlock | null {
  const p = ov?.platform as (Overview['platform'] & { native?: unknown }) | undefined;
  const n = p?.native;
  if (!n || typeof n !== 'object') return null;
  const block = n as Partial<NativePlatformBlock>;
  return block.context && typeof block.workroomId === 'string' ? (block as NativePlatformBlock) : null;
}

export function accessLabel(ctx: NativeContextView): string {
  if (ctx.interactionMode === 'blocked') return 'Blocked';
  if (!ctx.canEdit) return 'Read-only';
  return ctx.canRunAgents ? 'Write · agents' : 'Write';
}
