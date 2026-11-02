# 04 — Persistence Store

**Component.** The SQLite layer: schema, transactional batch writer, alert and command
state, and the query surface that both REST and replay read from. This is where the Data
rubric criterion is actually satisfied — *"all data is captured and persisted"*.

**Owner files.** `server/src/db/schema.ts`, `server/src/db/store.ts`, `server/src/db/queries.ts`,
`data/arl.sqlite`.

**Rubric.** Data 30 % (persistence at speedup); Replay 10 % (the platform's own captured
data); Architecture 5 % (persistence layer reused across services).

**Depends on.** `01`, `02`.

---

## 1. Boundary

In scope: DDL, migrations, batched writes, alert/command/researcher state, read queries,
retention. Out of scope: parsing (`03`), deciding alert semantics (`05`), HTTP shaping (`08`).

---

## 2. Current foundation

WAL, `synchronous = NORMAL`, `busy_timeout`. Tables: `service`, `entity`, `telemetry`,
`state_change`, `event`, `alert`, `alert_transition`, `command`, `command_ack`, `ingest_gap`,
`researcher`, `meta`. `telemetry` has four indexes. `writeBatch` writes all four row types in
one transaction. `applyAlertEvent` keeps a stable `alert_id` across escalation and records a
cleared-without-raised case. `acknowledgeAlert` returns 409 when resolved or already
acknowledged; `resolveAlert` requires prior acknowledgement. `expire()` settles commands
after 45 s. `series()` clamps the limit to 10–20 000 and strides with `id % stride = 0` when
over the limit.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| No migration runner; schema is `CREATE TABLE IF NOT EXISTS` | A changed column needs a manual DB delete | Add a `meta.schema_version` and ordered migrations |
| `series()` cannot aggregate across entities | The Data 100 % band wants derived measures over the array, not one dish | Add `/api/aggregate` and a rollup table |
| Stride sampling (`id % n = 0`) biases toward message order, not time | A burst of 1000 rows in one second dominates the chart | Stride over the ordered window by time buckets |
| No retention job by default (`TELEMETRY_RETENTION_H=0`) | Hour-6 database is large and replay `HARD_ROW_LIMIT` starts rejecting | Enable a default 26 h window for RTA scan data only |
| `alert` has no index on `(service, status, raised_ts)` | Alert list is a scan once there are thousands | Add the index |
| No stored derived values for expensive rollups | Every OPG energy-balance view recomputes | Add `rollup` table written by `11` |
| `state_change` grows without bound on chatty state | RTA `commanded` updates every 10 s per dish while tracking | Enable de-dup already present; add a retention rule |

---

## 4. Decomposition

### 4.1 Schema subsystem

#### 4.1.1 Base tables (as they stand)

Keep these; they are correct for the exam.

| Table | Purpose | Key indexes |
| :--- | :--- | :--- |
| `service` | version, topology JSON, online, last message ts, first seen | PK `service` |
| `entity` | id, kind, meta JSON | PK `(service, entity)` |
| `telemetry` | service, entity, stream, ts, seq, recv_ts, backfill, data JSON | `(service, stream, ts)`, `(service, entity, ts)`, `ts`, `(service, ts)` |
| `state_change` | service, entity, item, ts, seq, recv_ts, value | `(service, entity, item, ts)` |
| `event` | service, entity, kind, ts, seq, recv_ts, payload | `(service, kind, ts)`, `ts` |
| `alert` | full lifecycle + ack/resolve actors and text | add `(service, status, raised_ts)` |
| `alert_transition` | append-only audit | `(alert_id, ts)` |
| `command` / `command_ack` | dispatch and acks | `(service, sent_ts)`, `(command_id)` |
| `ingest_gap` | topic, expected/got/missed | `(service, ts)` |
| `researcher` | cached code → record | PK `code` |
| `meta` | key/value | PK `key` |

#### 4.1.2 Migration runner

- **Responsibility.** Let the schema evolve without deleting `data/arl.sqlite`.
- **Contract.** `meta.schema_version` integer. `migrations: { version, up(db) }[]`. At boot,
  apply every migration with `version > current` inside one transaction per migration, then
  set the version.
- **Steps.** Migration 1 = the current baseline (so an existing DB is adopted with no change).
  Migration 2 = the new indexes. Migration 3 = the `rollup` table. Migration 4 = the
  `alert_context` columns (see `05`).
- **Acceptance.** Starting with a pre-existing DB from today's foundation does not lose a
  row and reports `schema_version 1 → 4` once, then nothing on the next start.

#### 4.1.3 Rollup table

- **Responsibility.** Pre-aggregate the measures that the console asks for repeatedly.
- **Contract.**
  ```sql
  CREATE TABLE rollup (
    service TEXT NOT NULL, measure TEXT NOT NULL,
    bucket_ms INTEGER NOT NULL,          -- aligned to 30 s
    entity TEXT NOT NULL,                -- '*' for service-wide
    value REAL, n INTEGER, min REAL, max REAL,
    PRIMARY KEY (service, measure, bucket_ms, entity)
  );
  ```
- **Steps.** Written by `11` from the bus (not by ingest). Upsert per bucket. Retained for
  the same window as telemetry.
- **Acceptance.** OPG energy balance over 6 h answers in < 40 ms from `rollup` versus > 2 s
  from raw telemetry.

### 4.2 Write subsystem

#### 4.2.1 Batch transaction

- **Responsibility.** All-or-nothing writes with prepared statements.
- **Contract.** `writeBatch({ telemetry, states, events, gaps }): { written: number }`.
- **Steps.** Prepare statements once per connection and reuse. Use one `BEGIN IMMEDIATE` /
  `COMMIT`. On any error, `ROLLBACK` and rethrow so `03` can retry. Insert `data` with
  `JSON.stringify`; do not attempt to flatten.
- **Acceptance.** Injecting a constraint violation on row 500 of 1000 leaves the table
  unchanged.

#### 4.2.2 Alert lifecycle writes

- **Responsibility.** Persist the lifecycle exactly as the service published it, plus what
  the platform did.
- **Contract.** `applyAlertEvent(record)` — stable `alert_id`; a re-raise of an existing id
  updates severity and increments `escalate_count`; a `cleared` for an unseen id inserts a
  row already cleared (the platform joined late) and appends a transition noting that.
- **Steps.** Every mutation appends an `alert_transition` row with `ts`, `action`, `actor`,
  `note`. Never delete an alert.
- **Acceptance.** Raise → escalate → clear → ack → resolve produces 5 transitions with
  monotonic timestamps and correct actors.

#### 4.2.3 Command lifecycle writes

- **Responsibility.** Track dispatch to settlement.
- **Contract.** Insert on dispatch (`sent_ts`, `sent_wall_ts`, state `pending`); `applyAck()`
  updates state/progress/reason/detail and sets `settled_ts` on a terminal state;
  `expire(now)` settles rows still `pending`/`in_progress` after 45 s as `timeout`.
- **Steps.** Terminal states: `completed`, `rejected`, `failed`, `timeout`. `expired`
  commands must also be visible in the audit trail, so append a synthetic ack row with
  `reason: 'no_ack'`.
- **Acceptance.** A command to a stopped service appears as `timeout` after 45 s with a
  synthetic ack, and the console shows it.

### 4.3 Query subsystem

#### 4.3.1 Series

- **Responsibility.** Give the client a bounded number of points for one measure.
- **Contract.** `series({ service, stream, entity?, field?, from, to, limit })` →
  `{ rows: {ts, data}[], total, stride }`.
- **Steps.** Replace `id % stride` with **time-bucket stride**: compute
  `bucketMs = ceil((to - from) / limit)`, then `GROUP BY (ts / bucketMs)` taking
  `AVG(numeric field)` and `MAX(ts)`. Return the bucket mean so a chart shows the shape, not a
  sample of it.
- **Acceptance.** A 6 h window at limit 400 returns ≤ 400 points, evenly spread, and the
  plotted maximum matches the true maximum within one bucket.

#### 4.3.2 Aggregate

- **Responsibility.** One number per bucket across many entities — the basis of every
  "array-wide" chart.
- **Contract.** `aggregate({ service, stream, field, from, to, bucketMs, agg: 'avg'|'min'|'max'|'sum'|'count'|'p95' })`.
- **Steps.** Prefer `rollup` when `bucketMs` is a multiple of 30 s and the measure is
  registered; otherwise scan `telemetry` with an index on `(service, stream, ts)`.
  Implement `p95` only on the raw path (SQLite has no percentile).
- **Acceptance.** RTA "mean dish temperature over the last hour" returns 120 buckets of one
  number, and the endpoint answers in < 80 ms.

#### 4.3.3 Latest state and range

- **Responsibility.** Correct current values for a late joiner, and the capture window for
  replay.
- **Contract.** `latestStates(service, kind?)` — latest id per `(entity, item)`;
  `timeRange(services)` → per-service `{ firstTs, lastTs, telemetry, states, events }`.
- **Steps.** `timeRange` must use the index on `ts` and must exclude `backfill` outliers that
  are far older than the main window? **No** — include them, because replay must be
  faithful. Instead return `trueFirstTs` alongside `firstTs` so the UI can default to the
  meaningful window.
- **Acceptance.** With RTA backfilled 10 minutes, `/api/range` reports both.

#### 4.3.4 Replay chunk reader

- **Responsibility.** The keyset pagination that `07` uses.
- **Contract.** `replayChunk({ services, from, to, afterKey, limit })` merging
  `telemetry`, `state_change` and `event` ordered by `(ts, id)`, returning a single ordered
  array with a `kind` discriminator.
- **Steps.** Three separate indexed queries with `LIMIT`, then a k-way merge in JS (three
  cursors), so SQLite never sorts a large union. Keyset on `(ts, id)` so a slow tick does not
  re-scan.
- **Acceptance.** A 10-minute window with 100 000 RTA scan rows pages in 500-row chunks with
  strictly increasing `(ts, id)` and no duplicates.

### 4.4 Retention subsystem

#### 4.4.1 Policy

- **Responsibility.** Keep the database small enough that replay never hits the row limit,
  without losing the window the exam needs.
- **Contract.** Default: keep everything for 26 h; beyond that, keep `state_change`, `event`,
  `alert`, `command` indefinitely (they are small) and delete `telemetry` older than the
  window, one day at a time, in a transaction with a row cap of 50 000 per sweep.
- **Steps.** Run every 5 minutes when `TELEMETRY_RETENTION_H > 0`; log the deleted count.
  Never delete rows inside the replay window of an active session.
- **Acceptance.** With retention 26 h and a 2 000 000-row table, a sweep completes in < 2 s
  and the API stays responsive.

#### 4.4.2 Vacuum policy

- **Responsibility.** Reclaim space without blocking the writer.
- **Steps.** `PRAGMA wal_checkpoint(TRUNCATE)` on shutdown; `incremental_vacuum` never (needs
  the pragma set at creation). Rely on WAL checkpointing.
- **Acceptance.** After a retention sweep the DB file does not grow monotonically across
  restarts.

---

## 5. Data contracts

```ts
interface Store {
  // writes
  writeBatch(batch: Batch): { written: number };
  applyAlertEvent(a: AlertEventInput): AlertRecord;
  setPlatformAlert(input: PlatformAlertInput): AlertRecord;
  acknowledgeAlert(id, { by, note, ts }): AlertRecord;   // throws Conflict
  resolveAlert(id, { by, resolution, cause, ts }): AlertRecord;
  recordGap(gap: GapRow): void;
  // commands
  createCommand(row): void;
  applyAck(ack: CommandAck, recvTs: number): void;
  expire(now: number): number;
  // reads
  listServices(): ServiceRow[];
  listAlerts(filter): AlertRecord[];
  listTransitions(alertId): AlertTransition[];
  series(q): SeriesResult;
  aggregate(q): AggregateResult;
  latestStates(service, kind?): StateRow[];
  timeRange(services): RangeResult;
  replayChunk(q): ReplayMergedRow[];
}
```

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Disk full | Batch throws; `03` retries once; surfaced as `degraded` with `store:false` |
| Corrupt DB | Boot fails with a message naming the file and the recovery command (`33` documents it) |
| Two processes on one DB | WAL allows readers; the writer gets `SQLITE_BUSY` and retries once, then degrades |
| Clock skew writing `recv_ts` backwards | Ordering never depends on `recv_ts`; only health does |
| Replay asked for an empty window | Returns `rows: []`, `total: 0`; the session stays valid |

---

## 7. Test plan

- Migration test: create with v1 DDL, insert rows, migrate to v4, assert row count.
- `writeBatch` atomicity under an injected constraint violation.
- Alert lifecycle: raise/escalate/clear/ack/resolve transition sequence.
- `series` bucket stride: uniform timestamps produce an even chart; a 1000-row burst does not
  dominate.
- `aggregate` accuracy against a hand-computed small fixture.
- `replayChunk` merge: interleaved rows across the three tables stay ordered.
- Retention: rows older than the window disappear, state/event survive.

---

## 8. Open decisions

- **Do we keep `data` as JSON or normalise fields?** Keep JSON. Telemetry shapes differ per
  service and stream; normalising would create 40 columns and still need JSON for arrays.
- **Is the rollup table worth it?** Yes for OPG (1-minute cadence, 3-day balance questions)
  and RTA (array-wide means). It is small and cheap to maintain.