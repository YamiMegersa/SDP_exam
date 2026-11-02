import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Store } from '../db/store';
import { logger } from '../util/log';

const log = logger('replay');

export type ReplayFrame =
  | {
      kind: 'telemetry';
      service: string;
      entity: string;
      stream: string;
      ts: number;
      seq: number | null;
      data: Record<string, unknown>;
    }
  | { kind: 'state'; service: string; entity: string; item: string; ts: number; value: unknown }
  | {
      kind: 'event';
      service: string;
      name: string;
      ts: number;
      payload: Record<string, unknown>;
    };

export type ReplayStatus = 'playing' | 'paused' | 'ended' | 'stopped';

export interface ReplaySnapshot {
  id: string;
  services: string[];
  from: number;
  to: number;
  speed: number;
  cursor: number;
  status: ReplayStatus;
  progress: number;
  emitted: number;
  rows: number;
}

export interface CreateReplayInput {
  services: string[];
  from: number;
  to: number;
  speed?: number;
  streams?: string[];
  entities?: string[];
}

interface Source {
  name: 'telemetry' | 'state' | 'event';
  sql: string;
  buffer: Record<string, unknown>[];
  lastTs: number;
  lastId: number;
  exhausted: boolean;
}

/** Keyset pagination over (ts, id); `lastTs = 0` is before any real sample. */
const keyset = 'AND (ts > ? OR (ts = ? AND id > ?))';
const chunked = (select: string, table: string) =>
  `SELECT ${select} FROM ${table} WHERE service IN (IN_LIST) AND ts BETWEEN ? AND ? ${keyset} ` +
  'ORDER BY ts, id LIMIT ?';

const CHUNK = 500;
/** Ceiling on what one session will release, so a wide range cannot lock the event loop. */
const HARD_ROW_LIMIT = 250_000;
const TICK_MS = 50;
const MAX_ROWS_PER_TICK = 3_000;

/**
 * Plays back data the platform itself captured.
 *
 * It reads only the local store - never the ARL API's backlog endpoint - so replay keeps working
 * when the API is unreachable and is not limited by the one-download-at-a-time rule. A session is
 * read-only: it releases frames to its subscribers and touches no other platform state, so live
 * alerting and the live feed are unaffected.
 */
export class ReplaySession {
  readonly id = randomUUID();
  private readonly db: Database.Database;
  private readonly sources: Source[];
  private readonly statements = new Map<Source['name'], Database.Statement>();
  private readonly frameHandlers = new Set<(frame: ReplayFrame) => void>();
  private readonly statusHandlers = new Set<(snapshot: ReplaySnapshot) => void>();
  private readonly endHandlers = new Set<(snapshot: ReplaySnapshot) => void>();

  private status: ReplayStatus = 'paused';
  private speed: number;
  private cursor: number;
  private emitted = 0;
  private totalRows = 0;
  private anchorWall = 0;
  private anchorTs = 0;
  private timer: NodeJS.Timeout | null = null;
  private endSignalled = false;

  readonly from: number;
  readonly to: number;
  readonly services: string[];

  constructor(store: Store, input: CreateReplayInput) {
    this.db = store.db;
    this.from = Math.min(input.from, input.to);
    this.to = Math.max(input.from, input.to);
    this.services = input.services.filter(Boolean);
    this.speed = clampSpeed(input.speed ?? 1);
    this.cursor = this.from;
    this.anchorTs = this.from;

    const inList = this.services.map(() => '?').join(',');
    const source = (name: Source['name'], select: string, table: string): Source => ({
      name,
      sql: chunked(select, table).replace('IN_LIST', inList),
      buffer: [],
      lastTs: 0,
      lastId: 0,
      exhausted: false,
    });

    this.sources = [
      source('telemetry', 'id, service, entity, stream, ts, seq, recv_ts, backfill, data', 'telemetry'),
      source('state', 'id, service, entity, item, ts, seq, recv_ts, value', 'state_change'),
      source('event', 'id, service, entity, kind, ts, seq, recv_ts, payload', 'event'),
    ];
    for (const s of this.sources) this.statements.set(s.name, this.db.prepare(s.sql));
    this.totalRows = this.count();
  }

  private inClause(): string {
    return this.services.map(() => '?').join(',');
  }

  private count(): number {
    if (this.services.length === 0) return 0;
    const inClause = this.inClause();
    const one = (table: string) => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE service IN (${inClause}) AND ts BETWEEN ? AND ?`)
        .get(...this.services, this.from, this.to) as { n: number };
      return row.n;
    };
    return one('telemetry') + one('state_change') + one('event');
  }

  get snapshot(): ReplaySnapshot {
    const span = Math.max(1, this.to - this.from);
    return {
      id: this.id,
      services: this.services,
      from: this.from,
      to: this.to,
      speed: this.speed,
      cursor: this.cursor,
      status: this.status,
      progress: Math.min(1, Math.max(0, (this.cursor - this.from) / span)),
      emitted: this.emitted,
      rows: this.totalRows,
    };
  }

  onFrame(handler: (frame: ReplayFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onStatus(handler: (snapshot: ReplaySnapshot) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onEnd(handler: (snapshot: ReplaySnapshot) => void): () => void {
    this.endHandlers.add(handler);
    return () => this.endHandlers.delete(handler);
  }

  play(): ReplaySnapshot {
    if (this.status === 'ended' || this.status === 'stopped') return this.snapshot;
    this.anchorWall = Date.now();
    this.anchorTs = this.cursor;
    this.status = 'playing';
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref?.();
    }
    this.announce();
    return this.snapshot;
  }

  pause(): ReplaySnapshot {
    if (this.status !== 'playing') return this.snapshot;
    this.status = 'paused';
    this.announce();
    return this.snapshot;
  }

  setSpeed(speed: number): ReplaySnapshot {
    this.speed = clampSpeed(speed);
    // Re-anchor so the new rate applies from the current position instead of jumping.
    this.anchorWall = Date.now();
    this.anchorTs = this.cursor;
    this.announce();
    return this.snapshot;
  }

  /** Jump to a point in simulated time; the next tick resumes from there. */
  seek(ts: number): ReplaySnapshot {
    const target = Math.min(this.to, Math.max(this.from, Math.round(ts)));
    this.cursor = target;
    this.anchorWall = Date.now();
    this.anchorTs = target;
    for (const source of this.sources) this.resetSource(source, target);
    this.announce();
    return this.snapshot;
  }

  stop(): void {
    this.status = 'stopped';
    this.teardown();
    this.announce();
    this.signalEnd();
  }

  private resetSource(source: Source, ts: number): void {
    source.buffer = [];
    source.lastTs = ts;
    // The keyset is (ts, id) exclusive, so id 0 keeps the rows that sit exactly on the seek target.
    source.lastId = 0;
    source.exhausted = false;
  }

  private tick(): void {
    if (this.status !== 'playing') return;
    const target = Math.min(this.to, this.anchorTs + (Date.now() - this.anchorWall) * this.speed);
    let released = 0;

    while (released < MAX_ROWS_PER_TICK) {
      const next = this.peek();
      if (!next) {
        this.cursor = this.to;
        this.finish();
        return;
      }
      const ts = Number(next.row.ts);
      if (ts > target) break;
      // Consume from the source the row actually came from: draining whichever buffer happened
      // to be first released one source's rows as another's kind and left its head to repeat.
      this.shift(next.source);
      this.release(toFrame(next.source.name, next.row));
      this.cursor = Math.max(this.cursor, ts);
      released += 1;
      if (this.emitted >= HARD_ROW_LIMIT) {
        log.warn(`replay ${this.id.slice(0, 8)} hit the ${HARD_ROW_LIMIT} row ceiling`);
        this.finish();
        return;
      }
    }

    if (released > 0) this.announce();
    // Emitting everything before `to` means the session is done even if the clock has not caught up.
    if (target >= this.to && !this.peek()) this.finish();
  }

  /** Smallest-ts row across the three sources, refilling the one that ran dry. Not consuming. */
  private peek(): { source: Source; row: Record<string, unknown> } | null {
    for (const source of this.sources) {
      if (source.buffer.length === 0 && !source.exhausted) this.refill(source);
    }
    let best: { source: Source; row: Record<string, unknown> } | null = null;
    for (const source of this.sources) {
      const row = source.buffer[0];
      if (!row) continue;
      if (!best || Number(row.ts) < Number(best.row.ts)) best = { source, row };
    }
    return best;
  }

  private shift(source: Source): void {
    const row = source.buffer.shift();
    if (!row) return;
    source.lastTs = Number(row.ts);
    source.lastId = Number(row.id);
  }

  private refill(source: Source): void {
    const statement = this.statements.get(source.name);
    if (!statement) return;
    const rows = statement.all(
      ...this.services,
      this.from,
      this.to,
      source.lastTs,
      source.lastTs,
      source.lastId,
      CHUNK,
    ) as Record<string, unknown>[];
    source.buffer = rows;
    if (rows.length < CHUNK) source.exhausted = true;
  }

  private release(row: ReplayFrame): void {
    this.emitted += 1;
    for (const handler of [...this.frameHandlers]) handler(row);
  }

  private finish(): void {
    if (this.status === 'ended' || this.status === 'stopped') return;
    this.status = 'ended';
    this.teardown();
    this.announce();
    this.signalEnd();
  }

  private signalEnd(): void {
    if (this.endSignalled) return;
    this.endSignalled = true;
    const snapshot = this.snapshot;
    for (const handler of [...this.endHandlers]) handler(snapshot);
  }

  private announce(): void {
    const snapshot = this.snapshot;
    for (const handler of [...this.statusHandlers]) handler(snapshot);
  }

  private teardown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Owns the live sessions and drops finished ones. */
export class ReplayService {
  private readonly sessions = new Map<string, ReplaySession>();

  constructor(private readonly store: Store) {}

  create(input: CreateReplayInput): ReplaySession {
    if (input.services.length === 0) throw new Error('a replay needs at least one service');
    if (!Number.isFinite(input.from) || !Number.isFinite(input.to)) {
      throw new Error('a replay needs a simulated time range');
    }
    const session = new ReplaySession(this.store, input);
    this.sessions.set(session.id, session);
    session.onEnd(() => {
      // Keep the session around briefly so the client can read the final snapshot, then free it.
      const timer = setTimeout(() => this.sessions.delete(session.id), 60_000);
      timer.unref?.();
    });
    return session;
  }

  get(id: string): ReplaySession | undefined {
    return this.sessions.get(id);
  }

  list(): ReplaySnapshot[] {
    return [...this.sessions.values()].map((s) => s.snapshot);
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}

function toFrame(name: Source['name'], row: Record<string, unknown>): ReplayFrame {
  const service = String(row.service);
  const ts = Number(row.ts);
  if (name === 'telemetry') {
    return {
      kind: 'telemetry',
      service,
      entity: String(row.entity),
      stream: String(row.stream),
      ts,
      seq: row.seq === null ? null : Number(row.seq),
      data: safeJson(String(row.data), {}),
    };
  }
  if (name === 'state') {
    return {
      kind: 'state',
      service,
      entity: String(row.entity),
      item: String(row.item),
      ts,
      value: safeJson(String(row.value), String(row.value)),
    };
  }
  return {
    kind: 'event',
    service,
    name: String(row.kind),
    ts,
    payload: safeJson(String(row.payload), {}),
  };
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(64, Math.max(0.1, speed));
}
