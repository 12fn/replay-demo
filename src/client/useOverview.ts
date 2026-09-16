import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, type Overview } from './api';

export type ConnectionStatus = 'loading' | 'connected' | 'degraded' | 'offline';

/** The backend answered but refused the overview for this session (sign-in required, access blocked, platform unavailable). */
export interface OverviewDenial {
  status: number;
  message: string;
}

export interface OverviewFeed {
  data: Overview | undefined;
  status: ConnectionStatus;
  error: string | null;
  lastUpdated: Date | null;
  /** Non-null while the backend refuses the overview with an HTTP status. Distinct from being unreachable. */
  denied: OverviewDenial | null;
  /** Fetch immediately (e.g. right after a mutation) instead of waiting for the next poll. */
  refresh: () => Promise<void>;
}

const POLL_MS = 1000;
/** Slower cadence while refused: the backend re-validates each poll with the platform, so do not hammer it. */
const DENIED_POLL_MS = 5000;
const DENIAL_STATUSES = new Set([401, 403, 409, 429, 503]);

export function useOverview(): OverviewFeed {
  const [data, setData] = useState<Overview>();
  const [status, setStatus] = useState<ConnectionStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [denied, setDenied] = useState<OverviewDenial | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const hasData = useRef(false);
  const deniedRef = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (inflight.current) return; // never overlap polls
    const ac = new AbortController();
    inflight.current = ac;
    try {
      const next = await api.overview(ac.signal);
      hasData.current = true;
      deniedRef.current = false;
      setData(next);
      setLastUpdated(new Date());
      setError(null);
      setDenied(null);
      setStatus('connected');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof ApiError && DENIAL_STATUSES.has(err.status)) {
        // The backend is reachable; it refused this session. Keep the last snapshot for context but flag the refusal.
        deniedRef.current = true;
        setDenied({ status: err.status, message: err.message });
        setError(null);
        setStatus(hasData.current ? 'degraded' : 'offline');
        return;
      }
      setError(errorMessage(err));
      setStatus(hasData.current ? 'degraded' : 'offline');
    } finally {
      if (inflight.current === ac) inflight.current = null;
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const loop = async () => {
      if (cancelled) return;
      await fetchOnce();
      if (cancelled) return;
      timer = window.setTimeout(() => void loop(), deniedRef.current ? DENIED_POLL_MS : POLL_MS);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      inflight.current?.abort();
      inflight.current = null;
    };
  }, [fetchOnce]);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    inflight.current = null;
    await fetchOnce();
  }, [fetchOnce]);

  return { data, status, error, lastUpdated, denied, refresh };
}
