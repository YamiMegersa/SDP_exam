import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { cachedTargets, loadTargets } from './catalogue';
import { live, type Ring } from './live';
import type { DerivedReport, Sample, Target } from './types';

/** Re-renders at 10 Hz (the client's own notify rate) whenever live data changes. */
export function useLive(): number {
  return useSyncExternalStore(live.subscribe, live.getVersion, live.getVersion);
}

/** Re-renders on every appended chart point. */
export function useRingVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let scheduled = false;
    return live.subscribeRings(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        setVersion((v) => v + 1);
      });
    });
  }, []);
  return version;
}

/**
 * A rolling buffer for one chart, backfilled from the platform's own history the
 * first time it is asked for. Without the backfill a freshly opened console would
 * draw an empty graph until the next few minutes of data arrived.
 */
export function useSeries(options: {
  service: string;
  stream: string;
  entity?: string;
  field: string;
  windowMs?: number;
  max?: number;
}): Ring {
  const { service, stream, entity = '*', field, windowMs = 20 * 60_000, max = 900 } = options;
  const ring = live.retain(service, stream, entity, field, max);
  const backfilled = useRef<string | null>(null);

  useEffect(() => {
    const key = `${service}|${stream}|${entity}|${field}`;
    if (backfilled.current === key) return;
    backfilled.current = key;
    // Aggregates cannot be reconstructed cheaply from the series endpoint (it
    // would mean fetching every entity), so only per-entity charts backfill.
    if (entity === '*') return;

    const now = live.simTime ?? Date.now();
    let cancelled = false;
    api
      .series({ service, stream, entity, from: now - windowMs, to: now, limit: 400 })
      .then((response) => {
        if (cancelled) return;
        const points: Sample[] = [];
        for (const row of response.rows) {
          const value = row.data[field];
          if (typeof value === 'number' && Number.isFinite(value)) points.push({ ts: row.ts, data: { value } });
        }
        live.seed(ring, points);
      })
      .catch(() => {
        // History is a nicety; the live buffer keeps filling either way.
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, stream, entity, field, windowMs]);

  useEffect(() => {
    return () => live.release(service, stream, entity, field);
  }, [service, stream, entity, field]);

  return ring;
}

/** Low-frequency ticker for relative times ("12s ago"). */
export function useTick(intervalMs = 1000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

/** The ARL target catalogue is static per deployment; fetched once per session. */
export function useTargets(): { targets: Target[]; error: string | null } {
  const [targets, setTargets] = useState<Target[]>(() => cachedTargets());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTargets()
      .then((rows) => {
        if (!cancelled) setTargets(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { targets, error };
}

/**
 * Derived indicators, polled rather than pushed.
 *
 * They are computed from stored telemetry on the server (`GET /api/derived`), so the console reads
 * one definition instead of re-deriving the arithmetic in each panel. A failure keeps the previous
 * answer on screen: the live feed is unaffected, and a stale number beats a blank one.
 */
export function useDerived(intervalMs = 5_000): Map<string, DerivedReport> {
  const [reports, setReports] = useState<Map<string, DerivedReport>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = () => {
      api
        .derived()
        .then((response) => {
          if (cancelled) return;
          setReports(new Map(response.services.map((report) => [report.service, report])));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(load, intervalMs);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [intervalMs]);

  return reports;
}

/** Persisted operator identity: the console should not re-ask on every command. */
const RESEARCHER_KEY = 'arl.console.researcher';
export const DEFAULT_RESEARCHER = 'arl-as3';

export function useResearcher(): [string, (code: string) => void] {
  const [code, setCode] = useState<string>(() => {
    try {
      return window.localStorage.getItem(RESEARCHER_KEY) ?? DEFAULT_RESEARCHER;
    } catch {
      return DEFAULT_RESEARCHER;
    }
  });

  const update = (next: string) => {
    setCode(next);
    try {
      window.localStorage.setItem(RESEARCHER_KEY, next);
    } catch {
      // Private mode: the code simply will not persist.
    }
  };

  return [code, update];
}
