# 03 — MQTT Ingest

**Component.** The subscriber that turns broker traffic into platform events and persisted
rows. This is the data plane's front door and the component the Architecture rubric looks at
when it asks about "the data rates and failures with reasoned decisions".

**Owner files.** `server/src/mqtt/ingest.ts`.

**Rubric.** Architecture 5 % (batching, reconnection, back pressure); Data 30 % (nothing is
lost at elevated speedup).

**Depends on.** `01` (bus, clock), `02` (routing), `04` (batch write), `05` (gap alerts).

---

## 1. Boundary

In scope: connecting, subscribing, parsing each message once, classifying it, tracking
sequence numbers, holding orphans, batching, flushing, publishing commands. Out of scope:
deciding what a message *means* for a service (`11`) and what an alert *is* (`05`).

---

## 2. Current foundation

- Five subscriptions, QoS 1: `arl/+/$topology`, `arl/+/+/telemetry/+`, `arl/+/+/state/+`,
  `arl/+/events/+`, `arl/+/ack/+`.
- Reconnect every 2 s; `queueQoSZero: false`; commands reject with `broker_unavailable` when
  not connected.
- Topology handled before registry lookup; unmatched messages held in an orphan buffer capped
  at 5000 and drained when the topology arrives.
- State de-duplicated against a `lastState` map (identical payloads dropped before writing).
- `seq` tracked per `service/stream`; discontinuities produce a `GapRow` and an `ingest_gap`
  alert.
- Envelope keys stripped into `data`; batch flush at `TELEMETRY_BATCH_ROWS` (1000) or after
  `TELEMETRY_BATCH_MS` (250).
- `publishCommand(topic, envelope)` for the control plane.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| No distinction between "message had `null` fields" and "message had no such field" | Charts treat missing as absent, `null` as absent too — correct — but tables cannot say "could not be measured" | Keep `null` in `data` and let the client render `—`; assert in a test |
| Orphan buffer is per-process and unordered | A flood before topology can evict the *oldest* useful sample | Sort the drain by `ts`, cap per service, log evictions |
| `seq` is tracked only per stream, not per `(entity, stream)` | Two dishes interleaving never trip a gap, but a single topic stream restarts would | Track per concrete topic; that is what the spec means by "per-topic sequence number" |
| No back-pressure signal to the broker | At sustained overload the client queue grows unbounded | Pause the subscription (`client.pause()`) when the pending batch exceeds a high-water mark; resume below the low-water mark |
| Retained `state/online` false is not distinguished from silence | Both eventually raise `service_offline`, but the *cause* differs | Record `reason: 'will' \| 'silent'` on the alert |
| No metric for messages/sec per service | Cannot answer "is RTA scanning right now?" from the platform | Maintain a 60 s EWMA per service and expose it |
| `events` payloads are stored whole including the alert object | Fine, but alert events also need the alert path; duplicated logic | Hand `alert` events to `05` first, then persist the raw event |

---

## 4. Decomposition

### 4.1 Connection subsystem

#### 4.1.1 Client configuration

- **Responsibility.** One client, correct options, no surprises.
- **Contract.** `mqtt.connect({ host, port, username, password, clientId, clean: false,
  reconnectPeriod: 2000, connectTimeout: 10000, queueQoSZero: false, protocolVersion: 4 })`.
- **Steps.** `clean: false` with a stable `clientId` (`arl-platform-<hostname>-<pid>` would
  change every restart; prefer `arl-platform-<hostname>` and accept that only one instance
  runs per host). Log the resolved broker address without credentials.
- **Acceptance.** Starting two platform instances on one host produces a visible takeover
  log line rather than silent message splitting.

#### 4.1.2 Connect / reconnect lifecycle

- **Responsibility.** Make an outage visible and survivable.
- **Contract.** On `connect`: log, set `brokerOnline = true`, clear the `broker_disconnected`
  platform alert, re-subscribe (idempotent), and request a full retained replay by
  re-subscribing to `arl/+/$topology` and `arl/+/+/state/+` (retained messages are delivered
  on subscribe).
- **Steps.** On `close`/`offline`: `brokerOnline = false`, raise `broker_disconnected`, emit a
  bus `broker` event. Do not clear the orphan buffer. Do not flush a partial batch more
  often than the normal timer.
- **Acceptance.** Stopping the broker mid-scan: header LED red within 3 s, an alert appears,
  no rows are written from stale data, and restarting the broker restores LED and clears the
  alert without operator action.

#### 4.1.3 Subscription management

- **Responsibility.** Subscribe once per connection, never per service.
- **Contract.** `SUBSCRIPTIONS` constant; re-subscribe on every `connect`.
- **Steps.** Assert at boot that no subscription contains a wildcard in the service segment
  (`arl/+/...`) and that none is service-specific.
- **Acceptance.** Adding a fourth service requires zero changes to this file.

### 4.2 Classification subsystem

#### 4.2.1 Topic router

- **Responsibility.** Map a topic to (kind, service, entity, stream/item/kind).
- **Contract.** Pure function `classify(topic)`; no I/O; unit-testable in isolation.
- **Steps.** Split on `/`. Segment 0 must be `arl`. Segment 1 is the service. Then:
  - `$topology` at index 2 → topology.
  - `[2]=<entity>, [3]=telemetry, [4]=<stream>` → telemetry.
  - `[2]=<entity>, [3]=state, [4]=<item>` → state.
  - `[2]=events, [3]=<kind>` → event.
  - `[2]=ack, [3]=<command_id>` → ack.
  - Anything else → `unknown`, logged once per shape.
- **Acceptance.** Table-driven test over 20 topics including malformed ones
  (`arl/rta`, `arl/rta/dish-001/telemetry`, `x/rta/events/alert`).

#### 4.2.2 Payload decode

- **Responsibility.** Parse JSON once and split envelope from measurements.
- **Contract.**
  ```ts
  interface Decoded {
    v: number; ts: number; seq: number | null; entity: string | null;
    data: Record<string, unknown>;   // everything else, nulls preserved
    raw: Record<string, unknown>;
  }
  ```
- **Steps.** Reject non-JSON with a counted `malformed` counter and one log line per 100
  occurrences. Reject a payload missing `ts` (it cannot be ordered). Accept a payload missing
  `seq` (state messages have none). Never coerce `null` to `0`. Copy `null` through into
  `data`.
- **Acceptance.** A scan sample with `pointing_offset_ra_rad: null` is stored as JSON `null`
  and read back as `null`; the image builder skips it.

#### 4.2.3 Backfill marking

- **Responsibility.** Distinguish a live sample from one that the platform received far
  after its `ts` (e.g. after a reconnect, a retained-message burst, or an LWM-style backfill).
- **Contract.** `backfill = (recvTs - ts) > 5000 || recvTs < lastRecvTsForService`.
- **Steps.** Persist `backfill` on the row (already in schema). Replay includes backfilled
  rows ordered by `ts`; the ingestion-health view excludes them; `service_silent` uses
  wall-clock receive time only.
- **Acceptance.** Reconnecting after 30 s of downtime marks the burst as `backfill = 1` and
  does not raise `service_silent`.

### 4.3 Sequencing subsystem

#### 4.3.1 Gap detection

- **Responsibility.** Record, never hide, missing messages.
- **Contract.** `Map<topic, expectedSeq>`; on arrival, if `seq > expected`, emit a `GapRow`
  `{ service, entity, stream, topic, expectedSeq, gotSeq, missed }` and call
  `alertEngine.ingestGap(row)`. If `seq <= expected` (duplicate or restart), and `seq === 1`
  or `seq < expected - 1000`, treat as a service restart and reset `expected` silently with a
  log line.
- **Steps.** Ordering: gaps are detected before the row is queued for writing, so the gap is
  persisted in the same batch.
- **Acceptance.** Dropping one telemetry message at the broker produces exactly one gap row,
  one `ingest_gap` alert, and the footer gap counter increments by one.

#### 4.3.2 State de-duplication

- **Responsibility.** Retained state is re-published frequently with identical values; storing
  every repeat would bloat the table and the replay stream.
- **Contract.** Key `service|entity|item`; compare `value` structurally. Drop when equal.
  Always keep a change of type (`0` vs `"0"`) and a change from `null` to a value.
- **Steps.** Compare with a stable serialiser (sorted keys), not `JSON.stringify` of the raw
  object, so key order does not create false changes.
- **Acceptance.** A retained `state/target` republished 10 times with the same object writes
  one row.

#### 4.3.3 Orphan handling

- **Responsibility.** Telemetry can arrive before `$topology` on a cold join.
- **Contract.** `holdOrphans(service, decoded, topic)` with a cap of 5000 total and 1000 per
  service; on topology arrival, drain in `ts` order.
- **Steps.** Count and log evictions. Emit a bus event after the drain so the UI does not
  render a half-populated service.
- **Acceptance.** Starting the platform after the services produces `hello` with devices
  populated, and the log contains no `no topology` warnings after the first second.

### 4.4 Batching subsystem

#### 4.4.1 Write planner

- **Responsibility.** Turn a stream of decoded messages into one transaction every ≤ 250 ms.
- **Contract.** Four in-memory arrays (`telemetry`, `states`, `events`, `gaps`) plus dirty
  service ids. `scheduleFlush()` flushes immediately at the row cap, otherwise arms a timer.
- **Steps.** Cap each array independently so one chatty service cannot starve the others.
  Merge duplicate gaps for the same topic within a batch into one row with the summed `missed`.
- **Acceptance.** At 90 messages/s (RTA scanning with 90 dishes) a batch contains ~22 rows and
  writes in under 10 ms.

#### 4.4.2 Back pressure

- **Responsibility.** Survive a sustained burst (speedup 50 on RTA, or a retained storm after
  reconnect) without losing data or exhausting memory.
- **Contract.** High-water mark 20 000 pending rows → `client.pause()`; low-water 5 000 →
  `client.resume()`. Emit `ingest` events with `{ paused: true }` so the header can show it.
- **Steps.** Measure with `pendingRows()`. Never drop rows silently; if the hard cap
  (`MQTT_QUEUE_LIMIT`, default 50 000) is reached, log and count `dropped` and let the
  broker's QoS 1 redelivery recover on reconnect.
- **Acceptance.** With `ARL_SPEEDUP=50` on RTA the platform pauses and resumes at least once
  and reports zero `dropped`.

#### 4.4.3 Flush

- **Responsibility.** One transaction, all four row types, plus service liveness.
- **Contract.** `store.writeBatch({ telemetry, states, events, gaps })`; then
  `touchService()` for every service present, then clear the arrays only on success.
- **Steps.** On a write error, keep the arrays and retry once after 100 ms; on a second
  failure, log and drop the batch with a counted `writeFailures`. Never reorder the arrays.
- **Acceptance.** Killing the process between two flushes loses at most `TELEMETRY_BATCH_MS`
  of data; `04`'s transaction guarantee means no half-batch is ever visible.

### 4.5 Command publication subsystem

#### 4.5.1 Publisher

- **Responsibility.** Publish exactly the documented command payload.
- **Contract.** `publishCommand(topic, { command_id, researcher, value })` returns a promise
  resolving on QoS 1 ack, rejecting with `broker_unavailable` when disconnected.
- **Steps.** `qos: 1`, `retain: false`. Never publish a command to a topic the registry does
  not recognise as a control (guard in `06`, not here). Log the command id and control, not
  the researcher's code.
- **Acceptance.** With the broker down, `POST /api/commands` returns 503 and no row is left
  in `sent` state (see `06`).

---

## 5. Data contracts

```ts
type Classified =
  | { kind: 'topology'; service: string }
  | { kind: 'telemetry'; service: string; entity: string; stream: string }
  | { kind: 'state';       service: string; entity: string; item: string }
  | { kind: 'event';       service: string; kindName: string }
  | { kind: 'ack';         service: string; commandId: string }
  | { kind: 'unknown';     topic: string };
```

Row shapes are owned by `04` (`TelemetryRow`, `StateRow`, `EventRow`, `GapRow`).

---

## 6. Failure modes

| Failure | Detected by | Behaviour |
| :--- | :--- | :--- |
| Broker unreachable at boot | No `connect` within 10 s | `degraded`, retry forever, no exit |
| Broker dies mid-run | `close` event | `broker_disconnected` alert, LED red, keep writing nothing |
| Retained storm after reconnect | Pending rows > high-water | Pause, drain, resume; mark burst `backfill` |
| Malformed JSON | Parse error | Count `malformed`, log sampled, drop that message only |
| Unknown topic shape | `classify` → unknown | Count, log once per shape, drop |
| `seq` restart (service restarted) | `seq` far below expected | Reset silently with a log, no gap alert |
| SQLite busy | `writeBatch` throws SQLITE_BUSY | Retry once at 100 ms, then count `writeFailures` |
| Command publish fails | QoS 1 ack timeout | Reject to the caller; `06` marks the command failed |

---

## 7. Test plan

- Unit `classify`: table of 20 topics.
- Unit `decodePayload`: nulls preserved, missing `ts` rejected, non-JSON rejected.
- Unit gap logic: sequence 1,2,5 → one gap of 2; 1,1,2 → no gap; 10,1,2 → reset.
- Unit state de-dup: key-order permutation is not a change.
- Integration against a real broker in a container: publish 200 synthetic telemetry messages,
  assert 200 rows, 0 gaps; drop 1, assert 1 gap.
- Load: 90 msg/s for 30 s, assert `dropped = 0` and flush p95 < 25 ms.

---

## 8. Open decisions

- **Per-topic vs per-stream `seq` tracking.** Per-topic, because the spec says "per-topic
  sequence number" and per-stream hides single-dish drops.
- **Pause vs throttle.** Pause the subscription. Throttling inside the client would still
  buffer in memory and hide the overload from the broker.