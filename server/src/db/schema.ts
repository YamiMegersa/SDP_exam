/** SQLite schema for the platform store. Applied idempotently at start-up. */
export const SCHEMA_SQL = `/**
 * Schema for the platform's own store.
 *
 * Two clocks are kept on purpose: \`ts\` is the simulator's time (envelope \`ts\`) and is the clock used
 * for charting, ordering and replay; \`recv_ts\`/\`wall_ts\` is the platform's local receive time and is
 * only used for ingestion health. With ARL_SPEEDUP the two diverge, and LWM/MHE backfill replays old
 * samples after an outage, so wall clock cannot order history.
 */

CREATE TABLE IF NOT EXISTS service (
  code            TEXT PRIMARY KEY,
  version         TEXT,
  topology_json   TEXT,
  topology_ts     INTEGER,
  online          INTEGER NOT NULL DEFAULT 0,
  last_msg_ts     INTEGER,
  last_recv_ts    INTEGER,
  first_seen_ts   INTEGER
);

CREATE TABLE IF NOT EXISTS entity (
  service   TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  meta      TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (service, entity_id)
);

CREATE TABLE IF NOT EXISTS telemetry (
  id        INTEGER PRIMARY KEY,
  service   TEXT NOT NULL,
  entity    TEXT NOT NULL,
  stream    TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  seq       INTEGER,
  recv_ts   INTEGER NOT NULL,
  backfill  INTEGER NOT NULL DEFAULT 0,
  data      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tel_entity_ts ON telemetry(service, entity, stream, ts);
CREATE INDEX IF NOT EXISTS idx_tel_stream_ts ON telemetry(service, stream, ts);
CREATE INDEX IF NOT EXISTS idx_tel_ts ON telemetry(ts);
CREATE INDEX IF NOT EXISTS idx_tel_scan ON telemetry(service, stream, ts, entity);

CREATE TABLE IF NOT EXISTS state_change (
  id      INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  entity  TEXT NOT NULL,
  item    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  seq     INTEGER,
  recv_ts INTEGER NOT NULL,
  value   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_state_entity_ts ON state_change(service, entity, item, ts);
CREATE INDEX IF NOT EXISTS idx_state_ts ON state_change(ts);

CREATE TABLE IF NOT EXISTS event (
  id      INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  entity  TEXT,
  kind    TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  seq     INTEGER,
  recv_ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_service_ts ON event(service, ts);
CREATE INDEX IF NOT EXISTS idx_event_kind_ts ON event(service, kind, ts);

CREATE TABLE IF NOT EXISTS alert (
  alert_id      TEXT PRIMARY KEY,
  service       TEXT NOT NULL,
  entity        TEXT,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL,
  status        TEXT NOT NULL,
  value         REAL,
  unit          TEXT,
  limit_value   REAL,
  message       TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  raised_ts     INTEGER NOT NULL,
  cleared_ts    INTEGER,
  ack_ts        INTEGER,
  ack_by        TEXT,
  ack_note      TEXT,
  resolved_ts   INTEGER,
  resolved_by   TEXT,
  resolution    TEXT,
  cause         TEXT,
  origin        TEXT NOT NULL DEFAULT 'service',
  last_ts       INTEGER NOT NULL,
  escalate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_status ON alert(status, raised_ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_service ON alert(service, raised_ts DESC);
CREATE INDEX IF NOT EXISTS idx_alert_raised ON alert(raised_ts);

CREATE TABLE IF NOT EXISTS alert_transition (
  id          INTEGER PRIMARY KEY,
  alert_id    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  wall_ts     INTEGER NOT NULL,
  action      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,
  note        TEXT,
  payload     TEXT
);
CREATE INDEX IF NOT EXISTS idx_transition_alert ON alert_transition(alert_id, id);

CREATE TABLE IF NOT EXISTS command (
  command_id   TEXT PRIMARY KEY,
  service      TEXT NOT NULL,
  entity       TEXT NOT NULL,
  control      TEXT NOT NULL,
  value        TEXT NOT NULL,
  researcher   TEXT NOT NULL,
  topic        TEXT NOT NULL,
  sent_ts      INTEGER NOT NULL,
  sent_wall_ts INTEGER NOT NULL,
  state        TEXT NOT NULL,
  progress     REAL,
  reason       TEXT,
  detail       TEXT,
  settled_ts   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_command_sent ON command(sent_ts DESC);
CREATE INDEX IF NOT EXISTS idx_command_state ON command(state);

CREATE TABLE IF NOT EXISTS command_ack (
  id         INTEGER PRIMARY KEY,
  command_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  state      TEXT,
  progress   REAL,
  reason     TEXT,
  detail     TEXT,
  researcher TEXT,
  raw        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ack_command ON command_ack(command_id, id);

CREATE TABLE IF NOT EXISTS ingest_gap (
  id           INTEGER PRIMARY KEY,
  service      TEXT NOT NULL,
  entity       TEXT,
  stream       TEXT,
  topic        TEXT,
  expected_seq INTEGER,
  received_seq INTEGER,
  missed       INTEGER NOT NULL,
  ts           INTEGER,
  wall_ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gap_wall ON ingest_gap(wall_ts);

CREATE TABLE IF NOT EXISTS researcher (
  code       TEXT PRIMARY KEY,
  name       TEXT,
  experiments TEXT NOT NULL DEFAULT '[]',
  status     TEXT,
  fetched_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
