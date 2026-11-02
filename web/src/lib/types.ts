/**
 * The wire contract.
 *
 * These types are deliberately a hand-written mirror of `server/src/types.ts`
 * rather than a shared package: the two halves are deployed together, but the
 * browser only ever sees a subset, and duplicating a dozen interfaces is cheaper
 * than teaching the bundler about the server's `better-sqlite3` dependency.
 *
 * If a field is added server-side and forgotten here, TypeScript stays quiet at
 * the boundary - so the decoder in `live.ts` is the place that actually validates.
 */

export type Severity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'raised' | 'cleared';
export type FieldType =
  | 'float'
  | 'integer'
  | 'bool'
  | 'string'
  | 'enum'
  | 'array'
  | 'object'
  | 'timestamp';

export interface FieldDef {
  key: string;
  type: FieldType;
  unit?: string;
  values?: string[];
}

export interface ValueSchema {
  type: FieldType;
  unit?: string;
  min?: number;
  max?: number;
  values?: string[];
  fields?: FieldDef[];
}

export interface EntityDef {
  id: string;
  kind: string;
  meta: Record<string, unknown>;
}

export interface StreamDef {
  topic: string;
  stream: string;
  entityKinds: string[];
  periodS?: number;
  fields: FieldDef[];
}

export interface StateDef {
  topic: string;
  entity: string;
  item: string;
  type: FieldType;
  unit?: string;
}

export interface EventDef {
  topic: string;
  kind: string;
}

export interface ControlDef {
  topic: string;
  control: string;
  entityKinds: string[];
  value: ValueSchema;
}

export interface Topology {
  service: string;
  version: string;
  entities: EntityDef[];
  streams: StreamDef[];
  states: StateDef[];
  events: EventDef[];
  controls: ControlDef[];
}

export interface StateRow {
  entity: string;
  item: string;
  ts: number;
  value: unknown;
}

export interface AlertRecord {
  alert_id: string;
  service: string;
  entity: string | null;
  type: string;
  severity: Severity;
  status: AlertStatus;
  value: number | null;
  unit: string | null;
  limit_value: number | null;
  message: string | null;
  metadata: Record<string, unknown>;
  raised_ts: number;
  cleared_ts: number | null;
  ack_ts: number | null;
  ack_by: string | null;
  ack_note: string | null;
  resolved_ts: number | null;
  resolved_by: string | null;
  resolution: string | null;
  cause: string | null;
  origin: 'service' | 'platform';
  last_ts: number;
  escalate_count: number;
}

export interface AlertCounts {
  open: number;
  critical: number;
  unacknowledged: number;
  cleared: number;
  resolved: number;
  total: number;
}

export interface AlertTransition {
  id: number;
  alert_id: string;
  ts: number;
  wall_ts: number;
  action: string;
  actor: string | null;
  note: string | null;
  payload: unknown;
}

export type CommandState =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'timeout';

export interface CommandRow {
  command_id: string;
  service: string;
  entity: string;
  control: string;
  /**
   * Anything the control schema allows: a number, a bool, an enum string, or the
   * object a `set_target` command carries. The store serialises it as JSON, so it
   * arrives decoded, not as text.
   */
  value: unknown;
  researcher: string;
  researcher_name?: string | null;
  state: CommandState;
  reason: string | null;
  detail: string | null;
  sent_ts: number;
  ack_ts: number | null;
  completed_ts: number | null;
  topic: string;
}

export interface CommandAckRow {
  id: number;
  command_id: string;
  state: string;
  progress: number | null;
  reason: string | null;
  detail: string | null;
  ts: number | null;
  wall_ts: number;
  raw: unknown;
}

export interface Target {
  id: string;
  name: string;
  ra_rad: number;
  dec_rad: number;
  fov_rad: number;
  category: string;
}

export interface Researcher {
  code: string;
  name: string;
  experiments: string[];
  status: string;
}

/** One point on a chart. `ts` is *simulator* time, consistently across the app. */
export interface Sample {
  ts: number;
  data: Record<string, unknown>;
}

export type PlatformEvent =
  | {
      kind: 'telemetry';
      service: string;
      entity: string;
      stream: string;
      ts: number;
      seq: number | null;
      backfill: boolean;
      data: Record<string, unknown>;
    }
  | { kind: 'state'; service: string; entity: string; item: string; ts: number; value: unknown }
  | { kind: 'event'; service: string; name: string; ts: number; payload: Record<string, unknown> }
  | { kind: 'alert'; alert: AlertRecord; change: string }
  | { kind: 'command'; command: CommandRow | null; ack?: Record<string, unknown> }
  | { kind: 'topology'; service: string; version: string }
  | {
      kind: 'service';
      service: string;
      online: boolean | null;
      lastRecvTs: number | null;
      lastMsgTs: number | null;
    }
  | { kind: 'broker'; connected: boolean; detail?: string }
  | { kind: 'ingest'; dropped: number; gaps: number; lastRecvTs: number };

/** One row of `GET /api/alert-limits/:service`, as the ARL API publishes it. */
export interface AlertLimit {
  key: string;
  value: number;
  unit: string | null;
}

export interface ReplaySnapshot {
  id: string;
  services: string[];
  from: number;
  to: number;
  speed: number;
  cursor: number;
  status: 'playing' | 'paused' | 'ended' | 'stopped';
  progress: number;
  emitted: number;
  rows: number;
}

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
  | { kind: 'event'; service: string; name: string; ts: number; payload: Record<string, unknown> };

export interface ServiceSnapshot {
  code: string;
  version: string | null;
  online: boolean | null;
  lastMsgTs: number | null;
  lastRecvTs: number | null;
  topology: Topology | null;
  states: StateRow[];
}

export interface HelloFrame {
  type: 'hello';
  simNow: number | null;
  simulated: boolean;
  services: ServiceSnapshot[];
  alerts: AlertRecord[];
  commands: CommandRow[];
  counts: AlertCounts;
  replay: ReplaySnapshot[];
}

export interface FramesFrame {
  type: 'frames';
  t: number;
  frames: PlatformEvent[];
}

/** Verdicts are the server's, not the panel's: one measure, one judgement. */
export type MeasureVerdict = 'ok' | 'warn' | 'crit' | 'unknown';

export interface DerivedMeasure {
  key: string;
  label: string;
  question: string;
  unit: string | null;
  value: number | null;
  verdict: MeasureVerdict;
  /** The samples the value came from, so a reader can check the arithmetic. */
  inputs: Record<string, number | string | null>;
  reason?: string;
}

export interface DerivedReport {
  service: string;
  /** Newest simulator timestamp among the inputs; null when nothing has been stored. */
  ts: number | null;
  measures: DerivedMeasure[];
}

export interface DerivedResponse {
  at: number | null;
  services: DerivedReport[];
}
