/** Shared types for the ARL platform. */

export type FieldType = 'float' | 'integer' | 'bool' | 'string' | 'enum' | 'array' | 'object';

export interface FieldDef {
  key: string;
  type: FieldType;
  unit?: string;
  values?: string[];
}

export interface ValueSchema {
  type: FieldType | 'timestamp';
  unit?: string;
  min?: number;
  max?: number;
  values?: string[];
  fields?: FieldDef[];
}

export interface EntityDef {
  id: string;
  kind: string;
  /** Geo or structural metadata published with the entity (row/col/lat/lon/...). */
  meta: Record<string, unknown>;
}

export interface StreamDef {
  /** Full topic pattern, e.g. arl/rta/+/telemetry/normal. */
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

/** Envelope carried by every telemetry and event payload. */
export interface Envelope {
  v: number;
  ts: number;
  seq: number;
  entity: string;
  [key: string]: unknown;
}

export interface AlertPayload {
  alert_id: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  state: 'raised' | 'cleared';
  value: number | null;
  limit: number | null;
  unit: string | null;
  message: string | null;
  metadata?: Record<string, unknown> | null;
  entity?: string;
  ts?: number;
}

export interface CommandAck {
  command_id: string;
  target?: string;
  control?: string;
  researcher?: string;
  state: 'accepted' | 'rejected' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
  reason?: string | null;
  detail?: string | null;
}

export type AlertStatus = 'raised' | 'cleared';
export type AlertRole = 'service' | 'platform';

export interface AlertRecord {
  alert_id: string;
  service: string;
  entity: string | null;
  type: string;
  severity: 'info' | 'warning' | 'critical';
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
  origin: AlertRole;
  last_ts: number;
  escalate_count: number;
}

export interface ResearcherRecord {
  code: string;
  name: string;
  experiments: string[];
  status: 'active' | 'defunct' | string;
}

export interface VerifyResult {
  valid: boolean;
  reason: string | null;
  researcher?: ResearcherRecord;
}
