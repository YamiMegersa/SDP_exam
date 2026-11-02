import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';
import type {
  AlertPayload,
  AlertRecord,
  CommandAck,
  EntityDef,
  ResearcherRecord,
} from '../types';

export interface TelemetryRow {
  service: string;
  entity: string;
  stream: string;
  ts: number;
  seq: number | null;
  recvTs: number;
  backfill: boolean;
  data: Record<string, unknown>;
}

export interface StateRow {
  service: string;
  entity: string;
  item: string;
  ts: number;
  seq: number | null;
  recvTs: number;
  value: unknown;
}

export interface EventRow {
  service: string;
  entity: string | null;
  kind: string;
  ts: number;
  seq: number | null;
  recvTs: number;
  payload: Record<string, unknown>;
}

export interface CommandRow {
  command_id: string;
  service: string;
  entity: string;
  control: string;
  value: unknown;
  researcher: string;
  topic: string;
  sent_ts: number;
  sent_wall_ts: number;
  state: string;
  progress: number | null;
  reason: string | null;
  detail: string | null;
  settled_ts: number | null;
}

export interface GapRow {
  service: string;
  entity: string | null;
  stream: string | null;
  topic: string;
  expectedSeq: number;
  receivedSeq: number;
  missed: number;
  ts: number | null;
  wallTs: number;
}

export interface AlertFilter {
  service?: string;
  status?: 'open' | 'raised' | 'cleared' | 'acknowledged' | 'resolved' | 'unacknowledged';
  limit?: number;
  sinceTs?: number;
}

/**
 * The platform's own store. Writes are batched by the caller (`writeBatch`) so a burst of RTA scan
 * samples becomes one transaction instead of one commit per message.
 */
export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- services

  touchService(
    code: string,
    opts: { online?: boolean; ts?: number | null; recvTs?: number; version?: string | null },
  ): void {
    const now = opts.recvTs ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO service (code, version, online, last_msg_ts, last_recv_ts, first_seen_ts)
         VALUES (@code, @version, COALESCE(@online, 0), @ts, @recvTs, @recvTs)
         ON CONFLICT(code) DO UPDATE SET
           version = COALESCE(@version, service.version),
           online = COALESCE(@online, service.online),
           last_msg_ts = COALESCE(@ts, service.last_msg_ts),
           last_recv_ts = MAX(COALESCE(@recvTs, 0), COALESCE(service.last_recv_ts, 0))`,
      )
      .run({
        code,
        version: opts.version ?? null,
        online: opts.online === undefined ? null : opts.online ? 1 : 0,
        ts: opts.ts ?? null,
        recvTs: now,
      });
  }

  saveTopology(code: string, version: string, json: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO service (code, version, topology_json, topology_ts, online, first_seen_ts)
         VALUES (@code, @version, @json, @ts, 1, @ts)
         ON CONFLICT(code) DO UPDATE SET
           version = @version,
           topology_json = @json,
           topology_ts = @ts,
           online = 1`,
      )
      .run({ code, version, json, ts });
  }

  replaceEntities(code: string, entities: EntityDef[]): void {
    const del = this.db.prepare('DELETE FROM entity WHERE service = ?');
    const ins = this.db.prepare(
      'INSERT INTO entity (service, entity_id, kind, meta) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      del.run(code);
      for (const e of entities) ins.run(code, e.id, e.kind, JSON.stringify(e.meta ?? {}));
    })();
  }

  listServices(): Array<{
    code: string;
    version: string | null;
    online: number;
    last_msg_ts: number | null;
    last_recv_ts: number | null;
  }> {
    return this.db
      .prepare('SELECT code, version, online, last_msg_ts, last_recv_ts FROM service ORDER BY code')
      .all() as never;
  }

  topologyJson(code: string): string | null {
    const row = this.db.prepare('SELECT topology_json FROM service WHERE code = ?').get(code) as
      | { topology_json: string | null }
      | undefined;
    return row?.topology_json ?? null;
  }

  // ------------------------------------------------------------------ writes

  /** One transaction for a whole flush; keeps the RTA scan burst cheap. */
  writeBatch(input: {
    telemetry: TelemetryRow[];
    states: StateRow[];
    events: EventRow[];
    gaps: GapRow[];
  }): void {
    const tel = this.db.prepare(
      `INSERT INTO telemetry (service, entity, stream, ts, seq, recv_ts, backfill, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const st = this.db.prepare(
      `INSERT INTO state_change (service, entity, item, ts, seq, recv_ts, value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const ev = this.db.prepare(
      `INSERT INTO event (service, entity, kind, ts, seq, recv_ts, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const gap = this.db.prepare(
      `INSERT INTO ingest_gap (service, entity, stream, topic, expected_seq, received_seq, missed, ts, wall_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const r of input.telemetry) {
        tel.run(
          r.service,
          r.entity,
          r.stream,
          r.ts,
          r.seq,
          r.recvTs,
          r.backfill ? 1 : 0,
          JSON.stringify(r.data),
        );
      }
      for (const r of input.states) {
        st.run(r.service, r.entity, r.item, r.ts, r.seq, r.recvTs, JSON.stringify(r.value));
      }
      for (const r of input.events) {
        ev.run(r.service, r.entity, r.kind, r.ts, r.seq, r.recvTs, JSON.stringify(r.payload));
      }
      for (const g of input.gaps) {
        gap.run(
          g.service,
          g.entity,
          g.stream,
          g.topic,
          g.expectedSeq,
          g.receivedSeq,
          g.missed,
          g.ts,
          g.wallTs,
        );
      }
    })();
  }

  // ------------------------------------------------------------------ alerts

  private insertTransition(t: {
    alertId: string;
    ts: number;
    wallTs: number;
    action: string;
    from: string | null;
    to: string | null;
    actor?: string | null;
    note?: string | null;
    payload?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO alert_transition (alert_id, ts, wall_ts, action, from_status, to_status, actor, note, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.alertId,
        t.ts,
        t.wallTs,
        t.action,
        t.from,
        t.to,
        t.actor ?? null,
        t.note ?? null,
        t.payload === undefined ? null : JSON.stringify(t.payload),
      );
  }

  getAlert(alertId: string): AlertRecord | null {
    const row = this.db.prepare('SELECT * FROM alert WHERE alert_id = ?').get(alertId) as
      | (Omit<AlertRecord, 'metadata'> & { metadata: string })
      | undefined;
    if (!row) return null;
    return { ...row, metadata: safeJson(row.metadata, {}) };
  }

  /**
   * Applies a service alert event.
   *
   * `alert_id` is stable across escalation, so the same id is raised again with a higher severity.
   * A clear for an alert the platform never saw raised is still recorded (the platform can start
   * mid-episode) but is flagged in the audit trail rather than silently dropped.
   */
  applyAlertEvent(
    service: string,
    payload: AlertPayload,
    ts: number,
    wallTs: number,
    entity: string | null,
  ): { alert: AlertRecord; change: string } {
    const existing = this.getAlert(payload.alert_id);
    const severity = payload.severity ?? 'warning';
    const metadata = payload.metadata ?? {};

    if (!existing) {
      const status = payload.state === 'cleared' ? 'cleared' : 'raised';
      this.db
        .prepare(
          `INSERT INTO alert (alert_id, service, entity, type, severity, status, value, unit, limit_value,
             message, metadata, raised_ts, cleared_ts, origin, last_ts)
           VALUES (@alert_id, @service, @entity, @type, @severity, @status, @value, @unit, @limit,
             @message, @metadata, @raised_ts, @cleared_ts, 'service', @last_ts)`,
        )
        .run({
          alert_id: payload.alert_id,
          service,
          entity: entity ?? payload.entity ?? null,
          type: payload.type,
          severity,
          status,
          value: payload.value ?? null,
          unit: payload.unit ?? null,
          limit: payload.limit ?? null,
          message: payload.message ?? null,
          metadata: JSON.stringify(metadata),
          raised_ts: ts,
          cleared_ts: status === 'cleared' ? ts : null,
          last_ts: ts,
        });
      this.insertTransition({
        alertId: payload.alert_id,
        ts,
        wallTs,
        action: payload.state === 'cleared' ? 'cleared' : 'raised',
        from: null,
        to: status,
        note:
          payload.state === 'cleared'
            ? 'clear received for an alert first observed as cleared'
            : payload.message,
        payload: { severity, value: payload.value, limit: payload.limit, metadata },
      });
      return { alert: this.getAlert(payload.alert_id)!, change: 'created' };
    }

    if (payload.state === 'cleared') {
      if (existing.status === 'cleared') return { alert: existing, change: 'noop' };
      this.db
        .prepare(
          `UPDATE alert SET status = 'cleared', cleared_ts = ?, last_ts = ?, value = COALESCE(?, value),
             metadata = ? WHERE alert_id = ?`,
        )
        .run(ts, ts, payload.value ?? null, JSON.stringify(metadata), payload.alert_id);
      this.insertTransition({
        alertId: payload.alert_id,
        ts,
        wallTs,
        action: 'cleared',
        from: existing.status,
        to: 'cleared',
        payload: { value: payload.value },
      });
      return { alert: this.getAlert(payload.alert_id)!, change: 'cleared' };
    }

    const escalated = severityRank(severity) > severityRank(existing.severity);
    const reopened = existing.status === 'cleared';
    this.db
      .prepare(
        `UPDATE alert SET status = 'raised', severity = ?, value = ?, unit = ?, limit_value = ?,
           message = ?, metadata = ?, last_ts = ?,
           raised_ts = CASE WHEN ? THEN ? ELSE raised_ts END,
           cleared_ts = CASE WHEN ? THEN NULL ELSE cleared_ts END,
           escalate_count = escalate_count + ?
         WHERE alert_id = ?`,
      )
      .run(
        severity,
        payload.value ?? null,
        payload.unit ?? null,
        payload.limit ?? null,
        payload.message ?? null,
        JSON.stringify(metadata),
        ts,
        reopened ? 1 : 0,
        ts,
        reopened ? 1 : 0,
        escalated && !reopened ? 1 : 0,
        payload.alert_id,
      );
    const action = reopened ? 'raised' : escalated ? 'escalated' : 'updated';
    if (action !== 'updated') {
      this.insertTransition({
        alertId: payload.alert_id,
        ts,
        wallTs,
        action,
        from: existing.status === 'raised' ? existing.severity : 'cleared',
        to: severity,
        note: payload.message,
        payload: { value: payload.value, limit: payload.limit, metadata },
      });
    }
    return { alert: this.getAlert(payload.alert_id)!, change: action };
  }

  /** Raises or clears a platform-generated alert (offline service, ingestion gap, ...). */
  setPlatformAlert(input: {
    alertId: string;
    service: string;
    type: string;
    severity: 'info' | 'warning' | 'critical';
    raised: boolean;
    message: string;
    ts: number;
    wallTs: number;
    metadata?: Record<string, unknown>;
  }): { alert: AlertRecord; change: string } | null {
    const existing = this.getAlert(input.alertId);
    if (input.raised) {
      if (existing && existing.status === 'raised') {
        this.db
          .prepare(
            `UPDATE alert SET last_ts = ?, message = ?, metadata = ?, severity = ? WHERE alert_id = ?`,
          )
          .run(
            input.ts,
            input.message,
            JSON.stringify(input.metadata ?? {}),
            input.severity,
            input.alertId,
          );
        return null;
      }
      this.db
        .prepare(
          `INSERT INTO alert (alert_id, service, entity, type, severity, status, message, metadata,
             raised_ts, origin, last_ts)
           VALUES (@id, @service, NULL, @type, @severity, 'raised', @message, @metadata, @ts, 'platform', @ts)
           ON CONFLICT(alert_id) DO UPDATE SET
             status = 'raised', raised_ts = @ts, cleared_ts = NULL, resolved_ts = NULL,
             resolved_by = NULL, resolution = NULL, message = @message, last_ts = @ts,
             metadata = @metadata, severity = @severity`,
        )
        .run({
          id: input.alertId,
          service: input.service,
          type: input.type,
          severity: input.severity,
          message: input.message,
          metadata: JSON.stringify(input.metadata ?? {}),
          ts: input.ts,
        });
      this.insertTransition({
        alertId: input.alertId,
        ts: input.ts,
        wallTs: input.wallTs,
        action: 'raised',
        from: existing?.status ?? null,
        to: 'raised',
        note: input.message,
        payload: input.metadata,
      });
      return { alert: this.getAlert(input.alertId)!, change: 'created' };
    }

    if (!existing || existing.status === 'cleared') return null;
    this.db
      .prepare(`UPDATE alert SET status = 'cleared', cleared_ts = ?, last_ts = ? WHERE alert_id = ?`)
      .run(input.ts, input.ts, input.alertId);
    this.insertTransition({
      alertId: input.alertId,
      ts: input.ts,
      wallTs: input.wallTs,
      action: 'cleared',
      from: existing.status,
      to: 'cleared',
      note: 'condition recovered',
    });
    return { alert: this.getAlert(input.alertId)!, change: 'cleared' };
  }

  acknowledgeAlert(input: {
    alertId: string;
    researcher: string;
    note?: string | null;
    ts: number;
    wallTs: number;
  }): { ok: true; alert: AlertRecord } | { ok: false; code: number; error: string } {
    const existing = this.getAlert(input.alertId);
    if (!existing) return { ok: false, code: 404, error: 'alert_not_found' };
    if (existing.resolved_ts) return { ok: false, code: 409, error: 'alert_already_resolved' };
    if (existing.ack_ts) return { ok: false, code: 409, error: 'alert_already_acknowledged' };
    this.db
      .prepare(
        `UPDATE alert SET ack_ts = ?, ack_by = ?, ack_note = ?, last_ts = MAX(last_ts, ?)
         WHERE alert_id = ?`,
      )
      .run(input.ts, input.researcher, input.note ?? null, input.ts, input.alertId);
    this.insertTransition({
      alertId: input.alertId,
      ts: input.ts,
      wallTs: input.wallTs,
      action: 'acknowledged',
      from: existing.status,
      to: existing.status,
      actor: input.researcher,
      note: input.note ?? null,
    });
    return { ok: true, alert: this.getAlert(input.alertId)! };
  }

  resolveAlert(input: {
    alertId: string;
    researcher: string;
    resolution: string;
    cause?: string | null;
    ts: number;
    wallTs: number;
  }): { ok: true; alert: AlertRecord } | { ok: false; code: number; error: string } {
    const existing = this.getAlert(input.alertId);
    if (!existing) return { ok: false, code: 404, error: 'alert_not_found' };
    if (existing.resolved_ts) return { ok: false, code: 409, error: 'alert_already_resolved' };
    if (!existing.ack_ts) return { ok: false, code: 409, error: 'alert_not_acknowledged' };
    this.db
      .prepare(
        `UPDATE alert SET resolved_ts = ?, resolved_by = ?, resolution = ?, cause = COALESCE(?, cause),
           last_ts = MAX(last_ts, ?) WHERE alert_id = ?`,
      )
      .run(
        input.ts,
        input.researcher,
        input.resolution,
        input.cause ?? null,
        input.ts,
        input.alertId,
      );
    this.insertTransition({
      alertId: input.alertId,
      ts: input.ts,
      wallTs: input.wallTs,
      action: 'resolved',
      from: existing.status,
      to: 'resolved',
      actor: input.researcher,
      note: input.resolution,
      payload: { cause: input.cause ?? null },
    });
    return { ok: true, alert: this.getAlert(input.alertId)! };
  }

  listAlerts(filter: AlertFilter = {}): AlertRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.service) {
      where.push('service = @service');
      params.service = filter.service;
    }
    if (filter.sinceTs) {
      where.push('last_ts >= @since');
      params.since = filter.sinceTs;
    }
    switch (filter.status) {
      case 'open':
        where.push('resolved_ts IS NULL');
        break;
      case 'raised':
        where.push("status = 'raised' AND resolved_ts IS NULL");
        break;
      case 'cleared':
        where.push("status = 'cleared' AND resolved_ts IS NULL");
        break;
      case 'acknowledged':
        where.push('ack_ts IS NOT NULL AND resolved_ts IS NULL');
        break;
      case 'unacknowledged':
        where.push('ack_ts IS NULL AND resolved_ts IS NULL');
        break;
      case 'resolved':
        where.push('resolved_ts IS NOT NULL');
        break;
      default:
        break;
    }
    const sql =
      `SELECT * FROM alert ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
      `ORDER BY (resolved_ts IS NOT NULL), status = 'cleared', ` +
      `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, raised_ts DESC ` +
      `LIMIT @limit`;
    const rows = this.db.prepare(sql).all({ ...params, limit: filter.limit ?? 200 }) as Array<
      Omit<AlertRecord, 'metadata'> & { metadata: string }
    >;
    return rows.map((r) => ({ ...r, metadata: safeJson(r.metadata, {}) }));
  }

  listTransitions(alertId: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT * FROM alert_transition WHERE alert_id = ? ORDER BY id ASC')
      .all(alertId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...r, payload: r.payload ? safeJson(String(r.payload), null) : null }));
  }

  /**
   * Annunciator counters.
   *
   * `open` deliberately means *in alarm right now* (`status = 'raised'`), not
   * "not yet resolved": a service clears its own alerts constantly (a dish that
   * missed one scan window raises and clears within seconds), so counting every
   * unresolved row would leave the board permanently red. Cleared-but-unresolved
   * alerts are counted separately so the operator can still close them out.
   */
  countAlerts(): {
    open: number;
    critical: number;
    unacknowledged: number;
    cleared: number;
    resolved: number;
    total: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'raised' AND resolved_ts IS NULL) AS open,
           COUNT(*) FILTER (WHERE status = 'raised' AND resolved_ts IS NULL AND severity = 'critical') AS critical,
           COUNT(*) FILTER (WHERE status = 'raised' AND resolved_ts IS NULL AND ack_ts IS NULL) AS unacknowledged,
           COUNT(*) FILTER (WHERE status = 'cleared' AND resolved_ts IS NULL) AS cleared,
           COUNT(*) FILTER (WHERE resolved_ts IS NOT NULL) AS resolved,
           COUNT(*) AS total
         FROM alert`,
      )
      .get() as {
      open: number;
      critical: number;
      unacknowledged: number;
      cleared: number;
      resolved: number;
      total: number;
    };
    return row;
  }

  // ---------------------------------------------------------------- commands

  insertCommand(row: CommandRow): void {
    this.db
      .prepare(
        `INSERT INTO command (command_id, service, entity, control, value, researcher, topic,
           sent_ts, sent_wall_ts, state, progress, reason, detail, settled_ts)
         VALUES (@command_id, @service, @entity, @control, @value, @researcher, @topic,
           @sent_ts, @sent_wall_ts, @state, @progress, @reason, @detail, @settled_ts)`,
      )
      .run({ ...row, value: JSON.stringify(row.value) });
  }

  applyAck(ack: CommandAck, ts: number): { row: CommandRow | null; terminal: boolean } {
    const existing = this.getCommand(ack.command_id);
    this.db
      .prepare(
        `INSERT INTO command_ack (command_id, ts, state, progress, reason, detail, researcher, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ack.command_id,
        ts,
        ack.state ?? null,
        ack.progress ?? null,
        ack.reason ?? null,
        ack.detail ?? null,
        ack.researcher ?? null,
        JSON.stringify(ack),
      );
    if (!existing) return { row: null, terminal: false };
    const terminal = ['completed', 'failed', 'rejected'].includes(ack.state);
    this.db
      .prepare(
        `UPDATE command SET state = ?, progress = COALESCE(?, progress), reason = ?,
           detail = ?, settled_ts = CASE WHEN ? THEN ? ELSE settled_ts END
         WHERE command_id = ?`,
      )
      .run(
        ack.state,
        ack.progress ?? null,
        ack.reason ?? null,
        ack.detail ?? null,
        terminal ? 1 : 0,
        ts,
        ack.command_id,
      );
    return { row: this.getCommand(ack.command_id), terminal };
  }

  getCommand(commandId: string): CommandRow | null {
    const row = this.db.prepare('SELECT * FROM command WHERE command_id = ?').get(commandId) as
      | (CommandRow & { value: string })
      | undefined;
    if (!row) return null;
    return { ...row, value: safeJson(row.value, row.value) };
  }

  listCommands(limit = 50): CommandRow[] {
    const rows = this.db
      .prepare('SELECT * FROM command ORDER BY sent_ts DESC LIMIT ?')
      .all(limit) as Array<CommandRow & { value: string }>;
    return rows.map((r) => ({ ...r, value: safeJson(r.value, r.value) }));
  }

  /** Commands that never received an acknowledgement within the timeout. */
  expireCommands(olderThanWallTs: number): CommandRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM command WHERE settled_ts IS NULL AND state IN ('queued', 'accepted', 'in_progress')
           AND sent_wall_ts < ?`,
      )
      .all(olderThanWallTs) as Array<CommandRow & { value: string }>;
    if (rows.length === 0) return [];
    const upd = this.db.prepare(
      `UPDATE command SET state = 'timeout', reason = 'timeout', settled_ts = ? WHERE command_id = ?`,
    );
    this.db.transaction(() => {
      for (const r of rows) upd.run(Date.now(), r.command_id);
    })();
    return rows.map((r) => ({ ...r, value: safeJson(r.value, r.value) }));
  }

  // -------------------------------------------------------------- researchers

  cacheResearcher(r: ResearcherRecord): void {
    this.db
      .prepare(
        `INSERT INTO researcher (code, name, experiments, status, fetched_ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name, experiments = excluded.experiments,
           status = excluded.status, fetched_ts = excluded.fetched_ts`,
      )
      .run(r.code, r.name, JSON.stringify(r.experiments ?? []), r.status, Date.now());
  }

  cachedResearcher(code: string, ttlMs: number): ResearcherRecord | null {
    const row = this.db.prepare('SELECT * FROM researcher WHERE code = ?').get(code) as
      | { code: string; name: string; experiments: string; status: string; fetched_ts: number }
      | undefined;
    if (!row) return null;
    if (Date.now() - row.fetched_ts > ttlMs) return null;
    return {
      code: row.code,
      name: row.name,
      experiments: safeJson(row.experiments, []),
      status: row.status,
    };
  }

  recordGap(g: GapRow): void {
    this.writeBatch({ telemetry: [], states: [], events: [], gaps: [g] });
  }
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function severityRank(severity: string): number {
  switch (severity) {
    case 'critical':
      return 3;
    case 'warning':
      return 2;
    case 'info':
      return 1;
    default:
      return 0;
  }
}
