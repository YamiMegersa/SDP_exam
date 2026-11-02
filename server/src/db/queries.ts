import type { Store } from './store';

export interface SeriesRow {
  entity: string;
  ts: number;
  seq: number | null;
  backfill: boolean;
  data: Record<string, unknown>;
}

export interface SeriesQuery {
  service: string;
  stream: string;
  entity?: string;
  from: number;
  to: number;
  limit?: number;
}

export interface StateSnapshot {
  entity: string;
  item: string;
  ts: number;
  value: unknown;
}

export interface TimeRange {
  minTs: number | null;
  maxTs: number | null;
  rows: number;
}

/**
 * Read-side helpers for the HTTP API.
 *
 * They live here rather than on `Store` because they are shaped for the browser (one row per series,
 * one row per state item) and are never used on the ingest path.
 */

/** Most recent value of every `state` item, which is what the panels render. */
export function latestStates(store: Store, service: string): StateSnapshot[] {
  const rows = store.db
    .prepare(
      `SELECT s.entity, s.item, s.ts, s.value
         FROM state_change s
         JOIN (SELECT entity, item, MAX(id) AS id FROM state_change WHERE service = ? GROUP BY entity, item) m
           ON m.id = s.id
        ORDER BY s.entity, s.item`,
    )
    .all(service) as Array<{ entity: string; item: string; ts: number; value: string }>;
  return rows.map((r) => ({
    entity: r.entity,
    item: r.item,
    ts: r.ts,
    value: safeJson(r.value, r.value),
  }));
}

export function countStates(store: Store, service: string): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM state_change WHERE service = ? GROUP BY entity, item)`,
    )
    .get(service) as { n: number };
  return row.n;
}

/**
 * Telemetry for a chart.
 *
 * `seq` gaps are preserved as they were stored rather than interpolated: the client draws a break,
 * which is the honest rendering of missing samples. When a range holds more rows than the caller
 * asked for, a stride is applied so the response stays small enough to render.
 */
export function series(store: Store, query: SeriesQuery): {
  rows: SeriesRow[];
  total: number;
  stride: number;
} {
  const limit = Math.min(Math.max(query.limit ?? 2_000, 10), 20_000);
  const where: string[] = ['service = ?', 'stream = ?', 'ts BETWEEN ? AND ?'];
  const params: unknown[] = [query.service, query.stream, query.from, query.to];
  if (query.entity) {
    where.push('entity = ?');
    params.push(query.entity);
  }
  const clause = where.join(' AND ');

  const total = (
    store.db.prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE ${clause}`).get(...params) as {
      n: number;
    }
  ).n;

  const stride = total > limit ? Math.ceil(total / limit) : 1;
  const rows = store.db
    .prepare(
      `SELECT entity, ts, seq, backfill, data FROM telemetry
        WHERE ${clause} ${stride > 1 ? 'AND id % ? = 0' : ''}
        ORDER BY ts ASC LIMIT ?`,
    )
    .all(...(stride > 1 ? [...params, stride, limit] : [...params, limit])) as Array<{
    entity: string;
    ts: number;
    seq: number | null;
    backfill: number;
    data: string;
  }>;

  return {
    rows: rows.map((r) => ({
      entity: r.entity,
      ts: r.ts,
      seq: r.seq,
      backfill: Boolean(r.backfill),
      data: safeJson(r.data, {}),
    })),
    total,
    stride,
  };
}

export function timeRange(store: Store, service: string): TimeRange {
  const row = store.db
    .prepare(
      `SELECT (SELECT MIN(ts) FROM telemetry WHERE service = @s) AS minTs,
              (SELECT MAX(ts) FROM telemetry WHERE service = @s) AS maxTs,
              (SELECT COUNT(*) FROM telemetry WHERE service = @s) AS rows`,
    )
    .get({ s: service }) as TimeRange;
  return { minTs: row.minTs ?? null, maxTs: row.maxTs ?? null, rows: row.rows ?? 0 };
}

export interface ServiceCounts {
  service: string;
  entities: number;
  streams: number;
  telemetry: number;
  states: number;
  alertsOpen: number;
}

export function serviceCounts(store: Store, codes: string[]): ServiceCounts[] {
  const one = store.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM entity WHERE service = @s) AS entities,
       (SELECT COUNT(DISTINCT stream) FROM telemetry WHERE service = @s) AS streams,
       (SELECT COUNT(*) FROM telemetry WHERE service = @s) AS telemetry,
       (SELECT COUNT(*) FROM state_change WHERE service = @s) AS states,
       (SELECT COUNT(*) FROM alert WHERE service = @s AND resolved_ts IS NULL) AS alertsOpen`,
  );
  return codes.map((service) => {
    const row = one.get({ s: service }) as Omit<ServiceCounts, 'service'>;
    return { service, ...row };
  });
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
